import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import {
  isRecoverableOpenFreeMapResourceError,
  mapLibreMaximumZoom,
  mapLibreMinimumZoom,
  mapMotionToMapLibreCamera,
  openFreeMapStyleUrl,
} from './openFreeMapAdapter';
import { projectRenderViewport } from './projectRenderViewport';
import { registerOnlineMapInstance, type OnlineMapPurpose } from './onlineMapLifecycle';
import { applyOnlineMapLabelLanguage, ensureMapLibreRtlSupport } from './onlineMapLabels';
import { requiresMapLibreRtl } from './mapLibreRtlAsset';
import type { CameraState, MapLabelLanguageMode, OnlineBasemapStyleId, Project } from './project';

const ONLINE_MAP_READY_TIMEOUT_MS = 30_000;
export const ONLINE_EXPORT_PIXEL_RATIO = 1.5;
export const ONLINE_EXPORT_ANTIALIAS = true;
export const ONLINE_MAP_ATTRIBUTION =
  'OpenFreeMap \u00A9 OpenMapTiles \u00B7 Data \u00A9 OpenStreetMap contributors';

export interface OnlineMapFrameDiagnostics {
  logicalWidth: number;
  logicalHeight: number;
  cssWidth: number;
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
  pixelRatio: number;
  targetWidth: number;
  targetHeight: number;
  mapZoom: number;
  antialias: boolean;
  preserveDrawingBuffer: boolean;
  alpha: boolean;
  premultipliedAlpha: boolean;
  drawMs: number;
}

const abortError = () => new DOMException('Online map rendering was cancelled.', 'AbortError');

const waitForStyleAndApplyLabels = (
  map: MapLibreMap,
  labelLanguage: MapLabelLanguageMode,
  signal?: AbortSignal,
) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onStyleLoad = () => {
      cleanup();
      applyOnlineMapLabelLanguage(map, labelLanguage, true);
      resolve();
    };
    const onError = (event: maplibregl.ErrorEvent) => {
      if (isRecoverableOpenFreeMapResourceError(event.error)) return;
      cleanup();
      reject(event.error ?? new Error('Online map style failed to load.'));
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      map.off('style.load', onStyleLoad);
      map.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Online map style did not load within 30 seconds.'));
    }, ONLINE_MAP_READY_TIMEOUT_MS);
    map.on('style.load', onStyleLoad);
    map.on('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (map.isStyleLoaded()) onStyleLoad();
  });

const waitForIdle = (map: MapLibreMap, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    if (map.loaded() && map.areTilesLoaded() && !map.isMoving()) {
      requestAnimationFrame(() => resolve());
      return;
    }
    const cleanup = () => {
      window.clearTimeout(timeout);
      map.off('idle', onIdle);
      map.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onIdle = () => {
      if (!map.loaded() || !map.areTilesLoaded() || map.isMoving()) return;
      cleanup();
      requestAnimationFrame(() => resolve());
    };
    const onError = (event: maplibregl.ErrorEvent) => {
      if (isRecoverableOpenFreeMapResourceError(event.error)) return;
      cleanup();
      reject(new Error(`Online map resource failed: ${event.error?.message ?? 'unknown MapLibre error'}`));
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Online map tiles did not reach the required idle state within 30 seconds.'));
    }, ONLINE_MAP_READY_TIMEOUT_MS);
    map.on('idle', onIdle);
    map.on('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const waitForFinalRender = (map: MapLibreMap, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const cleanup = () => {
      map.off('render', onRender);
      signal?.removeEventListener('abort', onAbort);
    };
    const onRender = () => {
      if (!map.loaded() || !map.areTilesLoaded() || map.isMoving()) return;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    map.on('render', onRender);
    signal?.addEventListener('abort', onAbort, { once: true });
    map.triggerRepaint();
  });

export class OnlineMapFrameRenderer {
  private constructor(
    private readonly host: HTMLDivElement,
    private readonly map: MapLibreMap,
    private readonly logicalWidth: number,
    private readonly logicalHeight: number,
    private readonly width: number,
    private readonly height: number,
    private readonly pixelRatio: number,
    private readonly releaseLifecycle: () => void,
  ) {}

  private disposed = false;

