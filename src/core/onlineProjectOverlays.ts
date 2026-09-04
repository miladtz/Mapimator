import type { GeoJSON } from 'geojson';
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { mapMotionWorldToLngLat } from './openFreeMapAdapter';
import { PIN_DEFAULTS, pinLabelOffsetOf, pinSizeOf, pinStyleOf, type Layer } from './project';
import { regionPresentation, resolveFlagCode, revealRegionGeometry } from './regions';
import {
  defaultVehicleForPathType,
  resolveRouteAppearance,
  routePositionAtProgress,
  routePrefixGeometry,
} from './routes';
import {
  GeographicRegionFillLayer,
  loadGeographicRegionImage,
  ONLINE_GEOGRAPHIC_REGION_FILL_LAYER_ID,
} from './geographicRegionFillLayer';
import { rasterizeTextLayer, textLayerImageId, waitForTextLayerFonts } from './textLayers';
import {
  arrowHeadCoordinates,
  editableShapePoints,
  evaluatedShapeCoordinates,
  shapeWorldToMercatorMeters,
} from './shapes';

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
export const ONLINE_PROJECT_TEXT_SOURCE_ID = 'mapmotion-project-text';
export const ONLINE_PROJECT_TEXT_FLAT_SOURCE_ID = 'mapmotion-project-text-flat';
export const ONLINE_PROJECT_TEXT_SELECTION_LAYER_ID = 'mapmotion-project-text-selection';
export const ONLINE_PROJECT_TEXT_FLAT_SELECTION_LAYER_ID = 'mapmotion-project-text-flat-selection';
export const ONLINE_PROJECT_TEXT_LAYER_ID = 'mapmotion-project-text-symbols';
export const ONLINE_PROJECT_TEXT_FLAT_LAYER_ID = 'mapmotion-project-text-symbols-flat';
export const ONLINE_PROJECT_SHAPE_SOURCE_ID = 'mapmotion-project-shapes';
export const ONLINE_PROJECT_SHAPE_FILL_LAYER_ID = 'mapmotion-project-shape-fills';
export const ONLINE_PROJECT_SHAPE_SOLID_LAYER_ID = 'mapmotion-project-shape-solid';
export const ONLINE_PROJECT_SHAPE_DASHED_LAYER_ID = 'mapmotion-project-shape-dashed';
export const ONLINE_PROJECT_SHAPE_DOTTED_LAYER_ID = 'mapmotion-project-shape-dotted';
export const ONLINE_PROJECT_SHAPE_HANDLE_LAYER_ID = 'mapmotion-project-shape-handles';
export const ONLINE_PROJECT_ROUTE_SOURCE_ID = 'mapmotion-project-routes';
export const ONLINE_PROJECT_ROUTE_SOLID_LAYER_ID = 'mapmotion-project-route-solid';
export const ONLINE_PROJECT_ROUTE_DASHED_LAYER_ID = 'mapmotion-project-route-dashed';
export const ONLINE_PROJECT_ROUTE_DOTTED_LAYER_ID = 'mapmotion-project-route-dotted';
export const ONLINE_PROJECT_ROUTE_RAILWAY_SLEEPERS_LAYER_ID = 'mapmotion-project-route-railway-sleepers';
export const ONLINE_PROJECT_ROUTE_RAILWAY_RAILS_LAYER_ID = 'mapmotion-project-route-railway-rails';
export const ONLINE_PROJECT_ROUTE_ARROW_LAYER_ID = 'mapmotion-project-route-arrows';
export const ONLINE_PROJECT_ROUTE_VEHICLE_LAYER_ID = 'mapmotion-project-route-vehicles';
export const ONLINE_PROJECT_ROUTE_WAYPOINT_LAYER_ID = 'mapmotion-project-route-waypoints';
const OVERLAY_METADATA = { 'mapmotion:overlay': true } as const;
const BASE_ICON_SIZE = 48;
const geographicRegionLayers = new WeakMap<MapLibreMap, GeographicRegionFillLayer>();
const routeVehicleImageIds = new WeakMap<MapLibreMap, Set<string>>();
const shapeRenderLayerIdsByMap = new WeakMap<MapLibreMap, Set<string>>();
const pendingOverlayUpdates = new WeakMap<
  MapLibreMap,
  {
    layers: readonly Layer[];
    selectedId: string | null;
    assetUrls: Readonly<Record<string, string>>;
  }
>();
const overlayRetryScheduled = new WeakSet<MapLibreMap>();
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
  if (source) source.setData(data as any);
  else map.addSource(ONLINE_PROJECT_REGION_SOURCE_ID, { type: 'geojson', data: data as any });
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

const routeImageId = (kind: string, color: string, accent: string) =>
  `mapmotion-route-${kind}-${color.replace('#', '')}-${accent.replace('#', '')}`;
const routeCustomImageId = (assetId: string) => `mapmotion-route-custom-${assetId}`;
const readyRouteAssetUrls = (map: MapLibreMap, assetUrls: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(assetUrls).filter(([assetId]) => map.hasImage(routeCustomImageId(assetId))),
  );

