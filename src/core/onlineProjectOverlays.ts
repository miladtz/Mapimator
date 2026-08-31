import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { mapMotionWorldToLngLat } from './openFreeMapAdapter';
import { PIN_DEFAULTS, pinLabelOffsetOf, pinSizeOf, pinStyleOf, type Layer } from './project';

export const ONLINE_PROJECT_PIN_SOURCE_ID = 'mapmotion-project-pins';
export const ONLINE_PROJECT_PIN_SELECTION_LAYER_ID = 'mapmotion-project-pin-selection';
export const ONLINE_PROJECT_PIN_LAYER_ID = 'mapmotion-project-pin-icons';
export const ONLINE_PROJECT_PIN_LABEL_LAYER_ID = 'mapmotion-project-pin-labels';
const OVERLAY_METADATA = { 'mapmotion:overlay': true } as const;
const BASE_ICON_SIZE = 48;
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
  return data.features.length;
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
