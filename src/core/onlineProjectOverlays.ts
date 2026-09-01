import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { mapMotionWorldToLngLat } from './openFreeMapAdapter';
import { PIN_DEFAULTS, pinLabelOffsetOf, pinSizeOf, pinStyleOf, type Layer } from './project';
import { regionPresentation, resolveFlagCode, revealRegionGeometry } from './regions';
import {
  GeographicRegionFillLayer,
  loadGeographicRegionImage,
  ONLINE_GEOGRAPHIC_REGION_FILL_LAYER_ID,
} from './geographicRegionFillLayer';

export const ONLINE_PROJECT_REGION_SOURCE_ID = 'mapmotion-project-regions';
export const ONLINE_PROJECT_REGION_FILL_LAYER_ID = 'mapmotion-project-region-fills';
export const ONLINE_PROJECT_REGION_PATTERN_LAYER_ID = 'mapmotion-project-region-pattern-fills';
export const ONLINE_PROJECT_REGION_GLOW_LAYER_ID = 'mapmotion-project-region-glow';
export const ONLINE_PROJECT_REGION_STROKE_LAYER_ID = 'mapmotion-project-region-strokes';
export const ONLINE_PROJECT_REGION_SELECTION_LAYER_ID = 'mapmotion-project-region-selection';