const routeVehicleImage = (kind: string, color: string, accent: string) => {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const context = canvas.getContext('2d')!;
  context.translate(48, 48);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.shadowColor = 'rgba(0,0,0,.35)';
  context.shadowBlur = 5;
  context.strokeStyle = '#101820';
  context.lineWidth = 5;
  context.fillStyle = color;
  const path = new Path2D();
  const air = kind.includes('plane') || kind === 'private-jet';
  const helicopter = kind === 'helicopter';
  const sea = [
    'ferry',
    'small-boat',
    'yacht',
    'container-ship',
    'cargo-vessel',
    'tanker',
    'bulk-carrier',
    'oil-tanker',
    'lng-carrier',
    'cruise-ship',
    'speedboat',
    'sailboat',
    'cargo-ship',
  ].includes(kind);
  const rail = kind.includes('train') || kind === 'metro';
  const road = [
    'sedan',
    'suv',
    'taxi',
    'pickup',
    'van',
    'bus',
    'coach',
    'delivery-van',
    'small-truck',
    'box-truck',
    'semi-truck',
    'tanker-truck',
    'motorcycle',
  ].includes(kind);
  if (air) {
    path.moveTo(0, -38);
    path.lineTo(8, -9);
    path.lineTo(31, 4);
    path.lineTo(30, 13);
    path.lineTo(7, 6);
    path.lineTo(5, 29);
    path.lineTo(15, 36);
    path.lineTo(0, 33);
    path.lineTo(-15, 36);
    path.lineTo(-5, 29);
    path.lineTo(-7, 6);
    path.lineTo(-30, 13);
    path.lineTo(-31, 4);
    path.lineTo(-8, -9);
    path.closePath();
  } else if (helicopter) {
    path.ellipse(0, 2, 17, 24, 0, 0, Math.PI * 2);
    path.moveTo(0, -22);
    path.lineTo(0, -38);
    path.moveTo(-34, -38);
    path.lineTo(34, -38);
    path.moveTo(-23, 25);
    path.lineTo(23, 25);
  } else if (sea) {
    path.moveTo(0, -37);
    path.lineTo(25, 20);
    path.quadraticCurveTo(0, 36, -25, 20);
    path.closePath();
    path.moveTo(-15, 12);
    path.lineTo(-15, -5);
    path.lineTo(15, -5);
    path.lineTo(15, 12);
  } else if (rail) {
    path.roundRect(-22, -34, 44, 68, 12);
    path.moveTo(-13, -20);
    path.lineTo(13, -20);
    path.moveTo(-13, 19);
    path.lineTo(13, 19);
  } else if (road) {
    path.roundRect(-20, -34, 40, 68, kind === 'motorcycle' ? 18 : 10);
    path.moveTo(-13, -20);
    path.lineTo(13, -20);
    path.moveTo(-13, 19);
    path.lineTo(13, 19);
  } else if (kind === 'person') {
    path.arc(0, -18, 10, 0, Math.PI * 2);
    path.moveTo(0, -8);
    path.lineTo(0, 22);
    path.moveTo(-18, 4);
    path.lineTo(18, 4);
    path.moveTo(0, 22);
    path.lineTo(-14, 37);
    path.moveTo(0, 22);
    path.lineTo(14, 37);
  } else if (kind === 'package') {
    path.rect(-27, -27, 54, 54);
    path.moveTo(-27, -8);
    path.lineTo(27, -8);
    path.moveTo(0, -27);
    path.lineTo(0, 27);
  } else if (kind === 'money') {
    path.arc(0, 0, 30, 0, Math.PI * 2);
  } else if (kind === 'arrow') {
    path.moveTo(0, -35);
    path.lineTo(27, 5);
    path.lineTo(10, 5);
    path.lineTo(10, 34);
    path.lineTo(-10, 34);
    path.lineTo(-10, 5);
    path.lineTo(-27, 5);
    path.closePath();
  } else {
    path.arc(0, 0, kind === 'dot' ? 18 : 24, 0, Math.PI * 2);
  }
  context.stroke(path);
  context.fill(path);
  context.shadowBlur = 0;
  context.strokeStyle = accent;
  context.lineWidth = 3;
  context.stroke(path);
  if (kind === 'money') {
    context.fillStyle = accent;
    context.font = '700 40px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('$', 0, 2);
  }
  return context.getImageData(0, 0, 96, 96);
};

