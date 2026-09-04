import type { GeoJSON } from 'geojson';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { normalizeBearing } from '../core/camera';
import {
  mapLibreToMapMotionCamera,
  mapLibreMinimumZoom,
  mapLibreMaximumZoom,
  mapMotionToMapLibreCamera,
  lngLatToMapMotionWorld,
  isRecoverableOpenFreeMapResourceError,
  OPENFREEMAP_STYLES,
} from '../core/openFreeMapAdapter';
import { registerOnlineMapInstance } from '../core/onlineMapLifecycle';
import { applyOnlineMapLabelLanguage, ensureMapLibreRtlSupport } from '../core/onlineMapLabels';
import {
  ensureOnlineProjectOverlays,
  loadOnlineProjectOverlayAssets,
  ONLINE_PROJECT_PIN_LAYER_ID,
  ONLINE_PROJECT_TEXT_LAYER_ID,
  ONLINE_PROJECT_TEXT_FLAT_LAYER_ID,
  ONLINE_PROJECT_SHAPE_FILL_LAYER_ID,
  ONLINE_PROJECT_SHAPE_SOLID_LAYER_ID,
  ONLINE_PROJECT_SHAPE_DASHED_LAYER_ID,
  ONLINE_PROJECT_SHAPE_DOTTED_LAYER_ID,
  ONLINE_PROJECT_SHAPE_HANDLE_LAYER_ID,
  ONLINE_PROJECT_ROUTE_DASHED_LAYER_ID,
  ONLINE_PROJECT_ROUTE_DOTTED_LAYER_ID,
  ONLINE_PROJECT_ROUTE_RAILWAY_RAILS_LAYER_ID,
  ONLINE_PROJECT_ROUTE_RAILWAY_SLEEPERS_LAYER_ID,
  ONLINE_PROJECT_ROUTE_SOLID_LAYER_ID,
  ONLINE_PROJECT_ROUTE_VEHICLE_LAYER_ID,
  ONLINE_PROJECT_ROUTE_WAYPOINT_LAYER_ID,
  updateOnlineProjectOverlays,
} from '../core/onlineProjectOverlays';
import { fitProjectViewport, type LogicalViewport } from '../core/projectRenderViewport';
import type {
  CameraState,
  Layer,
  MapLabelLanguageMode,
  OnlineBasemapStyleId,
  ShapeKind,
} from '../core/project';

export const ONLINE_INTERACTIVE_MIN_PIXEL_RATIO = 0.75;
export const ONLINE_INTERACTIVE_MAX_PIXEL_RATIO = 1.25;
const CAMERA_SYNC_INTERVAL_MS = 32;
const cameraSignature = (camera: CameraState) =>
  [camera.x, camera.y, camera.zoom, camera.bearing ?? 0, camera.pitch ?? 0].join(':');
export const REGION_CLOSURE_RADIUS = 14;
export const withinRegionClosureRadius = (
  first: { x: number; y: number },
  pointer: { x: number; y: number },
  radius = REGION_CLOSURE_RADIUS,
) => Math.hypot(first.x - pointer.x, first.y - pointer.y) <= radius;

export const regionDraftFeatureCollection = (
  draft: readonly [number, number][],
  pointer?: [number, number],
  snapped = false,
) => ({
  type: 'FeatureCollection' as const,
  features: draft.length
    ? [
        {
          type: 'Feature' as const,
          properties: { kind: 'line' },
          geometry: { type: 'LineString' as const, coordinates: pointer ? [...draft, pointer] : draft },
        },
        ...draft.map((coordinate, index) => ({
          type: 'Feature' as const,
          properties: { kind: 'vertex', first: index === 0, snapped: index === 0 && snapped },
          geometry: { type: 'Point' as const, coordinates: coordinate },
        })),
      ]
    : [],
});
export const routeDraftFeatureCollection = (
  draft: readonly [number, number][],
  candidate?: readonly [number, number][],
  controlPointIds: readonly string[] = [],
  selectedControlPointId?: string | null,
) => ({
  type: 'FeatureCollection' as const,
  features: draft.length
    ? [
        ...((candidate?.length ?? 0) > 1 || draft.length > 1
          ? [
              {
                type: 'Feature' as const,
                properties: { kind: candidate ? 'candidate' : 'line' },
                geometry: { type: 'LineString' as const, coordinates: candidate ?? draft },
              },
            ]
          : []),
        ...draft.map((coordinate, index) => ({
          type: 'Feature' as const,
          properties: {
            kind: 'vertex',
            index: index === 0 ? 'A' : index === draft.length - 1 ? 'B' : `${index}`,
            controlPointId: index > 0 && index < draft.length - 1 ? (controlPointIds[index - 1] ?? '') : '',
            selected:
              index > 0 && index < draft.length - 1 && controlPointIds[index - 1] === selectedControlPointId,
          },
          geometry: { type: 'Point' as const, coordinates: coordinate },
        })),
      ]
    : [],
});