export const ONLINE_PROJECT_PIN_SOURCE_ID = 'mapmotion-project-pins';
export const ONLINE_PROJECT_PIN_SELECTION_LAYER_ID = 'mapmotion-project-pin-selection';
export const ONLINE_PROJECT_PIN_LAYER_ID = 'mapmotion-project-pin-icons';
export const ONLINE_PROJECT_PIN_LABEL_LAYER_ID = 'mapmotion-project-pin-labels';
const OVERLAY_METADATA = { 'mapmotion:overlay': true } as const;
const BASE_ICON_SIZE = 48;
const geographicRegionLayers = new WeakMap<MapLibreMap, GeographicRegionFillLayer>();
const FLAG_URLS = import.meta.glob('../../node_modules/flag-icons/flags/4x3/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
export const flagUrl = (code: string | undefined) =>
  code
    ? FLAG_URLS[Object.keys(FLAG_URLS).find((path) => path.endsWith(`/${code.toLowerCase()}.svg`)) ?? '']
    : undefined;
const regionPatternId = (layer: Layer, assetUrls: Readonly<Record<string, string>>) => {
  const mode = layer.regionImageMode ?? 'cover';
  const tileCount = Math.max(1, Math.min(20, Math.round(layer.regionTileCount ?? 4)));
  const flagCode = resolveFlagCode(layer.regionCountryCode, layer.regionCountryCode2);
  if (layer.regionFillMode === 'flag' && flagCode)
    return `mapmotion-region-${layer.id}-flag-${flagCode}-${mode}-${tileCount}`;
  if (layer.regionFillMode === 'image' && layer.regionImageAssetId && assetUrls[layer.regionImageAssetId])
    return `mapmotion-region-${layer.id}-image-${layer.regionImageAssetId}-${mode}-${tileCount}`;
  return '';
};
export const regionGeometryBounds = (geometry: NonNullable<Layer['regionGeometry']>) => {
  const points = (
    geometry.type === 'Polygon' ? geometry.coordinates.flat(1) : geometry.coordinates.flat(2)
  ) as number[][];
  return points.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point[0]),
      minY: Math.min(bounds.minY, point[1]),
      maxX: Math.max(bounds.maxX, point[0]),
      maxY: Math.max(bounds.maxY, point[1]),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
};
export const rasterizeOverlayImage = async (
  url: string,
  mode: Layer['regionImageMode'] = 'tile',
  geometry?: Layer['regionGeometry'],
  tileCount = 4,
) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Overlay image failed: HTTP ${response.status}`);
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    const bounds = geometry ? regionGeometryBounds(geometry) : undefined;
    const boundsAspect = bounds
      ? Math.max(0.2, Math.min(5, (bounds.maxX - bounds.minX) / Math.max(0.001, bounds.maxY - bounds.minY)))
      : 4 / 3;
    const safeTileCount = Math.max(1, Math.min(20, Math.round(tileCount)));
    const width = mode === 'tile' ? Math.max(32, Math.round(768 / safeTileCount)) : 768;
    const height =
      mode === 'tile'
        ? Math.max(24, Math.round((width * image.naturalHeight) / image.naturalWidth))
        : Math.max(154, Math.min(768, Math.round(width / boundsAspect)));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Unable to rasterize Region overlay image.');
    if (mode === 'tile') context.drawImage(image, 0, 0, width, height);
    else {
      const scale =
        mode === 'cover'
          ? Math.max(width / image.naturalWidth, height / image.naturalHeight)
          : Math.min(width / image.naturalWidth, height / image.naturalHeight);
      const drawWidth = image.naturalWidth * scale;
      const drawHeight = image.naturalHeight * scale;
      context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    }
    return context.getImageData(0, 0, width, height);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

export const onlineRegionFeatureCollection = (
  layers: readonly Layer[],
  selectedId: string | null,
  assetUrls: Readonly<Record<string, string>> = {},
) => ({
  type: 'FeatureCollection' as const,
  features: layers
    .filter((layer) => layer.type === 'region' && layer.visible && layer.regionGeometry)
    .flatMap((layer) => {
      const presentation = regionPresentation(layer);
      const base = {
        type: 'Feature' as const,
        id: layer.id,
        geometry: layer.regionGeometry!,
        properties: {
          layerId: layer.id,
          role: 'base',
          patternId: regionPatternId(layer, assetUrls),
          selected: layer.id === selectedId,
          fillColor: layer.regionFillColor ?? layer.color,
          fillOpacity:
            layer.regionFillMode === 'none'
              ? 0
              : layer.opacity * (layer.regionFillOpacity ?? 0.35) * presentation.fillFactor,
          strokeColor: layer.regionStrokeColor ?? '#66b5ff',
          strokeOpacity:
            layer.regionStrokeExists === false
              ? 0
              : layer.regionEffect === 'draw-border' && presentation.drawProgress < 1
                ? 0
                : layer.opacity * (layer.regionStrokeOpacity ?? 0.9) * presentation.strokeFactor,
          strokeWidth: layer.regionStrokeWidth ?? 2,
          glowColor: layer.regionHighlightColor ?? '#ffffff',
          glowOpacity:
            layer.regionAnimationEnabled && layer.regionEffect !== 'fade'
              ? 0.2 * presentation.strokeFactor
              : 0,
        },
      };
      if (layer.regionEffect !== 'draw-border' || presentation.drawProgress >= 1) return [base];
      const trace = {
        ...base,
        id: `${layer.id}:trace`,
        geometry: revealRegionGeometry(layer.regionGeometry!, presentation.drawProgress),
        properties: {
          ...base.properties,
          role: 'trace',
          selected: false,
          fillOpacity: 0,
          strokeColor: layer.regionStrokeColor ?? '#66b5ff',
          strokeOpacity:
            layer.regionStrokeExists === false ? 0 : layer.opacity * (layer.regionStrokeOpacity ?? 0.9),
          strokeWidth: layer.regionStrokeWidth ?? 2,
          glowOpacity: 0.25,
        },
      };
      return [base, trace];
    }),
});

const ensureRegionOverlays = (
  map: MapLibreMap,
  layers: readonly Layer[],
  selectedId: string | null,
  assetUrls: Readonly<Record<string, string>>,
) => {
  const data = onlineRegionFeatureCollection(layers, selectedId, assetUrls);
  const source = map.getSource(ONLINE_PROJECT_REGION_SOURCE_ID) as GeoJSONSource | undefined;
  if (source) source.setData(data);
  else map.addSource(ONLINE_PROJECT_REGION_SOURCE_ID, { type: 'geojson', data });
  if (!map.getLayer(ONLINE_PROJECT_REGION_FILL_LAYER_ID))
    map.addLayer({
      id: ONLINE_PROJECT_REGION_FILL_LAYER_ID,
      type: 'fill',
      source: ONLINE_PROJECT_REGION_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      filter: ['all', ['==', ['get', 'role'], 'base'], ['==', ['get', 'patternId'], '']],
      paint: { 'fill-color': ['get', 'fillColor'], 'fill-opacity': ['get', 'fillOpacity'] },
    });
  let geographicLayer = geographicRegionLayers.get(map);
  if (!geographicLayer) {
    geographicLayer = new GeographicRegionFillLayer();
    geographicRegionLayers.set(map, geographicLayer);
    // Vite HMR can recreate this module while MapLibre retains the prior
    // custom-layer implementation. Replace that detached instance atomically
    // so subsequent updates always target the renderer MapLibre invokes.
    if (map.getLayer(ONLINE_GEOGRAPHIC_REGION_FILL_LAYER_ID))
      map.removeLayer(ONLINE_GEOGRAPHIC_REGION_FILL_LAYER_ID);
  }
  geographicLayer.update(layers, assetUrls, flagUrl);
  if (!map.getLayer(ONLINE_GEOGRAPHIC_REGION_FILL_LAYER_ID)) map.addLayer(geographicLayer);
  if (!map.getLayer(ONLINE_PROJECT_REGION_GLOW_LAYER_ID))
    map.addLayer({
      id: ONLINE_PROJECT_REGION_GLOW_LAYER_ID,
      type: 'line',
      source: ONLINE_PROJECT_REGION_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      filter: ['==', ['get', 'role'], 'trace'],
      paint: {
        'line-color': ['get', 'glowColor'],
        'line-opacity': ['get', 'glowOpacity'],
        'line-width': ['+', ['get', 'strokeWidth'], 5],
        'line-blur': 3,
      },
    });
  if (!map.getLayer(ONLINE_PROJECT_REGION_STROKE_LAYER_ID))
    map.addLayer({
      id: ONLINE_PROJECT_REGION_STROKE_LAYER_ID,
      type: 'line',
      source: ONLINE_PROJECT_REGION_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      filter: ['in', ['get', 'role'], ['literal', ['base', 'trace']]],
      paint: {
        'line-color': ['get', 'strokeColor'],
        'line-opacity': ['get', 'strokeOpacity'],
        'line-width': ['get', 'strokeWidth'],
      },
    });
  if (!map.getLayer(ONLINE_PROJECT_REGION_SELECTION_LAYER_ID))
    map.addLayer({
      id: ONLINE_PROJECT_REGION_SELECTION_LAYER_ID,
      type: 'line',
      source: ONLINE_PROJECT_REGION_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      filter: ['all', ['==', ['get', 'role'], 'base'], ['==', ['get', 'selected'], true]],
      paint: { 'line-color': '#7fd4ff', 'line-opacity': 0.45, 'line-width': 2 },
    });
  return data.features.length;
};
export const ONLINE_PIN_VISUAL_SCALE_STOPS = [
  [0, 0.45],
  [4, 0.58],
  [8, 0.76],
  [12, 0.92],
  [15, 1],
  [22, 1.08],
] as const;
export const ONLINE_PIN_LABEL_MIN_SIZE = 8;

export const getPinVisualScaleForZoom = (zoom: number): number => {
  const finiteZoom = Number.isFinite(zoom) ? zoom : 0;
  for (let index = 1; index < ONLINE_PIN_VISUAL_SCALE_STOPS.length; index += 1) {
    const [rightZoom, rightScale] = ONLINE_PIN_VISUAL_SCALE_STOPS[index];
    if (finiteZoom <= rightZoom) {
      const [leftZoom, leftScale] = ONLINE_PIN_VISUAL_SCALE_STOPS[index - 1];
      const progress = Math.max(0, Math.min(1, (finiteZoom - leftZoom) / (rightZoom - leftZoom)));
      return leftScale + (rightScale - leftScale) * progress;
    }
  }
  return ONLINE_PIN_VISUAL_SCALE_STOPS[ONLINE_PIN_VISUAL_SCALE_STOPS.length - 1][1];
};

export const getPinLabelSizeForZoom = (authoredSize: number, zoom: number): number =>
  Math.max(ONLINE_PIN_LABEL_MIN_SIZE, authoredSize * getPinVisualScaleForZoom(zoom));

/** Pin borders are authored in icon pixels; text halos use a gentler capped conversion. */
export const pinLabelHaloWidth = (authoredBorderWidth: number): number =>
  Math.max(0, Math.min(2.5, authoredBorderWidth * 0.4));

export const getRenderedPinVisualCenterOffset = (
  layer: Layer,
  zoom: number,
  customAssetAvailable = false,
): [number, number] => {
  const visualScale = getPinVisualScaleForZoom(zoom) * (layer.pinPopScale ?? 1);
  const dropY = layer.pinDropOffsetY ?? 0;
  if (pinStyleOf(layer) === 'custom' && customAssetAvailable) {
    const centerY = layer.pinCustomAnchor === 'center' ? 0 : -pinSizeOf(layer) * visualScale;
    return [0, centerY + dropY];
  }
  const iconScale = (pinSizeOf(layer) / 15) * visualScale;
  const style = pinStyleOf(layer) === 'custom' ? 'location' : pinStyleOf(layer);
  const contentCenterFromBottom =
    style === 'location' || style === 'map-pin' ? -21.5 : style === 'star' ? -19.43 : -18;
  const anchoredCenter =
    pinStyleOf(layer) === 'custom' && layer.pinCustomAnchor === 'center'
      ? contentCenterFromBottom + BASE_ICON_SIZE / 2
      : contentCenterFromBottom;
  return [0, anchoredCenter * iconScale + dropY];
};

export const pinLabelOffsetForLayerAtZoom = (
  layer: Layer,
  zoom: number,
  customAssetAvailable = false,
): [number, number] => {
  // MapLibre text-offset is measured in em. Divide by the actual rendered
  // label size at this Zoom so the authored Gap remains a logical-pixel
  // center-to-center distance independent of marker and label size.
  const labelSize = getPinLabelSizeForZoom(layer.pinLabelSize ?? PIN_DEFAULTS.labelSize, zoom);
  const radial = pinLabelOffsetOf(layer);
  const center = getRenderedPinVisualCenterOffset(layer, zoom, customAssetAvailable);
  return [(center[0] + radial.x) / Math.max(1, labelSize), (center[1] + radial.y) / Math.max(1, labelSize)];
};

const labelOffsetExpression = (
  layers: readonly Layer[],
  assetUrls: Readonly<Record<string, string>>,
): ExpressionSpecification =>
  [
    'interpolate',
    ['linear'],
    ['zoom'],
    ...ONLINE_PIN_VISUAL_SCALE_STOPS.flatMap(([zoom]) => [
      zoom,
      offsetMatchExpression(layers, (layer) =>
        pinLabelOffsetForLayerAtZoom(
          layer,
          zoom,
          Boolean(layer.pinCustomAssetId && assetUrls[layer.pinCustomAssetId]),
        ),
      ),
    ]),
  ] as unknown as ExpressionSpecification;

const zoomScaledPropertyExpression = (
  property: string,
  multiplier = 1,
  additive = 0,
  minimum?: number,
): ExpressionSpecification =>
  [
    'interpolate',
    ['linear'],
    ['zoom'],
    ...ONLINE_PIN_VISUAL_SCALE_STOPS.flatMap(([zoom, scale]) => {
      const scaled: ExpressionSpecification = ['*', ['get', property], multiplier, scale];
      const adjusted: ExpressionSpecification = additive === 0 ? scaled : ['+', scaled, additive];
      return [zoom, minimum === undefined ? adjusted : ['max', minimum, adjusted]];
    }),
  ] as unknown as ExpressionSpecification;

const offsetMatchExpression = (
  layers: readonly Layer[],
  offsetOf: (layer: Layer) => [number, number],
): ExpressionSpecification => {
  const pins = layers.filter((layer) => layer.type === 'pin' && layer.visible);
  if (pins.length === 0) return ['literal', [0, 0]];
  return [
    'match',
    ['get', 'layerId'],
    ...pins.flatMap((layer) => [layer.id, ['literal', offsetOf(layer)]]),
    ['literal', [0, 0]],
  ] as unknown as ExpressionSpecification;
};

type PinFeature = {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, unknown>;
};

const pinIconId = (layer: Layer, selected: boolean, assetUrls: Readonly<Record<string, string>> = {}) =>
  pinStyleOf(layer) === 'custom' && layer.pinCustomAssetId && assetUrls[layer.pinCustomAssetId]
    ? [
        'mapmotion-custom-pin',
        layer.pinCustomAssetId,
        pinSizeOf(layer),
        layer.pinTintEnabled ? layer.pinTintColor : 'untinted',
        layer.pinBorderColor,
        layer.pinBorderWidth,
      ]
        .join('-')
        .replace(/[^a-z0-9_-]/gi, '_')
    : [
        'mapmotion-pin',
        pinStyleOf(layer) === 'custom' ? 'location' : pinStyleOf(layer),
        layer.color,
        layer.pinBorderColor ?? PIN_DEFAULTS.borderColor,
        layer.pinBorderWidth ?? PIN_DEFAULTS.borderWidth,
        selected ? 'selected' : 'normal',
      ]
        .join('-')
        .replace(/[^a-z0-9_-]/gi, '_');

const drawPinIcon = (layer: Layer, selected: boolean): ImageData => {
  const ratio = 2;
  const canvas = document.createElement('canvas');
  canvas.width = BASE_ICON_SIZE * ratio;
  canvas.height = BASE_ICON_SIZE * ratio;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to create the Online Pin icon canvas.');
  context.scale(ratio, ratio);
  context.translate(BASE_ICON_SIZE / 2, BASE_ICON_SIZE - 3);
  const style = pinStyleOf(layer);
  const fill = layer.color;
  const border = layer.pinBorderColor ?? PIN_DEFAULTS.borderColor;
  const borderWidth = Math.max(1, layer.pinBorderWidth ?? PIN_DEFAULTS.borderWidth);
  const radius = 15;
  context.lineJoin = 'round';
  context.lineWidth = borderWidth;
  context.strokeStyle = border;
  context.fillStyle = fill;
  if (selected) {
    context.save();
    context.shadowColor = '#7fd4ff';
    context.shadowBlur = 7;
    context.beginPath();
    context.arc(0, -16, 19, 0, Math.PI * 2);
    context.strokeStyle = '#7fd4ff';
    context.lineWidth = 2;
    context.stroke();
    context.restore();
  }
  if (style === 'location' || style === 'map-pin') {
    context.beginPath();
    context.moveTo(0, 0);
    context.bezierCurveTo(-3, -8, -13, -14, -13, -24);
    context.arc(0, -24, 13, Math.PI, 0, false);
    context.bezierCurveTo(13, -14, 3, -8, 0, 0);
    context.closePath();
    context.fill();
    context.stroke();
    if (style === 'map-pin') {
      context.beginPath();
      context.arc(0, -24, 4.2, 0, Math.PI * 2);
      context.fillStyle = border;
      context.fill();
    }
  } else if (style === 'star') {
    context.beginPath();
    for (let index = 0; index < 10; index += 1) {
      const r = index % 2 === 0 ? radius : radius * 0.42;
      const angle = -Math.PI / 2 + (Math.PI / 5) * index;
      const x = Math.cos(angle) * r;
      const y = -radius + Math.sin(angle) * r;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    context.fill();
    context.stroke();
  } else if (style === 'target') {
    context.beginPath();
    context.arc(0, -radius, radius, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.arc(0, -radius, radius * 0.58, 0, Math.PI * 2);
    context.strokeStyle = fill;
    context.stroke();
    context.beginPath();
    context.arc(0, -radius, radius * 0.24, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    context.arc(0, -radius, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    if (style === 'dot') {
      context.beginPath();
      context.arc(0, -radius, radius * 0.3, 0, Math.PI * 2);
      context.fillStyle = '#17202d';
      context.fill();
    }
  }
  return context.getImageData(0, 0, canvas.width, canvas.height);
};

export const onlinePinFeatureCollection = (
  layers: readonly Layer[],
  selectedId: string | null,
  assetUrls: Readonly<Record<string, string>> = {},
) => ({
  type: 'FeatureCollection' as const,
  features: layers
    .filter((layer) => layer.type === 'pin' && layer.visible)
    .map((layer): PinFeature => ({
      type: 'Feature',
      id: layer.id,
      geometry: { type: 'Point', coordinates: mapMotionWorldToLngLat(layer.x, layer.y) },
      properties: {
        layerId: layer.id,
        iconId: pinIconId(layer, layer.id === selectedId, assetUrls),
        iconScale:
          pinStyleOf(layer) === 'custom' && layer.pinCustomAssetId && assetUrls[layer.pinCustomAssetId]
            ? (layer.pinPopScale ?? 1)
            : (pinSizeOf(layer) / 15) * (layer.pinPopScale ?? 1),
        iconAnchor:
          pinStyleOf(layer) === 'custom' && layer.pinCustomAnchor === 'center' ? 'center' : 'bottom',
        opacity: layer.opacity,
        selected: layer.id === selectedId,
        pinSize: pinSizeOf(layer),
        label: layer.pinLabelVisible !== false ? (layer.text ?? '') : '',
        labelSize: layer.pinLabelSize ?? PIN_DEFAULTS.labelSize,
        labelColor: layer.pinLabelColor ?? PIN_DEFAULTS.labelColor,
        labelOpacity: (layer.pinLabelOpacity ?? PIN_DEFAULTS.labelOpacity) * (layer.pinSceneOpacity ?? 1),
        labelHaloColor: layer.pinLabelBorderColor ?? PIN_DEFAULTS.labelBorderColor,
        labelHaloWidth: pinLabelHaloWidth(layer.pinLabelBorderWidth ?? PIN_DEFAULTS.labelBorderWidth),
        labelAnchor: 'center',
      },
    })),
});

const ensurePinImages = (
  map: MapLibreMap,
  layers: readonly Layer[],
  selectedId: string | null,
  assetUrls: Readonly<Record<string, string>>,
) => {
  for (const layer of layers) {
    if (layer.type !== 'pin') continue;
    const hasCustomAsset =
      pinStyleOf(layer) === 'custom' && layer.pinCustomAssetId && assetUrls[layer.pinCustomAssetId];
    if (hasCustomAsset) continue;
    const fallbackLayer =
      pinStyleOf(layer) === 'custom' ? { ...layer, pinStyle: 'location' as const } : layer;
    const id = pinIconId(layer, layer.id === selectedId, assetUrls);
    if (!map.hasImage(id))
      map.addImage(id, drawPinIcon(fallbackLayer, layer.id === selectedId), { pixelRatio: 2 });
  }
};

export const loadOnlineProjectOverlayAssets = async (
  map: MapLibreMap,
  layers: readonly Layer[],
  assetUrls: Readonly<Record<string, string>>,
) => {
  let loaded = 0;
  for (const layer of layers) {
    if (layer.type !== 'region') continue;
    const id = regionPatternId(layer, assetUrls);
    if (!id) continue;
    const url =
      layer.regionFillMode === 'flag'
        ? flagUrl(resolveFlagCode(layer.regionCountryCode, layer.regionCountryCode2))
        : layer.regionImageAssetId
          ? assetUrls[layer.regionImageAssetId]
          : undefined;
    if (!url) continue;
    await loadGeographicRegionImage(url);
    loaded += 1;
  }
  for (const layer of layers) {
    if (layer.type !== 'pin' || pinStyleOf(layer) !== 'custom' || !layer.pinCustomAssetId) continue;
    const url = assetUrls[layer.pinCustomAssetId];
    if (!url) continue;
    const id = pinIconId(layer, false, assetUrls);
    if (map.hasImage(id)) continue;
    const response = await map.loadImage(url);
    if (!map.isStyleLoaded() || map.hasImage(id)) continue;
    const width = 'width' in response.data ? response.data.width : BASE_ICON_SIZE;
    const height = 'height' in response.data ? response.data.height : BASE_ICON_SIZE;
    const logicalSize = Math.max(1, pinSizeOf(layer) * 2);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Unable to create the custom Online Pin canvas.');
    const borderWidth = Math.max(0, layer.pinBorderWidth ?? 0);
    if (borderWidth > 0) {
      context.save();
      context.shadowColor = layer.pinBorderColor ?? PIN_DEFAULTS.borderColor;
      context.shadowBlur = borderWidth * 2;
      context.drawImage(response.data, 0, 0, width, height);
      context.restore();
    }
    context.drawImage(response.data, 0, 0, width, height);
    if (layer.pinTintEnabled) {
      context.globalCompositeOperation = 'source-in';
      context.fillStyle = layer.pinTintColor ?? PIN_DEFAULTS.tintColor;
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = 'source-over';
    }
    map.addImage(id, context.getImageData(0, 0, width, height), {
      pixelRatio: Math.max(width, height) / logicalSize,
    });
    loaded += 1;
  }
  return loaded;
};

export const ensureOnlineProjectOverlays = (
  map: MapLibreMap,
  layers: readonly Layer[],
  selectedId: string | null = null,
  assetUrls: Readonly<Record<string, string>> = {},
) => {
  const regionCount = ensureRegionOverlays(map, layers, selectedId, assetUrls);
  ensurePinImages(map, layers, selectedId, assetUrls);
  const data = onlinePinFeatureCollection(layers, selectedId, assetUrls);
  const existing = map.getSource(ONLINE_PROJECT_PIN_SOURCE_ID) as GeoJSONSource | undefined;
  if (existing) existing.setData(data);
  else map.addSource(ONLINE_PROJECT_PIN_SOURCE_ID, { type: 'geojson', data });
  if (!map.getLayer(ONLINE_PROJECT_PIN_SELECTION_LAYER_ID))
    map.addLayer({
      id: ONLINE_PROJECT_PIN_SELECTION_LAYER_ID,
      type: 'circle',
      source: ONLINE_PROJECT_PIN_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      filter: ['==', ['get', 'selected'], true],
      paint: {
        'circle-radius': zoomScaledPropertyExpression('pinSize', 1.2, 4),
        'circle-color': 'rgba(127, 212, 255, 0.12)',
        'circle-stroke-color': '#7fd4ff',
        'circle-stroke-width': 2,
        'circle-pitch-alignment': 'viewport',
        'circle-pitch-scale': 'viewport',
      },
    });
  if (!map.getLayer(ONLINE_PROJECT_PIN_LAYER_ID))
    map.addLayer({
      id: ONLINE_PROJECT_PIN_LAYER_ID,
      type: 'symbol',
      source: ONLINE_PROJECT_PIN_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      layout: {
        'icon-image': ['get', 'iconId'],
        'icon-size': zoomScaledPropertyExpression('iconScale'),
        'icon-offset': offsetMatchExpression(layers, (layer) => [0, layer.pinDropOffsetY ?? 0]),
        'icon-anchor': ['get', 'iconAnchor'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-rotation-alignment': 'viewport',
        'icon-pitch-alignment': 'viewport',
      },
      paint: { 'icon-opacity': ['get', 'opacity'] },
    });
  if (!map.getLayer(ONLINE_PROJECT_PIN_LABEL_LAYER_ID))
    map.addLayer({
      id: ONLINE_PROJECT_PIN_LABEL_LAYER_ID,
      type: 'symbol',
      source: ONLINE_PROJECT_PIN_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': zoomScaledPropertyExpression('labelSize', 1, 0, ONLINE_PIN_LABEL_MIN_SIZE),
        'text-offset': labelOffsetExpression(layers, assetUrls),
        'text-anchor': ['get', 'labelAnchor'],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'text-rotation-alignment': 'viewport',
        'text-pitch-alignment': 'viewport',
      },
      paint: {
        'text-color': ['get', 'labelColor'],
        'text-opacity': ['get', 'labelOpacity'],
        'text-halo-color': ['get', 'labelHaloColor'],
        'text-halo-width': ['get', 'labelHaloWidth'],
      },
    });
  map.setLayoutProperty(
    ONLINE_PROJECT_PIN_LAYER_ID,
    'icon-offset',
    offsetMatchExpression(layers, (layer) => [0, layer.pinDropOffsetY ?? 0]),
  );
  map.setLayoutProperty(
    ONLINE_PROJECT_PIN_LABEL_LAYER_ID,
    'text-offset',
    labelOffsetExpression(layers, assetUrls),
  );
  return regionCount + data.features.length;
};

export const updateOnlineProjectOverlays = (
  map: MapLibreMap,
  layers: readonly Layer[],
  selectedId: string | null = null,
  assetUrls: Readonly<Record<string, string>> = {},
) => {
  if (!map.isStyleLoaded()) return 0;
  return ensureOnlineProjectOverlays(map, layers, selectedId, assetUrls);
};