  static async create(
    project: Project,
    width: number,
    height: number,
    styleId: OnlineBasemapStyleId,
    initialCamera: CameraState,
    signal?: AbortSignal,
    pixelRatio = ONLINE_EXPORT_PIXEL_RATIO,
    purpose: OnlineMapPurpose = 'export',
  ) {
    // Use the SAME canonical logical viewport as the interactive.
    const viewport = projectRenderViewport(project);
    const host = document.createElement('div');
    host.className = 'online-export-map';
    Object.assign(host.style, {
      position: 'fixed',
      left: `-${viewport.width + 100}px`,
      top: '0',
      width: `${viewport.width}px`,
      height: `${viewport.height}px`,
      overflow: 'hidden',
      pointerEvents: 'none',
    });
    document.body.append(host);
    const camera = mapMotionToMapLibreCamera(initialCamera);
    let map: MapLibreMap | undefined;
    let releaseLifecycle: (() => void) | undefined;
    try {
      if (requiresMapLibreRtl(project.mapSettings.labelLanguage)) await ensureMapLibreRtlSupport();
      map = new maplibregl.Map({
        container: host,
        style: openFreeMapStyleUrl(styleId),
        center: camera.center,
        zoom: camera.zoom,
        bearing: camera.bearing,
        pitch: camera.pitch,
        interactive: false,
        attributionControl: false,
        canvasContextAttributes: {
          antialias: ONLINE_EXPORT_ANTIALIAS,
          preserveDrawingBuffer: true,
        },
        pixelRatio,
        fadeDuration: 0,
        maxPitch: 85,
        minZoom: mapLibreMinimumZoom(),
        maxZoom: mapLibreMaximumZoom(),
        refreshExpiredTiles: false,
      });
      releaseLifecycle = registerOnlineMapInstance(purpose);
      map.resize();
      await waitForStyleAndApplyLabels(map, project.mapSettings.labelLanguage, signal);
      await waitForIdle(map, signal);
      await waitForFinalRender(map, signal);
      const canvas = map.getCanvas();
      const expectedWidth = Math.round(viewport.width * pixelRatio);
      const expectedHeight = Math.round(viewport.height * pixelRatio);
      if (Math.abs(canvas.width - expectedWidth) > 1 || Math.abs(canvas.height - expectedHeight) > 1)
        throw new Error(
          `Online export backing buffer is ${canvas.width}x${canvas.height}; expected ~${expectedWidth}x${expectedHeight} (tolerance exceeded).`,
        );
      return new OnlineMapFrameRenderer(
        host,
        map,
        viewport.width,
        viewport.height,
        width,
        height,
        pixelRatio,
        releaseLifecycle,
      );
    } catch (error) {
      try {
        map?.remove();
      } finally {
        releaseLifecycle?.();
        host.remove();
      }
      throw error;
    }
  }

  async render(camera: CameraState, destination: HTMLCanvasElement, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.map.resize();
    const resolvedCamera = mapMotionToMapLibreCamera(camera);
    this.map.jumpTo(resolvedCamera);
    if (import.meta.env.DEV) {
      const appliedCenter = this.map.getCenter();
      console.debug('[OpenFreeMap Export Camera Semantics]', {
        source: camera,
        jumpTo: resolvedCamera,
        resulting: {
          center: [appliedCenter.lng, appliedCenter.lat],
          zoom: this.map.getZoom(),
          bearing: this.map.getBearing(),
          pitch: this.map.getPitch(),
          padding: this.map.getPadding(),
        },
      });
    }
    await waitForIdle(this.map, signal);
    await waitForFinalRender(this.map, signal);
    signal?.throwIfAborted();
    const source = this.map.getCanvas();
    const expectedWidth = Math.round(this.logicalWidth * this.pixelRatio);
    const expectedHeight = Math.round(this.logicalHeight * this.pixelRatio);
    if (Math.abs(source.width - expectedWidth) > 1 || Math.abs(source.height - expectedHeight) > 1)
      throw new Error(
        `Online export backing buffer changed to ${source.width}x${source.height}; expected ~${expectedWidth}x${expectedHeight} (tolerance exceeded).`,
      );
    const context = destination.getContext('2d', { alpha: false });
    if (!context) throw new Error('Unable to create the online map frame canvas.');
    const drawStarted = performance.now();
    context.clearRect(0, 0, destination.width, destination.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, source.width, source.height, 0, 0, destination.width, destination.height);
    const fontSize = Math.max(10, Math.round(destination.height * 0.012));
    context.save();
    context.font = `500 ${fontSize}px Inter, sans-serif`;
    context.textAlign = 'right';
    context.textBaseline = 'bottom';
    const padding = Math.max(6, Math.round(fontSize * 0.55));
    const metrics = context.measureText(ONLINE_MAP_ATTRIBUTION);
    context.fillStyle = 'rgba(255, 255, 255, 0.82)';
    context.fillRect(
      destination.width - metrics.width - padding * 2,
      destination.height - fontSize - padding * 2,
      metrics.width + padding * 2,
      fontSize + padding * 2,
    );
    context.fillStyle = '#24303b';
    context.fillText(ONLINE_MAP_ATTRIBUTION, destination.width - padding, destination.height - padding);
    context.restore();
    const attributes = (source.getContext('webgl2') ?? source.getContext('webgl'))?.getContextAttributes();
    const diagnostics: OnlineMapFrameDiagnostics = {
      logicalWidth: this.logicalWidth,
      logicalHeight: this.logicalHeight,
      cssWidth: this.width,
      cssHeight: this.height,
      backingWidth: source.width,
      backingHeight: source.height,
      pixelRatio: this.map.getPixelRatio(),
      targetWidth: destination.width,
      targetHeight: destination.height,
      mapZoom: this.map.getZoom(),
      antialias: attributes?.antialias ?? false,
      preserveDrawingBuffer: attributes?.preserveDrawingBuffer ?? false,
      alpha: attributes?.alpha ?? false,
      premultipliedAlpha: attributes?.premultipliedAlpha ?? false,
      drawMs: performance.now() - drawStarted,
    };
    if (import.meta.env.DEV) console.info('[OpenFreeMap Export] frame diagnostics', diagnostics);
    return diagnostics;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.map.remove();
    this.host.remove();
    this.releaseLifecycle();
  }
}