export const shapeDraftFeatureCollection = (
  draft: readonly [number, number][],
  kind?: ShapeKind,
  pointer?: [number, number],
) => {
  const line = draft.length
    ? pointer
      ? kind === 'polygon'
        ? [...draft, pointer, draft[0]]
        : [...draft, pointer]
      : kind === 'polygon' && draft.length > 1
        ? [...draft, draft[0]]
        : draft
    : [];
  return {
    type: 'FeatureCollection' as const,
    features: [
      ...(line.length > 1
        ? [
            {
              type: 'Feature' as const,
              properties: { kind: 'line' },
              geometry: { type: 'LineString' as const, coordinates: line },
            },
          ]
        : []),
      ...draft.map((coordinate, index) => ({
        type: 'Feature' as const,
        properties: { kind: 'vertex', endpoint: index === 0 || index === draft.length - 1 },
        geometry: { type: 'Point' as const, coordinates: coordinate },
      })),
    ],
  };
};

export const interactivePixelRatioForDisplay = (displayScale: number, devicePixelRatio: number) =>
  Math.min(
    ONLINE_INTERACTIVE_MAX_PIXEL_RATIO,
    Math.max(ONLINE_INTERACTIVE_MIN_PIXEL_RATIO, displayScale * devicePixelRatio),
  );

