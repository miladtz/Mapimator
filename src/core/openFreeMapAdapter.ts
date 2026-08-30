import {
  CAMERA_VIEWPORT,
  clamp,
  constrainCamera,
  normalizeBearing,
  roundCamera,
  unwrapBearingNear,
} from './camera';
import type { CameraState, OnlineBasemapStyleId } from './project';

export const OPENFREEMAP_STYLES: ReadonlyArray<{
  id: OnlineBasemapStyleId;
  label: string;
  url: string;
}> = [
  { id: '3d', label: 'OpenFreeMap 3D', url: 'https://tiles.openfreemap.org/styles/liberty' },
  { id: 'liberty', label: 'Liberty', url: 'https://tiles.openfreemap.org/styles/liberty' },
  { id: 'dark', label: 'Dark', url: 'https://tiles.openfreemap.org/styles/dark' },
  { id: 'bright', label: 'Bright', url: 'https://tiles.openfreemap.org/styles/bright' },
];

export const openFreeMapStyleUrl = (styleId: OnlineBasemapStyleId) =>
  OPENFREEMAP_STYLES.find((style) => style.id === styleId)?.url ??
  OPENFREEMAP_STYLES.find((style) => style.id === 'liberty')!.url;

export const isRecoverableOpenFreeMapResourceError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /\/fonts\/.*\.pbf/i.test(message);
};

const MAX_MERCATOR_LATITUDE = 85.051129;
const MAPLIBRE_ZOOM_SCALE = 4;
export const MAPLIBRE_MAX_ZOOM = Math.log2(6) * MAPLIBRE_ZOOM_SCALE;

export const mapLibreMaximumZoom = () => MAPLIBRE_MAX_ZOOM;

const worldToLngLat = (x: number, y: number): [number, number] => [
  (x / CAMERA_VIEWPORT.width) * 360 - 180,
  clamp(90 - (y / CAMERA_VIEWPORT.height) * 180, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE),
];

const lngLatToWorld = (longitude: number, latitude: number) => ({
  x: ((longitude + 180) / 360) * CAMERA_VIEWPORT.width,
  y: ((90 - clamp(latitude, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE)) / 180) * CAMERA_VIEWPORT.height,
});

/** Canonical viewport-independent camera mapping. Both interactive and export use this. */
export const mapMotionToMapLibreCamera = (camera: CameraState) => {
  const normalized = constrainCamera(camera);
  const centerWorld = {
    x: (CAMERA_VIEWPORT.width / 2 - normalized.x) / normalized.zoom,
    y: (CAMERA_VIEWPORT.height / 2 - normalized.y) / normalized.zoom,
  };
  return {
    center: worldToLngLat(centerWorld.x, centerWorld.y),
    zoom: Math.log2(normalized.zoom) * MAPLIBRE_ZOOM_SCALE,
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
): CameraState => {
  const world = lngLatToWorld(center.lng, center.lat);
  const mapMotionZoom = clamp(Math.pow(2, zoom / MAPLIBRE_ZOOM_SCALE), 1, 6);
  return constrainCamera(
    roundCamera({
      x: CAMERA_VIEWPORT.width / 2 - world.x * mapMotionZoom,
      y: CAMERA_VIEWPORT.height / 2 - world.y * mapMotionZoom,
      zoom: mapMotionZoom,
      bearing: unwrapBearingNear(bearing, authoredBearing),
      pitch: clamp(pitch, 0, 85),
    }),
  );
};

/** Matches OpenFreeMap's official quick-start 3D presentation. */
export const OPENFREEMAP_3D_CAMERA = mapLibreToMapMotionCamera({ lng: -0.114, lat: 51.506 }, 9.5, 55.2, 60);
