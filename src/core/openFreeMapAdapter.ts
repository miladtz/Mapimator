import { CAMERA_VIEWPORT, clamp, normalizeBearing, roundCamera, unwrapBearingNear } from './camera';
import {
  constrainCameraForRenderer,
  MAPLIBRE_PRACTICAL_MAX_ZOOM,
  MAPLIBRE_ZOOM_OFFSET,
  mapLibreZoomToMapMotionZoom,
  mapMotionZoomToMapLibreZoom,
} from './cameraZoomPolicy';
import type { CameraState, OnlineBasemapStyleId } from './project';
import type { LogicalViewport } from './projectRenderViewport';
import { BASEMAPS, basemapById, basemapStyle } from './basemaps';

/** @deprecated Use the provider-neutral BASEMAPS registry. */
export const OPENFREEMAP_STYLES = BASEMAPS.map((definition) => ({
  id: definition.id,
  label: definition.displayName,
  url: definition.styleSource.kind === 'vector-style-url' ? definition.styleSource.url : '',
}));

export const openFreeMapStyleUrl = (styleId: OnlineBasemapStyleId) => basemapStyle(basemapById(styleId));

export const isRecoverableOpenFreeMapResourceError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /\/fonts\/.*\.pbf/i.test(message);
};

const MAX_MERCATOR_LATITUDE = 85.051129;
export { MAPLIBRE_ZOOM_OFFSET, mapLibreZoomToMapMotionZoom, mapMotionZoomToMapLibreZoom };
export const MAPLIBRE_MIN_ZOOM = mapMotionZoomToMapLibreZoom(1);
export const MAPLIBRE_MAX_ZOOM = MAPLIBRE_PRACTICAL_MAX_ZOOM;

export const mapLibreWorldFitZoom = (viewport: Pick<LogicalViewport, 'width' | 'height'>) =>
  Math.log2(Math.min(viewport.width, viewport.height) / 512);
export const mapLibreMinimumZoom = (viewport?: Pick<LogicalViewport, 'width' | 'height'>) =>
  viewport ? mapLibreWorldFitZoom(viewport) : MAPLIBRE_MIN_ZOOM;
export const mapLibreMaximumZoom = () => MAPLIBRE_MAX_ZOOM;

export const mapMotionWorldToLngLat = (x: number, y: number): [number, number] => [
  (x / CAMERA_VIEWPORT.width) * 360 - 180,
  clamp(90 - (y / CAMERA_VIEWPORT.height) * 180, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE),
];

export const lngLatToMapMotionWorld = (longitude: number, latitude: number) => ({
  x: ((longitude + 180) / 360) * CAMERA_VIEWPORT.width,
  y: ((90 - clamp(latitude, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE)) / 180) * CAMERA_VIEWPORT.height,
});

/** Canonical viewport-independent camera mapping. Both interactive and export use this. */
export const mapMotionToMapLibreCamera = (
  camera: CameraState,
  viewport?: Pick<LogicalViewport, 'width' | 'height'>,
) => {
  const normalized = constrainCameraForRenderer(camera, 'online');
  const centerWorld = {
    x: (CAMERA_VIEWPORT.width / 2 - normalized.x) / normalized.zoom,
    y: (CAMERA_VIEWPORT.height / 2 - normalized.y) / normalized.zoom,
  };
  return {
    center: mapMotionWorldToLngLat(centerWorld.x, centerWorld.y),
    zoom: Math.log2(normalized.zoom) + (viewport ? mapLibreWorldFitZoom(viewport) : MAPLIBRE_ZOOM_OFFSET),
    bearing: normalizeBearing(normalized.bearing),
    pitch: clamp(normalized.pitch ?? 0, 0, 85),
  };
};

export const mapLibreToMapMotionCamera = (
  center: { lng: number; lat: number },
  zoom: number,
  bearing: number,
  pitch: number,
  authoredBearing = bearing,
  viewport?: Pick<LogicalViewport, 'width' | 'height'>,
): CameraState => {
  const world = lngLatToMapMotionWorld(center.lng, center.lat);
  const mapMotionZoom = Math.pow(
    2,
    zoom - (viewport ? mapLibreWorldFitZoom(viewport) : MAPLIBRE_ZOOM_OFFSET),
  );
  return constrainCameraForRenderer(
    roundCamera({
      x: CAMERA_VIEWPORT.width / 2 - world.x * mapMotionZoom,
      y: CAMERA_VIEWPORT.height / 2 - world.y * mapMotionZoom,
      zoom: mapMotionZoom,
      bearing: unwrapBearingNear(bearing, authoredBearing),
      pitch: clamp(pitch, 0, 85),
    }),
    'online',
  );
};

/** Matches OpenFreeMap's official quick-start 3D presentation. */
export const OPENFREEMAP_3D_CAMERA = mapLibreToMapMotionCamera({ lng: -0.114, lat: 51.506 }, 9.5, 55.2, 60);