export const onlineRouteFeatureCollection = (
  layers: readonly Layer[],
  selectedId: string | null = null,
  assetUrls: Readonly<Record<string, string>> = {},
) => {
  const features: Array<{
    type: 'Feature';
    id: string;
    geometry: { type: 'LineString' | 'Point'; coordinates: [number, number][] | [number, number] };
    properties: Record<string, string | number | boolean>;
  }> = [];
  for (const layer of layers) {
    if (layer.type !== 'route' || !layer.visible) continue;
    if (layer.id === selectedId)
      for (const waypoint of layer.routePoints ?? [])
        features.push({
          type: 'Feature',
          id: waypoint.id,
          geometry: { type: 'Point', coordinates: [waypoint.longitude, waypoint.latitude] },
          properties: { role: 'waypoint', layerId: layer.id, waypointId: waypoint.id },
        });
    const state = new Map((layer.routeRenderState ?? []).map((entry) => [entry.segmentId, entry]));
    for (const segment of layer.routeSegments ?? []) {
      const appearance = resolveRouteAppearance(layer, segment);
      const render = state.get(segment.id) ?? {
        exists: true,
        opacityMultiplier: 1,
        drawProgress: 1,
        wipeProgress: 0,
        vehicleVisible: true,
        vehicleProgress: 0,
        vehicleType: 'directional-capsule',
        vehicleSize: 22,
        vehicleOpacity: 1,
        vehicleColor: '#ffffff',
        vehicleAccentColor: '#64d5ba',
        vehicleOrientationOffset: 0,
        vehicleFollowDirection: true,
        vehicleInstances: [],
      };
      if (render.exists === false) continue;
      const visibleProgress = Math.max(0, render.drawProgress * (1 - render.wipeProgress));
      const geometry = routePrefixGeometry(segment.geometry, visibleProgress);
      if (geometry.length >= 2)
        features.push({
          type: 'Feature',
          id: segment.id,
          geometry: { type: 'LineString', coordinates: geometry },
          properties: {
            role: 'line',
            layerId: layer.id,
            segmentId: segment.id,
            lineStyle: appearance.lineStyle,
            color: appearance.lineColor,
            opacity: layer.opacity * appearance.lineOpacity * (render.opacityMultiplier ?? 1),
            width: appearance.lineWidth,
          },
        });
      if (appearance.arrow === 'end' && visibleProgress >= 1) {
        const arrow = routePositionAtProgress(segment.geometry, 1);
        features.push({
          type: 'Feature',
          id: `${segment.id}-arrow`,
          geometry: { type: 'Point', coordinates: arrow.coordinate },
          properties: {
            role: 'arrow',
            layerId: layer.id,
            segmentId: segment.id,
            iconId: routeImageId('arrow', appearance.lineColor, appearance.lineColor),
            size: Math.max(12, appearance.lineWidth * 4),
            opacity: layer.opacity * appearance.lineOpacity * (render.opacityMultiplier ?? 1),
            bearing: arrow.bearing,
          },
        });
      }
      const vehicleType = render.vehicleType;
      if (render.vehicleVisible && vehicleType !== 'none') {
        const instances = render.vehicleInstances?.length
          ? render.vehicleInstances
          : [{ id: `${segment.id}-vehicle-0`, progress: render.vehicleProgress }];
        const customReady =
          vehicleType === 'custom' && render.vehicleAssetId && assetUrls[render.vehicleAssetId];
        const iconId = customReady
          ? routeCustomImageId(render.vehicleAssetId!)
          : routeImageId(
              vehicleType === 'custom' ? 'directional-capsule' : vehicleType,
              render.vehicleColor,
              render.vehicleAccentColor,
            );
        for (const instance of instances) {
          const vehicle = routePositionAtProgress(segment.geometry, instance.progress);
          features.push({
            type: 'Feature',
            id: instance.id,
            geometry: { type: 'Point', coordinates: vehicle.coordinate },
            properties: {
              role: 'vehicle',
              layerId: layer.id,
              segmentId: segment.id,
              vehicleInstanceId: instance.id,
              iconId,
              size: render.vehicleSize,
              opacity: layer.opacity * render.vehicleOpacity * (render.opacityMultiplier ?? 1),
              bearing:
                ((render.vehicleFollowDirection ?? true) ? vehicle.bearing : 0) +
                render.vehicleOrientationOffset,
            },
          });
        }
      }
    }
  }
  return { type: 'FeatureCollection' as const, features };
};

const ensureRouteImages = (
  map: MapLibreMap,
  layers: readonly Layer[],
  assetUrls: Readonly<Record<string, string>> = {},
) => {
  let known = routeVehicleImageIds.get(map);
  if (!known) routeVehicleImageIds.set(map, (known = new Set()));
  const requested = new Map<string, [string, string, string]>();
  for (const layer of layers) {
    if (layer.type !== 'route') continue;
    for (const segment of layer.routeSegments ?? []) {
      const appearance = resolveRouteAppearance(layer, segment);
      const render = layer.routeRenderState?.find((state) => state.segmentId === segment.id);
      const requestedVehicleKind = render?.vehicleType ?? 'directional-capsule';
      const vehicleKind =
        requestedVehicleKind === 'custom' && (!render?.vehicleAssetId || !assetUrls[render.vehicleAssetId])
          ? 'directional-capsule'
          : requestedVehicleKind;
      for (const kind of [vehicleKind, appearance.arrow === 'end' ? 'arrow' : 'none']) {
        if (kind === 'none' || kind === 'custom') continue;
        const color = kind === 'arrow' ? appearance.lineColor : (render?.vehicleColor ?? '#ffffff');
        const accent = kind === 'arrow' ? appearance.lineColor : (render?.vehicleAccentColor ?? '#64d5ba');
        requested.set(routeImageId(kind, color, accent), [kind, color, accent]);
      }
    }
  }
  for (const [id, [kind, color, accent]] of requested) {
    if (map.hasImage(id)) {
      known.add(id);
      continue;
    }
    try {
      map.addImage(id, routeVehicleImage(kind, color, accent), { pixelRatio: 2 });
      known.add(id);
    } catch (error) {
      console.warn(`[MapMotion Route] Unable to install optional symbol image ${id}.`, error);
    }
  }
};

