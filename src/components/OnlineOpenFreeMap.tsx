import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  updateOnlineProjectOverlays,
} from '../core/onlineProjectOverlays';
import { fitProjectViewport, type LogicalViewport } from '../core/projectRenderViewport';
import type { CameraState, Layer, MapLabelLanguageMode, OnlineBasemapStyleId } from '../core/project';

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
  onBackgroundClick?: (point: { x: number; y: number }) => void;
  onRegionPoint?: (point: [number, number]) => void;
  onRegionFinish?: () => void;
  regionDraft?: [number, number][];
  assetUrls?: Readonly<Record<string, string>>;
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
  onBackgroundClick,
  onRegionPoint,
  onRegionFinish,
  regionDraft = [],
  assetUrls = {},
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
  const onBackgroundClickRef = useRef(onBackgroundClick);
  const onRegionPointRef = useRef(onRegionPoint);
  const onRegionFinishRef = useRef(onRegionFinish);
  const regionDraftRef = useRef(regionDraft);
  const assetUrlsRef = useRef(assetUrls);
  const applyingCanonicalCamera = useRef(false);
  const nativeCameraSignaturesRef = useRef(new Set<string>());
  const diagnosticsRef = useRef({ nativeSyncs: 0, externalApplications: 0 });
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
  onBackgroundClickRef.current = onBackgroundClick;
  onRegionPointRef.current = onRegionPoint;
  onRegionFinishRef.current = onRegionFinish;
  regionDraftRef.current = regionDraft;
  assetUrlsRef.current = assetUrls;

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
    map.on('mousemove', (event) => {
      if (!movingPinId) {
        const draft = regionDraftRef.current;
        const source = map!.getSource('mapmotion-region-draft') as
          import('maplibre-gl').GeoJSONSource | undefined;
        if (onRegionPointRef.current && source && draft.length) {
          const firstPoint = map!.project({ lng: draft[0][0], lat: draft[0][1] });
          const snapped = draft.length >= 3 && withinRegionClosureRadius(firstPoint, event.point);
          const pointer: [number, number] = snapped ? draft[0] : [event.lngLat.lng, event.lngLat.lat];
          source.setData(regionDraftFeatureCollection(draft, pointer, snapped));
        }
        return;
      }
      pinMoved = true;
      const point = lngLatToMapMotionWorld(event.lngLat.lng, event.lngLat.lat);
      onMovePinRef.current(movingPinId, point.x, point.y);
    });
    const finishPinMove = () => {
      if (!movingPinId) return;
      movingPinId = null;
      map!.dragPan.enable();
      map!.getCanvas().style.cursor = '';
    };
    map.on('mouseup', finishPinMove);
    map.on('click', (event) => {
      if (!interactionEnabledRef.current) return;
      const hit = map!.queryRenderedFeatures(event.point, { layers: [ONLINE_PROJECT_PIN_LAYER_ID] })[0];
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
    void loadOnlineProjectOverlayAssets(map, layers, assetUrls).then(() =>
      updateOnlineProjectOverlays(map, layersRef.current, selectedIdRef.current, assetUrlsRef.current),
    );
  }, [assetUrls, layers, selectedId]);

  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const id = 'mapmotion-region-draft';
    const data = regionDraftFeatureCollection(regionDraft);
    const source = map.getSource(id) as import('maplibre-gl').GeoJSONSource | undefined;
    if (source) source.setData(data);
    else map.addSource(id, { type: 'geojson', data });
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
    if (!map) return;
    // A native MapLibre gesture already put the map at this camera. Its React
    // echo is telemetry, not an external command, so never bounce it back via jumpTo.
    const signature = cameraSignature(camera);
    if (nativeCameraSignaturesRef.current.delete(signature)) {
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
