import { useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { normalizeBearing } from '../core/camera';
import {
  mapLibreToMapMotionCamera,
  mapLibreMaximumZoom,
  mapMotionToMapLibreCamera,
  isRecoverableOpenFreeMapResourceError,
  OPENFREEMAP_STYLES,
} from '../core/openFreeMapAdapter';
import { registerOnlineMapInstance } from '../core/onlineMapLifecycle';
import { fitProjectViewport, type LogicalViewport } from '../core/projectRenderViewport';
import type { CameraState, OnlineBasemapStyleId } from '../core/project';

export const ONLINE_INTERACTIVE_MIN_PIXEL_RATIO = 0.75;
export const ONLINE_INTERACTIVE_MAX_PIXEL_RATIO = 1.25;
const CAMERA_SYNC_INTERVAL_MS = 32;
const cameraSignature = (camera: CameraState) =>
  [camera.x, camera.y, camera.zoom, camera.bearing ?? 0, camera.pitch ?? 0].join(':');

export const interactivePixelRatioForDisplay = (displayScale: number, devicePixelRatio: number) =>
  Math.min(
    ONLINE_INTERACTIVE_MAX_PIXEL_RATIO,
    Math.max(ONLINE_INTERACTIVE_MIN_PIXEL_RATIO, displayScale * devicePixelRatio),
  );

interface Props {
  camera: CameraState;
  onCameraChange: (camera: CameraState) => void;
  styleId: OnlineBasemapStyleId;
  interactionEnabled: boolean;
  viewport: LogicalViewport;
}

export function OnlineOpenFreeMap({ camera, onCameraChange, styleId, interactionEnabled, viewport }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const displayRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const loadedStyleRef = useRef<OnlineBasemapStyleId | null>(null);
  const cameraRef = useRef(camera);
  const onCameraChangeRef = useRef(onCameraChange);
  const applyingCanonicalCamera = useRef(false);
  const nativeCameraSignaturesRef = useRef(new Set<string>());
  const diagnosticsRef = useRef({ nativeSyncs: 0, externalApplications: 0 });
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading online map...');
  cameraRef.current = camera;
  onCameraChangeRef.current = onCameraChange;

  useEffect(() => {
    const stage = stageRef.current;
    const display = displayRef.current;
    const container = containerRef.current;
    if (!stage || !display || !container) return;
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

    const initial = mapMotionToMapLibreCamera(cameraRef.current);
    const style = OPENFREEMAP_STYLES.find((candidate) => candidate.id === styleId)!;
    loadedStyleRef.current = styleId;
    map = new maplibregl.Map({
      container,
      style: style.url,
      center: initial.center,
      zoom: initial.zoom,
      bearing: initial.bearing,
      pitch: initial.pitch,
      attributionControl: { compact: false },
      maxPitch: 85,
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
  }, [viewport.height, viewport.width]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (loadedStyleRef.current === styleId) return;
    const style = OPENFREEMAP_STYLES.find((candidate) => candidate.id === styleId)!;
    loadedStyleRef.current = styleId;
    setError(null);
    setStatus(`Loading ${style.label}...`);
    map.setStyle(style.url);
  }, [styleId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // A native MapLibre gesture already put the map at this camera. Its React
    // echo is telemetry, not an external command, so never bounce it back via jumpTo.
    const signature = cameraSignature(camera);
    if (nativeCameraSignaturesRef.current.delete(signature)) {
      return;
    }
    const next = mapMotionToMapLibreCamera(camera);
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
    applyingCanonicalCamera.current = false;
  }, [camera]);

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

  return (
    <div ref={stageRef} className="online-map-poc" data-online-map-status={error ? 'error' : 'ready'}>
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
      <div className="online-map-status">{error ?? status}</div>
    </div>
  );
}
