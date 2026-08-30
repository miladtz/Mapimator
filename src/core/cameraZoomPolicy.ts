import { CAMERA_SETTINGS, CAMERA_VIEWPORT, clamp, roundCamera } from './camera';
import type { BasemapRenderer, CameraState } from './project';

export interface CameraZoomRange {
  min: number;
  max: number;
}

export const MAPLIBRE_TILE_SIZE = 512;
export const MAPLIBRE_PRACTICAL_MAX_ZOOM = 22;
export const MAPLIBRE_ZOOM_OFFSET = Math.log2(CAMERA_VIEWPORT.width / MAPLIBRE_TILE_SIZE);
export const ONLINE_MAX_AUTHORED_ZOOM = Math.pow(2, MAPLIBRE_PRACTICAL_MAX_ZOOM - MAPLIBRE_ZOOM_OFFSET);

const LEGACY_ZOOM_RANGE: CameraZoomRange = {
  min: CAMERA_SETTINGS.minZoom,
  max: CAMERA_SETTINGS.maxZoom,
};
const ONLINE_ZOOM_RANGE: CameraZoomRange = {
  min: CAMERA_SETTINGS.minZoom,
  max: ONLINE_MAX_AUTHORED_ZOOM,
};

export const getCameraZoomRange = (renderer: BasemapRenderer): CameraZoomRange =>
  renderer === 'online' ? ONLINE_ZOOM_RANGE : LEGACY_ZOOM_RANGE;

export const mapMotionZoomToMapLibreZoom = (zoom: number) => Math.log2(zoom) + MAPLIBRE_ZOOM_OFFSET;

export const mapLibreZoomToMapMotionZoom = (zoom: number) => Math.pow(2, zoom - MAPLIBRE_ZOOM_OFFSET);

/** Renderer-safe projection only. It never mutates the authored camera. */
export const constrainCameraForRenderer = (camera: CameraState, renderer: BasemapRenderer): CameraState => {
  const range = getCameraZoomRange(renderer);
  const zoom = clamp(camera.zoom, range.min, range.max);
  const sourceZoom = Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : range.min;
  const centerX = (CAMERA_VIEWPORT.width / 2 - camera.x) / sourceZoom;
  const centerY = (CAMERA_VIEWPORT.height / 2 - camera.y) / sourceZoom;
  return roundCamera({
    ...camera,
    x: clamp(
      CAMERA_VIEWPORT.width / 2 - centerX * zoom,
      CAMERA_VIEWPORT.width - CAMERA_VIEWPORT.width * zoom,
      0,
    ),
    y: clamp(
      CAMERA_VIEWPORT.height / 2 - centerY * zoom,
      CAMERA_VIEWPORT.height - CAMERA_VIEWPORT.height * zoom,
      0,
    ),
    zoom,
  });
};

/** Changes scale while preserving the authored geographic center. */
export const cameraAtZoomForRenderer = (
  camera: CameraState,
  zoom: number,
  renderer: BasemapRenderer,
): CameraState => {
  const range = getCameraZoomRange(renderer);
  const nextZoom = clamp(zoom, range.min, range.max);
  const centerX = (CAMERA_VIEWPORT.width / 2 - camera.x) / camera.zoom;
  const centerY = (CAMERA_VIEWPORT.height / 2 - camera.y) / camera.zoom;
  return constrainCameraForRenderer(
    {
      ...camera,
      x: CAMERA_VIEWPORT.width / 2 - centerX * nextZoom,
      y: CAMERA_VIEWPORT.height / 2 - centerY * nextZoom,
      zoom: nextZoom,
    },
    renderer,
  );
};