const ensureRouteOverlays = (
  map: MapLibreMap,
  layers: readonly Layer[],
  selectedId: string | null,
  assetUrls: Readonly<Record<string, string>> = {},
) => {
  // Register referenced images before setData so MapLibre never evaluates a
  // vehicle/arrow feature against a missing runtime image.
  ensureRouteImages(map, layers, assetUrls);
  // Until a custom image is decoded, emit the deterministic built-in fallback.
  // The post-load update below switches every instance to the custom image.
  const data = onlineRouteFeatureCollection(layers, selectedId, readyRouteAssetUrls(map, assetUrls));
  const source = map.getSource(ONLINE_PROJECT_ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
  if (source) source.setData(data as never);
  else map.addSource(ONLINE_PROJECT_ROUTE_SOURCE_ID, { type: 'geojson', data: data as never });
  const addLine = (id: string, style: string, dash?: number[]) => {
    if (map.getLayer(id)) return;
    map.addLayer({
      id,
      type: 'line',
      source: ONLINE_PROJECT_ROUTE_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      filter: ['all', ['==', ['get', 'role'], 'line'], ['==', ['get', 'lineStyle'], style]],
      layout: { 'line-cap': style === 'dotted' ? 'round' : 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-opacity': ['get', 'opacity'],
        'line-width': ['get', 'width'],
        ...(dash ? { 'line-dasharray': dash } : {}),
      },
    });
  };
  addLine(ONLINE_PROJECT_ROUTE_SOLID_LAYER_ID, 'solid');
  addLine(ONLINE_PROJECT_ROUTE_DASHED_LAYER_ID, 'dashed', [3, 2]);
  addLine(ONLINE_PROJECT_ROUTE_DOTTED_LAYER_ID, 'dotted', [0.1, 2]);
  if (!map.getLayer(ONLINE_PROJECT_ROUTE_RAILWAY_SLEEPERS_LAYER_ID))
    map.addLayer({
      id: ONLINE_PROJECT_ROUTE_RAILWAY_SLEEPERS_LAYER_ID,
      type: 'line',
      source: ONLINE_PROJECT_ROUTE_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      filter: ['all', ['==', ['get', 'role'], 'line'], ['==', ['get', 'lineStyle'], 'railway']],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-opacity': ['get', 'opacity'],
        'line-width': ['*', ['get', 'width'], 2.2],
        'line-dasharray': [0.25, 1.15],
      },
    });
  if (!map.getLayer(ONLINE_PROJECT_ROUTE_RAILWAY_RAILS_LAYER_ID))
    map.addLayer({
      id: ONLINE_PROJECT_ROUTE_RAILWAY_RAILS_LAYER_ID,
      type: 'line',
      source: ONLINE_PROJECT_ROUTE_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      filter: ['all', ['==', ['get', 'role'], 'line'], ['==', ['get', 'lineStyle'], 'railway']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-opacity': ['get', 'opacity'],
        'line-width': ['max', 1, ['*', ['get', 'width'], 0.28]],
        'line-gap-width': ['*', ['get', 'width'], 0.72],
      },
    });
  // Image registration is isolated above, so an optional symbol failure can
  // never prevent the canonical source and line layers from being installed.
  const addSymbol = (id: string, role: string) => {
    if (map.getLayer(id)) return;
    map.addLayer({
      id,
      type: 'symbol',
      source: ONLINE_PROJECT_ROUTE_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      filter: ['==', ['get', 'role'], role],
      layout: {
        'icon-image': ['get', 'iconId'],
        'icon-size': ['/', ['get', 'size'], 48],
        'icon-rotate': ['get', 'bearing'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
      },
      paint: { 'icon-opacity': ['get', 'opacity'] },
    });
  };
  addSymbol(ONLINE_PROJECT_ROUTE_ARROW_LAYER_ID, 'arrow');
  addSymbol(ONLINE_PROJECT_ROUTE_VEHICLE_LAYER_ID, 'vehicle');
  if (!map.getLayer(ONLINE_PROJECT_ROUTE_WAYPOINT_LAYER_ID))
    map.addLayer({
      id: ONLINE_PROJECT_ROUTE_WAYPOINT_LAYER_ID,
      type: 'circle',
      source: ONLINE_PROJECT_ROUTE_SOURCE_ID,
      metadata: { 'mapmotion:editor-only': true },
      filter: ['==', ['get', 'role'], 'waypoint'],
      paint: {
        'circle-radius': 6,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#34bfa3',
        'circle-stroke-width': 2,
      },
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

const textFeatures = (layers: readonly Layer[], selectedId: string | null = null) =>
  layers
    .filter((layer) => layer.type === 'text' && layer.visible && (layer.text ?? '').length > 0)
    .map((layer) => ({
      type: 'Feature' as const,
      id: layer.id,
      geometry: { type: 'Point' as const, coordinates: mapMotionWorldToLngLat(layer.x, layer.y) },
      properties: {
        layerId: layer.id,
        imageId: textLayerImageId(layer),
        opacity: Math.max(0, Math.min(1, layer.opacity)),
        selected: layer.id === selectedId,
        anchor: layer.textAlign === 'left' ? 'left' : layer.textAlign === 'right' ? 'right' : 'center',
        fontSize: layer.fontSize ?? 32,
        iconScale: (layer.textRenderScale ?? 1) * (layer.textAnimationScale ?? 1),
        dropOffsetY: layer.textDropOffsetY ?? 0,
        orientation: layer.textOrientation ?? 'face-camera',
      },
    }));

export const onlineTextFeatureCollections = (layers: readonly Layer[], selectedId: string | null = null) => {
  const features = textFeatures(layers, selectedId);
  return {
    faceCamera: {
      type: 'FeatureCollection' as const,
      features: features.filter((feature) => feature.properties.orientation === 'face-camera'),
    },
    flatOnMap: {
      type: 'FeatureCollection' as const,
      features: features.filter((feature) => feature.properties.orientation === 'flat-on-map'),
    },
  };
};

export const onlineShapeFeatureCollection = (
  layers: readonly Layer[],
  selectedId: string | null = null,
  map?: MapLibreMap,
) => {
  const features: Array<Record<string, unknown>> = [];
  for (const layer of layers) {
    if (layer.type !== 'shape' || !layer.visible) continue;
    const rendered = evaluatedShapeCoordinates(layer);
    if (rendered.coordinates.length < 2) continue;
    const faceCamera = layer.shapeKind === 'arrow' && layer.shapeOrientation === 'face-camera' && map;
    const anchorLngLat = mapMotionWorldToLngLat(layer.x, layer.y);
    const anchorScreen = faceCamera ? map.project({ lng: anchorLngLat[0], lat: anchorLngLat[1] }) : null;
    const anchorMetric = shapeWorldToMercatorMeters(layer.x, layer.y);
    const pixelsPerMeter = faceCamera ? (512 * 2 ** map.getZoom()) / (2 * Math.PI * 6_378_137) : 0;
    const coordinateToLngLat = ([x, y]: [number, number]): [number, number] => {
      if (!faceCamera || !anchorScreen) return mapMotionWorldToLngLat(x, y);
      const metric = shapeWorldToMercatorMeters(x, y);
      const geographic = map.unproject([
        anchorScreen.x + (metric[0] - anchorMetric[0]) * pixelsPerMeter,
        anchorScreen.y - (metric[1] - anchorMetric[1]) * pixelsPerMeter,
      ]);
      return [geographic.lng, geographic.lat];
    };
    const coordinates = rendered.coordinates.map(coordinateToLngLat);
    if (rendered.closed) coordinates.push(coordinates[0]);
    const properties = {
      layerId: layer.id,
      featureKind: rendered.closed ? 'fill' : 'line',
      fillColor: layer.shapeFillColor ?? layer.color,
      fillOpacity: (layer.shapeFillOpacity ?? 0.25) * layer.opacity,
      strokeColor: layer.shapeStrokeColor ?? layer.color,
      strokeOpacity: (layer.shapeStrokeOpacity ?? 1) * layer.opacity,
      strokeWidth: layer.shapeStrokeWidth ?? 3,
      strokeStyle: layer.shapeStrokeStyle ?? 'solid',
      selected: layer.id === selectedId,
    };
    features.push({
      type: 'Feature',
      id: `${layer.id}-geometry`,
      geometry: rendered.closed
        ? { type: 'Polygon', coordinates: [coordinates] }
        : { type: 'LineString', coordinates },
      properties,
    });
    if (layer.shapeKind === 'arrow') {
      const head = arrowHeadCoordinates(layer).map(coordinateToLngLat);
      if (head.length === 3)
        features.push({
          type: 'Feature',
          id: `${layer.id}-arrowhead`,
          geometry: { type: 'Polygon', coordinates: [[...head, head[0]]] },
          properties: {
            ...properties,
            featureKind: 'arrowhead',
            fillColor: layer.shapeStrokeColor ?? layer.color,
            fillOpacity: (layer.shapeStrokeOpacity ?? 1) * layer.opacity,
          },
        });
    }
    if (layer.id === selectedId)
      for (const item of editableShapePoints(layer))
        features.push({
          type: 'Feature',
          id: item.id,
          geometry: { type: 'Point', coordinates: mapMotionWorldToLngLat(item.x, item.y) },
          properties: { layerId: layer.id, pointId: item.id, featureKind: 'handle' },
        });
  }
  return { type: 'FeatureCollection' as const, features };
};

export const shapeRenderLayerIds = (layerId: string) => ({
  fill: `mapmotion-project-shape-${layerId}-fill`,
  stroke: `mapmotion-project-shape-${layerId}-stroke`,
  arrowhead: `mapmotion-project-shape-${layerId}-arrowhead`,
});

export const orderedShapeRenderLayerIds = (layers: readonly Layer[]) =>
  layers
    .filter((layer) => layer.type === 'shape' && layer.visible)
    .flatMap((layer) => Object.values(shapeRenderLayerIds(layer.id)));

const ensureShapeRenderLayers = (map: MapLibreMap, layers: readonly Layer[]) => {
  const desired = new Set(orderedShapeRenderLayerIds(layers));
  for (const id of shapeRenderLayerIdsByMap.get(map) ?? [])
    if (!desired.has(id) && map.getLayer(id)) map.removeLayer(id);
  for (const layer of layers) {
    if (layer.type !== 'shape' || !layer.visible) continue;
    const ids = shapeRenderLayerIds(layer.id);
    const filterFor = (kind: string) =>
      ['all', ['==', ['get', 'layerId'], layer.id], ['==', ['get', 'featureKind'], kind]] as never;
    if (!map.getLayer(ids.fill))
      map.addLayer({
        id: ids.fill,
        type: 'fill',
        source: ONLINE_PROJECT_SHAPE_SOURCE_ID,
        metadata: OVERLAY_METADATA,
        filter: filterFor('fill'),
        paint: { 'fill-color': ['get', 'fillColor'], 'fill-opacity': ['get', 'fillOpacity'] },
      });
    if (!map.getLayer(ids.stroke))
      map.addLayer({
        id: ids.stroke,
        type: 'line',
        source: ONLINE_PROJECT_SHAPE_SOURCE_ID,
        metadata: OVERLAY_METADATA,
        filter: [
          'all',
          ['==', ['get', 'layerId'], layer.id],
          ['any', ['==', ['get', 'featureKind'], 'fill'], ['==', ['get', 'featureKind'], 'line']],
        ],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'strokeColor'],
          'line-opacity': ['get', 'strokeOpacity'],
          'line-width': ['get', 'strokeWidth'],
          'line-dasharray':
            layer.shapeStrokeStyle === 'dashed'
              ? [3, 2]
              : layer.shapeStrokeStyle === 'dotted'
                ? [0.25, 1.5]
                : [1, 0],
        },
      });
    else
      map.setPaintProperty(
        ids.stroke,
        'line-dasharray',
        layer.shapeStrokeStyle === 'dashed'
          ? [3, 2]
          : layer.shapeStrokeStyle === 'dotted'
            ? [0.25, 1.5]
            : [1, 0],
      );
    if (!map.getLayer(ids.arrowhead))
      map.addLayer({
        id: ids.arrowhead,
        type: 'fill',
        source: ONLINE_PROJECT_SHAPE_SOURCE_ID,
        metadata: OVERLAY_METADATA,
        filter: filterFor('arrowhead'),
        paint: { 'fill-color': ['get', 'fillColor'], 'fill-opacity': ['get', 'fillOpacity'] },
      });
  }
  shapeRenderLayerIdsByMap.set(map, desired);
};

const orderShapeRenderLayers = (map: MapLibreMap, layers: readonly Layer[]) => {
  let before = map.getLayer(ONLINE_PROJECT_SHAPE_HANDLE_LAYER_ID)
    ? ONLINE_PROJECT_SHAPE_HANDLE_LAYER_ID
    : undefined;
  for (const id of [...orderedShapeRenderLayerIds(layers)].reverse()) {
    if (!map.getLayer(id)) continue;
    map.moveLayer(id, before);
    before = id;
  }
};

/** Combined collection retained for expression tests and non-rendering consumers. */
export const onlineTextFeatureCollection = (layers: readonly Layer[], selectedId: string | null = null) => ({
  type: 'FeatureCollection' as const,
  features: textFeatures(layers, selectedId),
});

export const textIconOffsetExpression = (
  data: ReturnType<typeof onlineTextFeatureCollection>,
): ExpressionSpecification => {
  if (data.features.length === 0) return ['literal', [0, 0]];
  return [
    'match',
    ['get', 'layerId'],
    ...data.features.flatMap((feature) => [
      feature.properties.layerId,
      ['literal', [0, feature.properties.dropOffsetY]],
    ]),
    ['literal', [0, 0]],
  ] as unknown as ExpressionSpecification;
};

export const setTextIconOffsetIfLayerExists = (
  map: MapLibreMap,
  layerId: string,
  data: ReturnType<typeof onlineTextFeatureCollection>,
) => {
  if (!map.getLayer(layerId)) return false;
  map.setLayoutProperty(layerId, 'icon-offset', textIconOffsetExpression(data));
  return true;
};

const removeTextLayerWithUnexpectedSource = (map: MapLibreMap, layerId: string, expectedSourceId: string) => {
  const layer = map.getLayer(layerId) as { source?: string } | undefined;
  if (!layer || layer.source === expectedSourceId) return false;
  map.removeLayer(layerId);
  return true;
};

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
  if (layers.some((layer) => layer.type === 'text' && layer.visible)) {
    await waitForTextLayerFonts();
    for (const layer of layers) {
      if (layer.type !== 'text' || !layer.visible || !(layer.text ?? '').length) continue;
      const id = textLayerImageId(layer);
      if (map.hasImage(id)) continue;
      map.addImage(id, rasterizeTextLayer(layer), { pixelRatio: 2 });
      loaded += 1;
    }
  }
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
  for (const layer of layers) {
    if (layer.type !== 'route') continue;
    for (const render of layer.routeRenderState ?? []) {
      if (render.vehicleType !== 'custom' || !render.vehicleAssetId) continue;
      const url = assetUrls[render.vehicleAssetId];
      const id = routeCustomImageId(render.vehicleAssetId);
      if (!url || map.hasImage(id)) continue;
      try {
        const response = await map.loadImage(url);
        if (map.hasImage(id)) continue;
        const width = 'width' in response.data ? response.data.width : 96;
        const height = 'height' in response.data ? response.data.height : 96;
        map.addImage(id, response.data, { pixelRatio: Math.max(width, height) / 48 });
        loaded += 1;
      } catch (error) {
        console.warn(
          `[MapMotion Route] Unable to load custom vehicle asset ${render.vehicleAssetId}.`,
          error,
        );
      }
    }
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
  const routeCount = ensureRouteOverlays(map, layers, selectedId, assetUrls);
  const shapeData = onlineShapeFeatureCollection(layers, selectedId, map);
  const shapeSource = map.getSource(ONLINE_PROJECT_SHAPE_SOURCE_ID) as GeoJSONSource | undefined;
  if (shapeSource) shapeSource.setData(shapeData as never);
  else map.addSource(ONLINE_PROJECT_SHAPE_SOURCE_ID, { type: 'geojson', data: shapeData as never });
  if (!map.getLayer(ONLINE_PROJECT_SHAPE_FILL_LAYER_ID))
    map.addLayer({
      id: ONLINE_PROJECT_SHAPE_FILL_LAYER_ID,
      type: 'fill',
      source: ONLINE_PROJECT_SHAPE_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      filter: ['any', ['==', ['get', 'featureKind'], 'fill'], ['==', ['get', 'featureKind'], 'arrowhead']],
      paint: { 'fill-opacity': 0 },
    });
  for (const id of [
    ONLINE_PROJECT_SHAPE_SOLID_LAYER_ID,
    ONLINE_PROJECT_SHAPE_DASHED_LAYER_ID,
    ONLINE_PROJECT_SHAPE_DOTTED_LAYER_ID,
  ])
    if (!map.getLayer(id))
      map.addLayer({
        id,
        type: 'line',
        source: ONLINE_PROJECT_SHAPE_SOURCE_ID,
        metadata: OVERLAY_METADATA,
        filter: ['any', ['==', ['get', 'featureKind'], 'fill'], ['==', ['get', 'featureKind'], 'line']],
        paint: { 'line-opacity': 0, 'line-width': ['max', 10, ['get', 'strokeWidth']] },
      });
  ensureShapeRenderLayers(map, layers);
  if (!map.getLayer(ONLINE_PROJECT_SHAPE_HANDLE_LAYER_ID))
    map.addLayer({
      id: ONLINE_PROJECT_SHAPE_HANDLE_LAYER_ID,
      type: 'circle',
      source: ONLINE_PROJECT_SHAPE_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      filter: ['==', ['get', 'featureKind'], 'handle'],
      paint: {
        'circle-radius': 5,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#2889d8',
        'circle-stroke-width': 2,
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'viewport',
      },
    });
  orderShapeRenderLayers(map, layers);
  const { faceCamera: textData, flatOnMap: flatTextData } = onlineTextFeatureCollections(layers, selectedId);
  const textSource = map.getSource(ONLINE_PROJECT_TEXT_SOURCE_ID) as GeoJSONSource | undefined;
  if (textSource) textSource.setData(textData);
  else map.addSource(ONLINE_PROJECT_TEXT_SOURCE_ID, { type: 'geojson', data: textData as never });
  const flatTextSource = map.getSource(ONLINE_PROJECT_TEXT_FLAT_SOURCE_ID) as GeoJSONSource | undefined;
  if (flatTextSource) flatTextSource.setData(flatTextData);
  else
    map.addSource(ONLINE_PROJECT_TEXT_FLAT_SOURCE_ID, {
      type: 'geojson',
      data: flatTextData as never,
    });
  // Replace the short-lived 11.1C shared-source Flat layer in a live/HMR session.
  // Fresh styles and subsequent style reloads already use the dedicated source.
  removeTextLayerWithUnexpectedSource(
    map,
    ONLINE_PROJECT_TEXT_FLAT_SELECTION_LAYER_ID,
    ONLINE_PROJECT_TEXT_FLAT_SOURCE_ID,
  );
  removeTextLayerWithUnexpectedSource(
    map,
    ONLINE_PROJECT_TEXT_FLAT_LAYER_ID,
    ONLINE_PROJECT_TEXT_FLAT_SOURCE_ID,
  );
  if (!map.getLayer(ONLINE_PROJECT_TEXT_SELECTION_LAYER_ID))
    map.addLayer({
      id: ONLINE_PROJECT_TEXT_SELECTION_LAYER_ID,
      type: 'circle',
      source: ONLINE_PROJECT_TEXT_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      filter: ['==', ['get', 'selected'], true],
      paint: {
        'circle-radius': ['+', 5, ['*', ['get', 'fontSize'], 0.15]],
        'circle-color': 'rgba(127, 212, 255, 0.16)',
        'circle-stroke-color': '#7fd4ff',
        'circle-stroke-width': 1.5,
        'circle-pitch-alignment': 'viewport',
        'circle-pitch-scale': 'viewport',
      },
    });
  if (!map.getLayer(ONLINE_PROJECT_TEXT_FLAT_SELECTION_LAYER_ID))
    map.addLayer({
      id: ONLINE_PROJECT_TEXT_FLAT_SELECTION_LAYER_ID,
      type: 'circle',
      source: ONLINE_PROJECT_TEXT_FLAT_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      filter: ['==', ['get', 'selected'], true],
      paint: {
        'circle-radius': ['+', 5, ['*', ['get', 'fontSize'], 0.15]],
        'circle-color': 'rgba(127, 212, 255, 0.16)',
        'circle-stroke-color': '#7fd4ff',
        'circle-stroke-width': 1.5,
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'map',
      },
    });
  if (!map.getLayer(ONLINE_PROJECT_TEXT_LAYER_ID))
    map.addLayer({
      id: ONLINE_PROJECT_TEXT_LAYER_ID,
      type: 'symbol',
      source: ONLINE_PROJECT_TEXT_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      layout: {
        'icon-image': ['get', 'imageId'],
        'icon-size': ['get', 'iconScale'],
        'icon-offset': ['literal', [0, 0]],
        'icon-anchor': ['get', 'anchor'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-rotation-alignment': 'viewport',
        'icon-pitch-alignment': 'viewport',
      },
      paint: { 'icon-opacity': ['get', 'opacity'] },
    });
  if (!map.getLayer(ONLINE_PROJECT_TEXT_FLAT_LAYER_ID))
    map.addLayer({
      id: ONLINE_PROJECT_TEXT_FLAT_LAYER_ID,
      type: 'symbol',
      source: ONLINE_PROJECT_TEXT_FLAT_SOURCE_ID,
      metadata: OVERLAY_METADATA,
      layout: {
        'icon-image': ['get', 'imageId'],
        'icon-size': ['get', 'iconScale'],
        'icon-offset': ['literal', [0, 0]],
        'icon-anchor': ['get', 'anchor'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
      },
      paint: { 'icon-opacity': ['get', 'opacity'] },
    });
  setTextIconOffsetIfLayerExists(map, ONLINE_PROJECT_TEXT_LAYER_ID, textData);
  setTextIconOffsetIfLayerExists(map, ONLINE_PROJECT_TEXT_FLAT_LAYER_ID, flatTextData);
  ensurePinImages(map, layers, selectedId, assetUrls);
  const data = onlinePinFeatureCollection(layers, selectedId, assetUrls);
  const existing = map.getSource(ONLINE_PROJECT_PIN_SOURCE_ID) as GeoJSONSource | undefined;
  if (existing) existing.setData(data);
  else map.addSource(ONLINE_PROJECT_PIN_SOURCE_ID, { type: 'geojson', data: data as any });
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
  return (
    regionCount +
    routeCount +
    shapeData.features.length +
    textData.features.length +
    flatTextData.features.length +
    data.features.length
  );
};

export const updateOnlineProjectOverlays = (
  map: MapLibreMap,
  layers: readonly Layer[],
  selectedId: string | null = null,
  assetUrls: Readonly<Record<string, string>> = {},
) => {
  if (!map.isStyleLoaded()) {
    // MapLibre reports the whole style as not loaded while sources/tiles are
    // doing ordinary asynchronous work. Existing MapMotion GeoJSON sources
    // remain writable during that interval and must not miss React updates.
    // A real style replacement removes the sources; its style.load handler
    // reinstalls them with the latest canonical layer state.
    let updated = 0;
    const regionData = onlineRegionFeatureCollection(layers, selectedId, assetUrls) as any;
    const regionSource = map.getSource(ONLINE_PROJECT_REGION_SOURCE_ID) as GeoJSONSource | undefined;
    if (regionSource) {
      regionSource.setData(regionData as never);
      updated += regionData.features.length;
    }
    const routeData = onlineRouteFeatureCollection(layers, selectedId, readyRouteAssetUrls(map, assetUrls));
    const routeSource = map.getSource(ONLINE_PROJECT_ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
    if (routeSource) {
      routeSource.setData(routeData as never);
      updated += routeData.features.length;
    }
    const pinData = onlinePinFeatureCollection(layers, selectedId, assetUrls);
    const pinSource = map.getSource(ONLINE_PROJECT_PIN_SOURCE_ID) as GeoJSONSource | undefined;
    if (pinSource) {
      pinSource.setData(pinData);
      updated += pinData.features.length;
    }
    const shapeData = onlineShapeFeatureCollection(layers, selectedId, map);
    const shapeSource = map.getSource(ONLINE_PROJECT_SHAPE_SOURCE_ID) as GeoJSONSource | undefined;
    if (shapeSource) {
      shapeSource.setData(shapeData as never);
      updated += shapeData.features.length;
    }
    const { faceCamera: textData, flatOnMap: flatTextData } = onlineTextFeatureCollections(
      layers,
      selectedId,
    );
    const textSource = map.getSource(ONLINE_PROJECT_TEXT_SOURCE_ID) as GeoJSONSource | undefined;
    if (textSource) {
      textSource.setData(textData);
      updated += textData.features.length;
    }
    const flatTextSource = map.getSource(ONLINE_PROJECT_TEXT_FLAT_SOURCE_ID) as GeoJSONSource | undefined;
    if (flatTextSource) {
      flatTextSource.setData(flatTextData);
      updated += flatTextData.features.length;
    }
    pendingOverlayUpdates.set(map, { layers, selectedId, assetUrls });
    if (!overlayRetryScheduled.has(map)) {
      overlayRetryScheduled.add(map);
      map.once('idle', () => {
        overlayRetryScheduled.delete(map);
        const pending = pendingOverlayUpdates.get(map);
        pendingOverlayUpdates.delete(map);
        if (pending) updateOnlineProjectOverlays(map, pending.layers, pending.selectedId, pending.assetUrls);
      });
    }
    return updated;
  }
  pendingOverlayUpdates.delete(map);
  return ensureOnlineProjectOverlays(map, layers, selectedId, assetUrls);
};