interface Props {
  camera: CameraState;
  onCameraChange: (camera: CameraState) => void;
  styleId: OnlineBasemapStyleId;
  labelLanguage: MapLabelLanguageMode;
  interactionEnabled: boolean;
  viewport: LogicalViewport;
  layers: Layer[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMovePin: (id: string, x: number, y: number) => void;
  onMoveShapePoint?: (layerId: string, pointId: string, x: number, y: number) => void;
  onMoveShape?: (layerId: string, dx: number, dy: number) => void;
  onShapeDrawPoint?: (point: { x: number; y: number }) => void;
  onShapeDrawFinish?: () => void;
  onMoveRouteWaypoint?: (layerId: string, waypointId: string, longitude: number, latitude: number) => void;
  onBackgroundClick?: (point: { x: number; y: number }) => void;
  onRegionPoint?: (point: [number, number]) => void;
  onRegionFinish?: () => void;
  regionDraft?: [number, number][];
  onRoutePoint?: (point: [number, number]) => void;
  routeDraft?: [number, number][];
  routeCandidate?: [number, number][];
  shapeDraftKind?: ShapeKind;
  shapeDraft?: [number, number][];
  customRouteControlPointIds?: string[];
  selectedCustomRouteControlPointId?: string | null;
  onCustomRoutePoint?: (point: [number, number], insertionIndex: number) => void;
  onMoveCustomRouteControlPoint?: (id: string, point: [number, number]) => void;
  onSelectCustomRouteControlPoint?: (id: string | null) => void;
  assetUrls?: Readonly<Record<string, string>>;
  navigationRequest?: { id: number; camera: CameraState } | null;
}

export function OnlineOpenFreeMap({
  camera,
  onCameraChange,
  styleId,
  labelLanguage,
  interactionEnabled,
  viewport,
  layers,
  selectedId,
  onSelect,
  onMovePin,
  onMoveShapePoint,
  onMoveShape,
  onShapeDrawPoint,
  onShapeDrawFinish,
  onMoveRouteWaypoint,
  onBackgroundClick,
  onRegionPoint,
  onRegionFinish,
  regionDraft = [],
  onRoutePoint,
  routeDraft = [],
  routeCandidate,
  shapeDraftKind,
  shapeDraft = [],
  customRouteControlPointIds = [],
  selectedCustomRouteControlPointId,
  onCustomRoutePoint,
  onMoveCustomRouteControlPoint,
  onSelectCustomRouteControlPoint,
  assetUrls = {},
  navigationRequest,
}: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const displayRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const loadedStyleRef = useRef<OnlineBasemapStyleId | null>(null);
  const cameraRef = useRef(camera);
  const onCameraChangeRef = useRef(onCameraChange);
  const labelLanguageRef = useRef(labelLanguage);
  const interactionEnabledRef = useRef(interactionEnabled);
  const layersRef = useRef(layers);
  const selectedIdRef = useRef(selectedId);
  const onSelectRef = useRef(onSelect);
  const onMovePinRef = useRef(onMovePin);
  const onMoveShapePointRef = useRef(onMoveShapePoint);
  const onMoveShapeRef = useRef(onMoveShape);
  const onShapeDrawPointRef = useRef(onShapeDrawPoint);
  const onShapeDrawFinishRef = useRef(onShapeDrawFinish);
  const onMoveRouteWaypointRef = useRef(onMoveRouteWaypoint);
  const onBackgroundClickRef = useRef(onBackgroundClick);
  const onRegionPointRef = useRef(onRegionPoint);
  const onRegionFinishRef = useRef(onRegionFinish);
  const regionDraftRef = useRef(regionDraft);
  const onRoutePointRef = useRef(onRoutePoint);
  const routeDraftRef = useRef(routeDraft);
  const shapeDraftKindRef = useRef(shapeDraftKind);
  const shapeDraftRef = useRef(shapeDraft);
  const onCustomRoutePointRef = useRef(onCustomRoutePoint);
  const onMoveCustomRouteControlPointRef = useRef(onMoveCustomRouteControlPoint);
  const onSelectCustomRouteControlPointRef = useRef(onSelectCustomRouteControlPoint);
  const assetUrlsRef = useRef(assetUrls);
  const applyingCanonicalCamera = useRef(false);
  const nativeCameraSignaturesRef = useRef(new Set<string>());
  const diagnosticsRef = useRef({ nativeSyncs: 0, externalApplications: 0 });
  const appliedNavigationIdRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading online map...');
  const [rtlSettled, setRtlSettled] = useState(false);
  const [rtlFailure, setRtlFailure] = useState<string | null>(null);
  cameraRef.current = camera;
  onCameraChangeRef.current = onCameraChange;
  labelLanguageRef.current = labelLanguage;
  interactionEnabledRef.current = interactionEnabled;
  layersRef.current = layers;
  selectedIdRef.current = selectedId;
  onSelectRef.current = onSelect;
  onMovePinRef.current = onMovePin;
  onMoveShapePointRef.current = onMoveShapePoint;
  onMoveShapeRef.current = onMoveShape;
  onShapeDrawPointRef.current = onShapeDrawPoint;
  onShapeDrawFinishRef.current = onShapeDrawFinish;
  onMoveRouteWaypointRef.current = onMoveRouteWaypoint;
  onBackgroundClickRef.current = onBackgroundClick;
  onRegionPointRef.current = onRegionPoint;
  onRegionFinishRef.current = onRegionFinish;
  regionDraftRef.current = regionDraft;
  onRoutePointRef.current = onRoutePoint;
  routeDraftRef.current = routeDraft;
  shapeDraftKindRef.current = shapeDraftKind;
  shapeDraftRef.current = shapeDraft;
  onCustomRoutePointRef.current = onCustomRoutePoint;
  onMoveCustomRouteControlPointRef.current = onMoveCustomRouteControlPoint;
  onSelectCustomRouteControlPointRef.current = onSelectCustomRouteControlPoint;
  assetUrlsRef.current = assetUrls;
  const overlayAssetSignature = useMemo(
    () =>
      JSON.stringify(
        layers
          .filter(
            (layer) =>
              (layer.type === 'region' &&
                (layer.regionFillMode === 'flag' || layer.regionFillMode === 'image')) ||
              (layer.type === 'pin' && layer.pinStyle === 'custom') ||
              layer.type === 'text' ||
              (layer.type === 'route' &&
                layer.routeRenderState?.some(
                  (render) => render.vehicleType === 'custom' && render.vehicleAssetId,
                )),
          )
          .map((layer) => [
            layer.id,
            layer.regionFillMode,
            layer.regionCountryCode,
            layer.regionCountryCode2,
            layer.regionImageAssetId,
            layer.pinStyle,
            layer.pinCustomAssetId,
            layer.pinSize,
            layer.pinBorderWidth,
            layer.pinBorderColor,
            layer.pinTintEnabled,
            layer.pinTintColor,
            layer.text,
            layer.textLanguage,
            layer.textDirection,
            layer.numberStyle,
            layer.fontFamily,
            layer.fontSize,
            layer.fontWeight,
            layer.fontStyle,
            layer.textAlign,
            layer.lineHeight,
            layer.color,
            layer.routeRenderState
              ?.filter((render) => render.vehicleType === 'custom')
              .map((render) => render.vehicleAssetId),
          ]),
      ),
    [layers],
  );

  useEffect(() => {
    let active = true;
    ensureMapLibreRtlSupport()
      .catch((rtlError: unknown) => {
        if (!active) return;
        const message = rtlError instanceof Error ? rtlError.message : String(rtlError);
        console.error('[OpenFreeMap RTL] initialization failed', rtlError);
        setRtlFailure(message);
      })
      .finally(() => active && setRtlSettled(true));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    const display = displayRef.current;
    const container = containerRef.current;
    if (!stage || !display || !container || !rtlSettled) return;
    const startedAt = performance.now();

    container.style.width = `${viewport.width}px`;
    container.style.height = `${viewport.height}px`;
    container.style.transformOrigin = '0 0';

    let map: MapLibreMap | undefined;
    let lastFitSignature = '';
    let resizeCount = 0;
    let displayScale = 1;
    const applyDisplayFit = () => {
      const fit = fitProjectViewport(viewport, stage.clientWidth, stage.clientHeight);
      const scale = fit.displayWidth / viewport.width;
      displayScale = scale;
      const pixelRatio = interactivePixelRatioForDisplay(scale, window.devicePixelRatio);
      const signature = [fit.displayWidth, fit.displayHeight, scale, pixelRatio]
        .map((value) => value.toFixed(3))
        .join(':');
      if (signature === lastFitSignature) return;
      lastFitSignature = signature;
      resizeCount += 1;
      display.style.width = `${fit.displayWidth}px`;
      display.style.height = `${fit.displayHeight}px`;
      container.style.transform = `scale(${scale})`;
      if (map && Math.abs(map.getPixelRatio() - pixelRatio) >= 0.01) map.setPixelRatio(pixelRatio);
      if (import.meta.env.DEV)
        console.info('[OpenFreeMap Interactive] display fit', {
          availableWidth: stage.clientWidth,
          availableHeight: stage.clientHeight,
          displayWidth: fit.displayWidth,
          displayHeight: fit.displayHeight,
          displayScale: scale,
          pixelRatio,
          resizeCount,
        });
    };
    applyDisplayFit();
    const initial = mapMotionToMapLibreCamera(cameraRef.current, viewport);
    const style = OPENFREEMAP_STYLES.find((candidate) => candidate.id === styleId)!;
    loadedStyleRef.current = styleId;
    container.style.visibility = 'hidden';
    map = new maplibregl.Map({
      container,
      style: style.url,
      center: initial.center,
      zoom: initial.zoom,
      bearing: initial.bearing,
      pitch: initial.pitch,
      attributionControl: { compact: false },
      maxPitch: 85,
      minZoom: mapLibreMinimumZoom(viewport),
      maxZoom: mapLibreMaximumZoom(),
      transformRequest: (url) => ({ url }),
      pixelRatio: interactivePixelRatioForDisplay(displayScale, window.devicePixelRatio),
    });
    mapRef.current = map;
    const releaseLifecycle = registerOnlineMapInstance('interactive');

    let cameraSyncFrame: number | null = null;
    let lastCameraSync = 0;
    const syncCamera = () => {
      if (applyingCanonicalCamera.current || !map) return;
      const center = map.getCenter();
      const next = mapLibreToMapMotionCamera(
        center,
        map.getZoom(),
        map.getBearing(),
        map.getPitch(),
        cameraRef.current.bearing,
        viewport,
      );
      cameraRef.current = next;
      const nativeSignatures = nativeCameraSignaturesRef.current;
      nativeSignatures.add(cameraSignature(next));
      if (nativeSignatures.size > 16) nativeSignatures.delete(nativeSignatures.values().next().value!);
      diagnosticsRef.current.nativeSyncs += 1;
      onCameraChangeRef.current(next);
    };
    const scheduleCameraSync = () => {
      if (applyingCanonicalCamera.current || cameraSyncFrame !== null) return;
      cameraSyncFrame = requestAnimationFrame((now) => {
        cameraSyncFrame = null;
        if (now - lastCameraSync < CAMERA_SYNC_INTERVAL_MS) return;
        lastCameraSync = now;
        syncCamera();
      });
    };
    const finishCameraSync = () => {
      if (cameraSyncFrame !== null) cancelAnimationFrame(cameraSyncFrame);
      cameraSyncFrame = null;
      lastCameraSync = performance.now();
      syncCamera();
    };
    map.on('move', scheduleCameraSync);
    map.on('moveend', finishCameraSync);
    if (import.meta.env.DEV) {
      map.on('dragstart', () => console.debug('[OpenFreeMap Interactive] native drag start'));
      map.on('dragend', () =>
        console.debug('[OpenFreeMap Interactive] native drag end', diagnosticsRef.current),
      );
    }
    map.on('load', () => {
      const milliseconds = Math.round(performance.now() - startedAt);
      setStatus(`Online map ready · ${milliseconds} ms`);
      const canvas = map!.getCanvas();
      console.info('[OpenFreeMap Interactive] renderer diagnostics', {
        loadMs: milliseconds,
        canonicalWidth: viewport.width,
        canonicalHeight: viewport.height,
        displayWidth: display.clientWidth,
        displayHeight: display.clientHeight,
        displayScale: display.clientWidth / viewport.width,
        backingWidth: canvas.width,
        backingHeight: canvas.height,
        browserDevicePixelRatio: window.devicePixelRatio,
        mapPixelRatio: map!.getPixelRatio(),
        mapZoom: map!.getZoom(),
      });
    });
    map.on('style.load', () => {
      applyOnlineMapLabelLanguage(map!, labelLanguageRef.current, true);
      void loadOnlineProjectOverlayAssets(map!, layersRef.current, assetUrlsRef.current).then(() =>
        ensureOnlineProjectOverlays(map!, layersRef.current, selectedIdRef.current, assetUrlsRef.current),
      );
      map!.once('idle', () => {
        container.style.visibility = 'visible';
      });
    });
    let movingPinId: string | null = null;
    let movingShapePoint: { layerId: string; pointId: string } | null = null;
    let movingShape: { layerId: string; x: number; y: number } | null = null;
    let drawingShape = false;
    let shapeDrawFinished = false;
    let movingRouteWaypoint: { layerId: string; waypointId: string } | null = null;
    let movingCustomControlId: string | null = null;
    let pinMoved = false;
    map.on('mousedown', ONLINE_PROJECT_PIN_LAYER_ID, (event) => {
      if (!interactionEnabledRef.current || !event.features?.[0]) return;
      const id = String(event.features[0].properties?.layerId ?? '');
      if (!id) return;
      event.preventDefault();
      movingPinId = id;
      pinMoved = false;
      onSelectRef.current(id);
      map!.dragPan.disable();
      map!.getCanvas().style.cursor = 'grabbing';
    });
    const beginTextMove = (event: import('maplibre-gl').MapLayerMouseEvent) => {
      if (!interactionEnabledRef.current || !event.features?.[0]) return;
      const id = String(event.features[0].properties?.layerId ?? '');
      if (!id) return;
      event.preventDefault();
      movingPinId = id;
      pinMoved = false;
      onSelectRef.current(id);
      map!.dragPan.disable();
      map!.getCanvas().style.cursor = 'grabbing';
    };
    map.on('mousedown', ONLINE_PROJECT_TEXT_LAYER_ID, beginTextMove);
    map.on('mousedown', ONLINE_PROJECT_TEXT_FLAT_LAYER_ID, beginTextMove);
    map.on('mousedown', ONLINE_PROJECT_SHAPE_HANDLE_LAYER_ID, (event) => {
      if (!interactionEnabledRef.current || !event.features?.[0]) return;
      const layerId = String(event.features[0].properties?.layerId ?? '');
      const pointId = String(event.features[0].properties?.pointId ?? '');
      if (!layerId || !pointId) return;
      event.preventDefault();
      movingShapePoint = { layerId, pointId };
      onSelectRef.current(layerId);
      map!.dragPan.disable();
      map!.getCanvas().style.cursor = 'grabbing';
    });
    const beginShapeMove = (event: import('maplibre-gl').MapLayerMouseEvent) => {
      if (!interactionEnabledRef.current || movingShapePoint || !event.features?.[0]) return;
      const layerId = String(event.features[0].properties?.layerId ?? '');
      if (!layerId) return;
      event.preventDefault();
      const world = lngLatToMapMotionWorld(event.lngLat.lng, event.lngLat.lat);
      movingShape = { layerId, x: world.x, y: world.y };
      onSelectRef.current(layerId);
      map!.dragPan.disable();
      map!.getCanvas().style.cursor = 'grabbing';
    };
    for (const layerId of [
      ONLINE_PROJECT_SHAPE_FILL_LAYER_ID,
      ONLINE_PROJECT_SHAPE_SOLID_LAYER_ID,
      ONLINE_PROJECT_SHAPE_DASHED_LAYER_ID,
      ONLINE_PROJECT_SHAPE_DOTTED_LAYER_ID,
    ])
      map.on('mousedown', layerId, beginShapeMove);
    map.on('mousedown', (event) => {
      if (!interactionEnabledRef.current || !onShapeDrawPointRef.current) return;
      event.preventDefault();
      movingShape = null;
      movingShapePoint = null;
      drawingShape = true;
      shapeDrawFinished = false;
      const world = lngLatToMapMotionWorld(event.lngLat.lng, event.lngLat.lat);
      onShapeDrawPointRef.current(world);
      map!.dragPan.disable();
      map!.getCanvas().style.cursor = 'crosshair';
    });
    map.on('mousedown', ONLINE_PROJECT_ROUTE_WAYPOINT_LAYER_ID, (event) => {
      if (!interactionEnabledRef.current || !event.features?.[0]) return;
      const layerId = String(event.features[0].properties?.layerId ?? '');
      const waypointId = String(event.features[0].properties?.waypointId ?? '');
      if (!layerId || !waypointId) return;
      event.preventDefault();
      movingRouteWaypoint = { layerId, waypointId };
      onSelectRef.current(layerId);
      map!.dragPan.disable();
      map!.getCanvas().style.cursor = 'grabbing';
    });
    map.on('mousedown', 'mapmotion-route-draft-points', (event) => {
      if (!interactionEnabledRef.current || !event.features?.[0]) return;
      const controlPointId = String(event.features[0].properties?.controlPointId ?? '');
      if (!controlPointId || !onMoveCustomRouteControlPointRef.current) return;
      event.preventDefault();
      movingCustomControlId = controlPointId;
      onSelectCustomRouteControlPointRef.current?.(controlPointId);
      map!.dragPan.disable();
      map!.getCanvas().style.cursor = 'grabbing';
    });
    map.on('mousemove', (event) => {
      if (drawingShape) {
        const world = lngLatToMapMotionWorld(event.lngLat.lng, event.lngLat.lat);
        onShapeDrawPointRef.current?.(world);
        return;
      }
      if (movingShapePoint) {
        const world = lngLatToMapMotionWorld(event.lngLat.lng, event.lngLat.lat);
        onMoveShapePointRef.current?.(movingShapePoint.layerId, movingShapePoint.pointId, world.x, world.y);
        return;
      }
      if (movingShape) {
        const world = lngLatToMapMotionWorld(event.lngLat.lng, event.lngLat.lat);
        onMoveShapeRef.current?.(movingShape.layerId, world.x - movingShape.x, world.y - movingShape.y);
        movingShape = { ...movingShape, x: world.x, y: world.y };
        return;
      }
      if (movingCustomControlId) {
        onMoveCustomRouteControlPointRef.current?.(movingCustomControlId, [
          event.lngLat.lng,
          event.lngLat.lat,
        ]);
        return;
      }
      if (movingRouteWaypoint) {
        onMoveRouteWaypointRef.current?.(
          movingRouteWaypoint.layerId,
          movingRouteWaypoint.waypointId,
          event.lngLat.lng,
          event.lngLat.lat,
        );
        return;
      }
      if (!movingPinId) {
        const draft = regionDraftRef.current;
        const source = map!.getSource('mapmotion-region-draft') as
          import('maplibre-gl').GeoJSONSource | undefined;
        if (onRegionPointRef.current && source && draft.length) {
          const firstPoint = map!.project({ lng: draft[0][0], lat: draft[0][1] });
          const snapped = draft.length >= 3 && withinRegionClosureRadius(firstPoint, event.point);
          const pointer: [number, number] = snapped ? draft[0] : [event.lngLat.lng, event.lngLat.lat];
          source.setData(regionDraftFeatureCollection(draft, pointer, snapped) as any);
        }
        const shapeKind = shapeDraftKindRef.current;
        const shapeDraft = shapeDraftRef.current;
        const shapeSource = map!.getSource('mapmotion-shape-draft') as
          import('maplibre-gl').GeoJSONSource | undefined;
        if (shapeKind && shapeSource && shapeDraft.length) {
          const pointer: [number, number] = [event.lngLat.lng, event.lngLat.lat];
          shapeSource.setData(shapeDraftFeatureCollection(shapeDraft, shapeKind, pointer) as any);
        }
        return;
      }
      pinMoved = true;
      const point = lngLatToMapMotionWorld(event.lngLat.lng, event.lngLat.lat);
      onMovePinRef.current(movingPinId, point.x, point.y);
    });
    const finishPinMove = () => {
      if (drawingShape) {
        drawingShape = false;
        movingShape = null;
        movingShapePoint = null;
        shapeDrawFinished = true;
        onShapeDrawFinishRef.current?.();
        map!.dragPan.enable();
        map!.getCanvas().style.cursor = '';
        return;
      }
      if (!movingPinId && !movingShapePoint && !movingShape && !movingRouteWaypoint && !movingCustomControlId)
        return;
      movingPinId = null;
      movingShapePoint = null;
      movingShape = null;
      movingRouteWaypoint = null;
      movingCustomControlId = null;
      map!.dragPan.enable();
      map!.getCanvas().style.cursor = '';
    };
    map.on('mouseup', finishPinMove);
    map.on('click', (event) => {
      if (!interactionEnabledRef.current) return;
      if (shapeDrawFinished) {
        shapeDrawFinished = false;
        return;
      }
      const draftHit = map!.getLayer('mapmotion-route-draft-points')
        ? map!.queryRenderedFeatures(event.point, { layers: ['mapmotion-route-draft-points'] })[0]
        : undefined;
      const draftControlId = String(draftHit?.properties?.controlPointId ?? '');
      if (draftControlId && onSelectCustomRouteControlPointRef.current) {
        onSelectCustomRouteControlPointRef.current(draftControlId);
        return;
      }
      const customLineHit = map!.getLayer('mapmotion-route-draft-line')
        ? map!.queryRenderedFeatures(event.point, { layers: ['mapmotion-route-draft-line'] })[0]
        : undefined;
      if (customLineHit && onCustomRoutePointRef.current) {
        const authored = routeDraftRef.current;
        let insertionIndex = Math.max(0, authored.length - 2);
        let nearest = Infinity;
        for (let index = 0; index < authored.length - 1; index += 1) {
          const start = map!.project(authored[index] as [number, number]);
          const end = map!.project(authored[index + 1] as [number, number]);
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const lengthSquared = dx * dx + dy * dy || 1;
          const t = Math.max(
            0,
            Math.min(1, ((event.point.x - start.x) * dx + (event.point.y - start.y) * dy) / lengthSquared),
          );
          const distance = Math.hypot(event.point.x - (start.x + dx * t), event.point.y - (start.y + dy * t));
          if (distance < nearest) {
            nearest = distance;
            insertionIndex = index;
          }
        }
        onCustomRoutePointRef.current([event.lngLat.lng, event.lngLat.lat], insertionIndex);
        return;
      }
      const hit = map!.queryRenderedFeatures(event.point, {
        layers: [
          ONLINE_PROJECT_PIN_LAYER_ID,
          ONLINE_PROJECT_TEXT_LAYER_ID,
          ONLINE_PROJECT_TEXT_FLAT_LAYER_ID,
          ONLINE_PROJECT_SHAPE_FILL_LAYER_ID,
          ONLINE_PROJECT_SHAPE_SOLID_LAYER_ID,
          ONLINE_PROJECT_SHAPE_DASHED_LAYER_ID,
          ONLINE_PROJECT_SHAPE_DOTTED_LAYER_ID,
          ONLINE_PROJECT_ROUTE_WAYPOINT_LAYER_ID,
          ONLINE_PROJECT_ROUTE_VEHICLE_LAYER_ID,
          ONLINE_PROJECT_ROUTE_SOLID_LAYER_ID,
          ONLINE_PROJECT_ROUTE_DASHED_LAYER_ID,
          ONLINE_PROJECT_ROUTE_DOTTED_LAYER_ID,
          ONLINE_PROJECT_ROUTE_RAILWAY_RAILS_LAYER_ID,
          ONLINE_PROJECT_ROUTE_RAILWAY_SLEEPERS_LAYER_ID,
        ].filter((id) => Boolean(map!.getLayer(id))),
      })[0];
      if (hit) {
        onSelectRef.current(String(hit.properties?.layerId ?? hit.id ?? ''));
        pinMoved = false;
        return;
      }
      if (pinMoved) {
        pinMoved = false;
        return;
      }
      if (onRegionPointRef.current) {
        const draft = regionDraftRef.current;
        if (draft.length >= 3) {
          const firstPoint = map!.project({ lng: draft[0][0], lat: draft[0][1] });
          if (withinRegionClosureRadius(firstPoint, event.point)) {
            onRegionFinishRef.current?.();
            return;
          }
        }
        onRegionPointRef.current([event.lngLat.lng, event.lngLat.lat]);
        return;
      }
      if (onRoutePointRef.current) {
        onRoutePointRef.current([event.lngLat.lng, event.lngLat.lat]);
        return;
      }
      if (onCustomRoutePointRef.current) {
        onCustomRoutePointRef.current(
          [event.lngLat.lng, event.lngLat.lat],
          Math.max(0, routeDraftRef.current.length - 2),
        );
        return;
      }
      const point = lngLatToMapMotionWorld(event.lngLat.lng, event.lngLat.lat);
      if (onBackgroundClickRef.current) onBackgroundClickRef.current(point);
      else onSelectRef.current(null);
    });
    map.once('idle', () => {
      const milliseconds = Math.round(performance.now() - startedAt);
      console.info(`[OpenFreeMap POC] first idle/tiles ready: ${milliseconds} ms`);
    });
    map.on('error', (event) => {
      if (isRecoverableOpenFreeMapResourceError(event.error)) return;
      const message = event.error?.message ?? 'Style or tile request failed.';
      console.warn('[OpenFreeMap POC] request failed', event.error);
      setError(`Online map unavailable · ${message}`);
    });

    const resizeObserver = new ResizeObserver(applyDisplayFit);
    resizeObserver.observe(stage);
    return () => {
      resizeObserver.disconnect();
      if (cameraSyncFrame !== null) cancelAnimationFrame(cameraSyncFrame);
      map?.off('move', scheduleCameraSync);
      map?.off('moveend', finishCameraSync);
      mapRef.current = null;
      map?.remove();
      releaseLifecycle();
    };
  }, [rtlSettled, viewport.height, viewport.width]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (loadedStyleRef.current === styleId) return;
    const style = OPENFREEMAP_STYLES.find((candidate) => candidate.id === styleId)!;
    loadedStyleRef.current = styleId;
    setError(null);
    setStatus(`Loading ${style.label}...`);
    const container = containerRef.current;
    if (container) container.style.visibility = 'hidden';
    map.setStyle(style.url);
  }, [styleId]);

  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    applyOnlineMapLabelLanguage(map, labelLanguage);
  }, [labelLanguage]);

  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    updateOnlineProjectOverlays(map, layers, selectedId, assetUrls);
  }, [assetUrls, layers, selectedId]);

  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    void loadOnlineProjectOverlayAssets(map, layersRef.current, assetUrlsRef.current).then(() =>
      updateOnlineProjectOverlays(map, layersRef.current, selectedIdRef.current, assetUrlsRef.current),
    );
  }, [assetUrls, overlayAssetSignature]);

  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const id = 'mapmotion-region-draft';
    const data = regionDraftFeatureCollection(regionDraft);
    const source = map.getSource(id) as import('maplibre-gl').GeoJSONSource | undefined;
    if (source) source.setData(data as any);
    else map.addSource(id, { type: 'geojson', data: data as any });
    if (!map.getLayer(`${id}-line`))
      map.addLayer({
        id: `${id}-line`,
        type: 'line',
        source: id,
        metadata: { 'mapmotion:editor-only': true },
        filter: ['==', ['get', 'kind'], 'line'],
        paint: { 'line-color': '#7fd4ff', 'line-width': 2, 'line-dasharray': [2, 1] },
      });
    if (!map.getLayer(`${id}-points`))
      map.addLayer({
        id: `${id}-points`,
        type: 'circle',
        source: id,
        metadata: { 'mapmotion:editor-only': true },
        filter: ['==', ['get', 'kind'], 'vertex'],
        paint: {
          'circle-radius': ['case', ['get', 'first'], 7, 5],
          'circle-color': ['case', ['get', 'snapped'], '#65e6a7', '#ffffff'],
          'circle-stroke-color': '#168bd2',
          'circle-stroke-width': 2,
        },
      });
  }, [regionDraft]);

  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const id = 'mapmotion-route-draft';
    const data = routeDraftFeatureCollection(
      routeDraft,
      routeCandidate,
      customRouteControlPointIds,
      selectedCustomRouteControlPointId,
    );
    const source = map.getSource(id) as import('maplibre-gl').GeoJSONSource | undefined;
    if (source) source.setData(data as any);
    else map.addSource(id, { type: 'geojson', data: data as any });
    if (!map.getLayer(`${id}-line`))
      map.addLayer({
        id: `${id}-line`,
        type: 'line',
        source: id,
        metadata: { 'mapmotion:editor-only': true },
        filter: ['in', ['get', 'kind'], ['literal', ['line', 'candidate']]],
        paint: { 'line-color': '#ffbd45', 'line-width': 5, 'line-opacity': 0.9 },
      });
    if (!map.getLayer(`${id}-points`))
      map.addLayer({
        id: `${id}-points`,
        type: 'circle',
        source: id,
        metadata: { 'mapmotion:editor-only': true },
        filter: ['==', ['get', 'kind'], 'vertex'],
        paint: {
          'circle-radius': 6,
          'circle-color': ['case', ['get', 'selected'], '#ffbd45', '#ffffff'],
          'circle-stroke-color': '#34bfa3',
          'circle-stroke-width': 2,
        },
      });
    if (!map.getLayer(`${id}-labels`))
      map.addLayer({
        id: `${id}-labels`,
        type: 'symbol',
        source: id,
        metadata: { 'mapmotion:editor-only': true },
        filter: ['==', ['get', 'kind'], 'vertex'],
        layout: {
          'text-field': ['get', 'index'],
          'text-size': 12,
          'text-font': ['Noto Sans Regular'],
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#071018' },
      });
    for (const layerId of [`${id}-line`, `${id}-points`, `${id}-labels`])
      if (map.getLayer(layerId)) map.moveLayer(layerId);
  }, [customRouteControlPointIds, routeCandidate, routeDraft, selectedCustomRouteControlPointId]);

  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const id = 'mapmotion-shape-draft';
    const data = shapeDraftFeatureCollection(shapeDraft, shapeDraftKind);
    const source = map.getSource(id) as import('maplibre-gl').GeoJSONSource | undefined;
    if (source) source.setData(data as any);
    else map.addSource(id, { type: 'geojson', data: data as any });
    if (!map.getLayer(`${id}-line`))
      map.addLayer({
        id: `${id}-line`,
        type: 'line',
        source: id,
        metadata: { 'mapmotion:editor-only': true },
        filter: ['==', ['get', 'kind'], 'line'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#7fd4ff', 'line-width': 4, 'line-opacity': 0.95, 'line-dasharray': [2, 1] },
      });
    if (!map.getLayer(`${id}-points`))
      map.addLayer({
        id: `${id}-points`,
        type: 'circle',
        source: id,
        metadata: { 'mapmotion:editor-only': true },
        filter: ['==', ['get', 'kind'], 'vertex'],
        paint: {
          'circle-radius': ['case', ['get', 'endpoint'], 7, 5],
          'circle-color': '#ffffff',
          'circle-stroke-color': '#168bd2',
          'circle-stroke-width': 2,
        },
      });
    for (const layerId of [`${id}-line`, `${id}-points`]) if (map.getLayer(layerId)) map.moveLayer(layerId);
  }, [shapeDraft, shapeDraftKind]);

  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // A native MapLibre gesture already put the map at this camera. Its React
    // echo is telemetry, not an external command, so never bounce it back via jumpTo.
    const signature = cameraSignature(camera);
    if (nativeCameraSignaturesRef.current.delete(signature)) {
      if (layersRef.current.some((layer) => layer.shapeOrientation === 'face-camera'))
        updateOnlineProjectOverlays(map, layersRef.current, selectedIdRef.current, assetUrlsRef.current);
      return;
    }
    const next = mapMotionToMapLibreCamera(camera, viewport);
    const current = map.getCenter();
    const unchanged =
      Math.abs(current.lng - next.center[0]) < 1e-6 &&
      Math.abs(current.lat - next.center[1]) < 1e-6 &&
      Math.abs(map.getZoom() - next.zoom) < 1e-6 &&
      Math.abs(normalizeBearing(map.getBearing() - next.bearing)) < 1e-6 &&
      Math.abs(map.getPitch() - next.pitch) < 1e-6;
    if (unchanged) return;
    applyingCanonicalCamera.current = true;
    diagnosticsRef.current.externalApplications += 1;
    if (import.meta.env.DEV && map.isMoving())
      console.debug('[OpenFreeMap Interactive] external camera applied while map is moving');
    map.jumpTo(next);
    if (layersRef.current.some((layer) => layer.shapeOrientation === 'face-camera'))
      updateOnlineProjectOverlays(map, layersRef.current, selectedIdRef.current, assetUrlsRef.current);
    if (import.meta.env.DEV) {
      const appliedCenter = map.getCenter();
      console.debug('[OpenFreeMap Camera Semantics]', {
        source: camera,
        jumpTo: next,
        resulting: {
          center: [appliedCenter.lng, appliedCenter.lat],
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch(),
          padding: map.getPadding(),
        },
        feedback: diagnosticsRef.current,
      });
    }
    applyingCanonicalCamera.current = false;
  }, [camera, viewport.height, viewport.width]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !navigationRequest || navigationRequest.id === appliedNavigationIdRef.current) return;
    appliedNavigationIdRef.current = navigationRequest.id;
    const target = mapMotionToMapLibreCamera(navigationRequest.camera, viewport);
    map.stop();
    map.easeTo({ ...target, duration: 700, essential: true });
  }, [navigationRequest, viewport.height, viewport.width]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handlers = [
      map.boxZoom,
      map.doubleClickZoom,
      map.dragPan,
      map.dragRotate,
      map.keyboard,
      map.scrollZoom,
    ];
    handlers.forEach((handler) => (interactionEnabled ? handler.enable() : handler.disable()));
    interactionEnabled ? map.touchZoomRotate.enable() : map.touchZoomRotate.disable();
  }, [interactionEnabled]);

  const rtlStatus =
    rtlFailure && (labelLanguage === 'fa' || labelLanguage === 'both')
      ? `Persian text rendering could not initialize · ${rtlFailure}`
      : null;
  return (
    <div
      ref={stageRef}
      className="online-map-poc"
      data-online-map-status={error || rtlStatus ? 'error' : 'ready'}
    >
      <div ref={displayRef} className="online-map-display-frame">
        <div ref={containerRef} className="online-map-canvas" />
        <div className="online-map-navigation" role="group" aria-label="Map navigation">
          <button
            type="button"
            aria-label="Zoom in"
            disabled={!interactionEnabled}
            onClick={() => mapRef.current?.zoomIn()}
          >
            +
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            disabled={!interactionEnabled}
            onClick={() => mapRef.current?.zoomOut()}
          >
            −
          </button>
          <button
            type="button"
            className="online-map-compass"
            aria-label="Reset bearing and pitch"
            disabled={!interactionEnabled}
            onClick={() => mapRef.current?.easeTo({ bearing: 0, pitch: 0, duration: 300 })}
          >
            N
          </button>
        </div>
      </div>
      <div className="online-map-status">{rtlStatus ?? error ?? status}</div>
    </div>
  );
}
