import { findCountry } from '../data/worldMap';
import type { CameraState, CanvasLayout, Layer, TransitionPreset, TransitionType } from './project';

export const CAMERA_VIEWPORT = { width: 1000, height: 560 };
export const CAMERA_FOV_DEGREES = 45;
export const CAMERA_FOCAL_LENGTH =
  CAMERA_VIEWPORT.height / 2 / Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360);

export const CAMERA_SETTINGS = {
  minZoom: 1,
  maxZoom: 6,
  zoomSpeed: 0.0019,
  wheelSmoothing: 0.24,
  panFriction: 0.88,
  edgeResistance: 0.22,
  keyboardStep: 46,
  animatedZoomMs: 280,
  fitPadding: 54,
};

export type CameraTransitionPreset = TransitionPreset;
export type CameraTransitionType = TransitionType;

/**
 * How strongly the zoom curve lags or leads the position curve.
 * Pan keeps translation dominant (zoom arrives later); Zoom lets the
 * zoom arrive first while the geographic center drifts smoothly.
 */
const PAN_ZOOM_LAG = 1.35;
const ZOOM_ZOOM_LEAD = 0.75;

/**
 * Fly To: lift out of the source camera, travel at a comfortable
 * altitude, then settle into the destination. The path is a deterministic
 * piecewise arc in log-zoom space with smoothstep joins, so both ends are
 * exact, the camera never overshoots, and there are no velocity jumps.
 */
const FLY_OUT_END = 0.3;
const FLY_IN_START = 0.7;
const FLY_CRUISE_FACTOR = 0.62;

const smoothstep01 = (t: number) => {
  const n = clamp(t, 0, 1);
  return n * n * (3 - 2 * n);
};

const expLerp = (a: number, b: number, t: number) => a * Math.pow(b / a, t);

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const normalizeBearing = (bearing = 0) => {
  const normalized = ((((bearing + 180) % 360) + 360) % 360) - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
};

export const interpolateBearing = (from: number | undefined, to: number | undefined, t: number) => {
  const start = normalizeBearing(from);
  const delta = normalizeBearing(normalizeBearing(to) - start);
  return normalizeBearing(start + delta * clamp(t, 0, 1));
};

const rotatePoint = (x: number, y: number, degrees: number) => {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return { x: x * cosine - y * sine, y: x * sine + y * cosine };
};

export interface CameraRay {
  origin: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
}

export interface MapPlanePoint {
  x: number;
  y: number;
}

const cameraPitch = (camera: CameraState) => clamp(camera.pitch ?? 0, -60, 60);

export const screenRay = (camera: CameraState, screenX: number, screenY: number): CameraRay => {
  const pitch = (cameraPitch(camera) * Math.PI) / 180;
  const sine = Math.sin(pitch);
  const cosine = Math.cos(pitch);
  const x = screenX - CAMERA_VIEWPORT.width / 2;
  const y = screenY - CAMERA_VIEWPORT.height / 2;
  return {
    origin: {
      x: 0,
      y: -CAMERA_FOCAL_LENGTH * sine,
      z: CAMERA_FOCAL_LENGTH * cosine,
    },
    direction: {
      x,
      y: CAMERA_FOCAL_LENGTH * sine + y * cosine,
      z: -CAMERA_FOCAL_LENGTH * cosine + y * sine,
    },
  };
};

export const intersectRayWithMapPlane = (ray: CameraRay): MapPlanePoint | null => {
  if (!Number.isFinite(ray.direction.z) || Math.abs(ray.direction.z) < 1e-9) return null;
  const distance = -ray.origin.z / ray.direction.z;
  if (!Number.isFinite(distance) || distance <= 0) return null;
  const x = ray.origin.x + ray.direction.x * distance;
  const y = ray.origin.y + ray.direction.y * distance;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
};

const screenToCameraPlane = (camera: CameraState, screenX: number, screenY: number) =>
  intersectRayWithMapPlane(screenRay(camera, screenX, screenY));

export const screenDeltaToNorthUp = (camera: CameraState, deltaX: number, deltaY: number) =>
  rotatePoint(deltaX, deltaY, -normalizeBearing(camera.bearing));

export const createWorldToScreenProjector = (camera: CameraState) => {
  const bearing = (normalizeBearing(camera.bearing) * Math.PI) / 180;
  const bearingCosine = Math.cos(bearing);
  const bearingSine = Math.sin(bearing);
  const pitchDegrees = cameraPitch(camera);
  const pitch = (pitchDegrees * Math.PI) / 180;
  const pitchCosine = Math.cos(pitch);
  const pitchSine = Math.sin(pitch);
  return (worldX: number, worldY: number) => {
    const northUpX = worldX * camera.zoom + camera.x - CAMERA_VIEWPORT.width / 2;
    const northUpY = worldY * camera.zoom + camera.y - CAMERA_VIEWPORT.height / 2;
    const rotatedX = northUpX * bearingCosine - northUpY * bearingSine;
    const rotatedY = northUpX * bearingSine + northUpY * bearingCosine;
    if (pitchDegrees === 0)
      return { x: rotatedX + CAMERA_VIEWPORT.width / 2, y: rotatedY + CAMERA_VIEWPORT.height / 2 };
    const depth = CAMERA_FOCAL_LENGTH + rotatedY * pitchSine;
    if (!Number.isFinite(depth) || depth <= 1e-6) return null;
    const perspective = CAMERA_FOCAL_LENGTH / depth;
    const x = CAMERA_VIEWPORT.width / 2 + rotatedX * perspective;
    const y = CAMERA_VIEWPORT.height / 2 + rotatedY * pitchCosine * perspective;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  };
};

export const projectWorldToScreen = (camera: CameraState, worldX: number, worldY: number) =>
  createWorldToScreenProjector(camera)(worldX, worldY);

export const unprojectScreenToWorld = (camera: CameraState, screenX: number, screenY: number) => {
  const plane = screenToCameraPlane(camera, screenX, screenY);
  if (!plane) return null;
  const northUp = rotatePoint(plane.x, plane.y, -normalizeBearing(camera.bearing));
  return {
    x: (northUp.x + CAMERA_VIEWPORT.width / 2 - camera.x) / camera.zoom,
    y: (northUp.y + CAMERA_VIEWPORT.height / 2 - camera.y) / camera.zoom,
  };
};

const northUpScreenPoint = (camera: CameraState, screenX: number, screenY: number) => {
  const plane = screenToCameraPlane(camera, screenX, screenY);
  if (!plane) return null;
  const point = rotatePoint(plane.x, plane.y, -normalizeBearing(camera.bearing));
  return { x: point.x + CAMERA_VIEWPORT.width / 2, y: point.y + CAMERA_VIEWPORT.height / 2 };
};

export const cameraForWorldAtScreen = (
  camera: CameraState,
  worldX: number,
  worldY: number,
  screenX: number,
  screenY: number,
): CameraState | null => {
  const northUp = northUpScreenPoint(camera, screenX, screenY);
  if (!northUp) return null;
  return roundCamera({
    ...camera,
    x: northUp.x - worldX * camera.zoom,
    y: northUp.y - worldY * camera.zoom,
  });
};

export const constrainCamera = (camera: CameraState): CameraState => {
  const zoom = clamp(camera.zoom, CAMERA_SETTINGS.minZoom, CAMERA_SETTINGS.maxZoom);
  const minX = CAMERA_VIEWPORT.width - CAMERA_VIEWPORT.width * zoom;
  const minY = CAMERA_VIEWPORT.height - CAMERA_VIEWPORT.height * zoom;
  return roundCamera({
    x: clamp(camera.x, minX, 0),
    y: clamp(camera.y, minY, 0),
    zoom,
    bearing: camera.bearing,
    pitch: camera.pitch,
  });
};

export const applyEdgeResistance = (camera: CameraState): CameraState => {
  const constrained = constrainCamera(camera);
  return roundCamera({
    x: constrained.x + (camera.x - constrained.x) * CAMERA_SETTINGS.edgeResistance,
    y: constrained.y + (camera.y - constrained.y) * CAMERA_SETTINGS.edgeResistance,
    zoom: constrained.zoom,
    bearing: camera.bearing,
    pitch: camera.pitch,
  });
};

export const zoomAtPoint = (
  camera: CameraState,
  viewportX: number,
  viewportY: number,
  delta: number,
): CameraState => {
  const adaptiveSpeed = CAMERA_SETTINGS.zoomSpeed * (0.76 + Math.log2(Math.max(1, camera.zoom)) * 0.16);
  const nextZoom = clamp(
    camera.zoom * Math.exp(-delta * adaptiveSpeed),
    CAMERA_SETTINGS.minZoom,
    CAMERA_SETTINGS.maxZoom,
  );
  const world = unprojectScreenToWorld(camera, viewportX, viewportY);
  const northUp = northUpScreenPoint(camera, viewportX, viewportY);
  if (!world || !northUp) return camera;
  return constrainCamera({
    x: northUp.x - world.x * nextZoom,
    y: northUp.y - world.y * nextZoom,
    zoom: nextZoom,
    bearing: camera.bearing,
    pitch: camera.pitch,
  });
};

export const easeCameraProgress = (t: number, preset: CameraTransitionPreset) => {
  const n = clamp(t, 0, 1);
  if (preset === 'linear') return n;
  if (preset === 'ease-in') return n * n * n;
  if (preset === 'ease-out') return 1 - Math.pow(1 - n, 3);
  if (preset === 'ease-in-out' || preset === 'cinematic')
    return n < 0.5 ? 4 * n * n * n : 1 - Math.pow(-2 * n + 2, 3) / 2;
  if (preset === 'bezier') return cubicBezierY(n, 0.16, 1, 0.3, 1);
  return n * n * (3 - 2 * n);
};

export const interpolateNumber = (a: number, b: number, t: number) => a + (b - a) * t;

export const flyToCamera = (
  from: CameraState,
  to: CameraState,
  progress: number,
  preset: CameraTransitionPreset,
): CameraState => {
  const t = clamp(progress, 0, 1);
  const position = easeCameraProgress(t, preset);
  const cruise = clamp(
    Math.min(from.zoom, to.zoom) * FLY_CRUISE_FACTOR,
    CAMERA_SETTINGS.minZoom,
    CAMERA_SETTINGS.maxZoom,
  );
  let zoom: number;
  if (t <= FLY_OUT_END) zoom = expLerp(from.zoom, cruise, smoothstep01(t / FLY_OUT_END));
  else if (t <= FLY_IN_START) zoom = cruise;
  else zoom = expLerp(cruise, to.zoom, smoothstep01((t - FLY_IN_START) / (1 - FLY_IN_START)));
  const orientation =
    from.bearing !== undefined ||
    to.bearing !== undefined ||
    from.pitch !== undefined ||
    to.pitch !== undefined
      ? {
          bearing: interpolateBearing(from.bearing, to.bearing, position),
          pitch: interpolateNumber(from.pitch ?? 0, to.pitch ?? 0, position),
        }
      : {};
  return roundCamera({
    x: interpolateNumber(from.x, to.x, position),
    y: interpolateNumber(from.y, to.y, position),
    zoom,
    ...orientation,
  });
};

export const interpolateCamera = (
  from: CameraState,
  to: CameraState,
  progress: number,
  preset: CameraTransitionPreset,
  type: CameraTransitionType = 'smooth',
): CameraState => {
  const t = clamp(progress, 0, 1);
  if (type === 'fly-to') return flyToCamera(from, to, t, preset);
  const position = easeCameraProgress(t, preset);
  let zoomProgress = position;
  if (type === 'pan') zoomProgress = Math.pow(position, PAN_ZOOM_LAG);
  else if (type === 'zoom') zoomProgress = Math.pow(position, ZOOM_ZOOM_LEAD);
  const zoom = from.zoom * Math.pow(to.zoom / from.zoom, zoomProgress);
  const orientation =
    from.bearing !== undefined ||
    to.bearing !== undefined ||
    from.pitch !== undefined ||
    to.pitch !== undefined
      ? {
          bearing: interpolateBearing(from.bearing, to.bearing, position),
          pitch: interpolateNumber(from.pitch ?? 0, to.pitch ?? 0, position),
        }
      : {};
  return roundCamera({
    x: interpolateNumber(from.x, to.x, position),
    y: interpolateNumber(from.y, to.y, position),
    zoom,
    ...orientation,
  });
};

export const fitWorldCamera = (): CameraState => ({ x: 0, y: 0, zoom: 1, bearing: 0, pitch: 0 });

export const roundCamera = (camera: CameraState): CameraState => ({
  x: round(camera.x, 8),
  y: round(camera.y, 8),
  zoom: round(camera.zoom, 10),
  ...(camera.bearing !== undefined ? { bearing: round(normalizeBearing(camera.bearing), 8) } : {}),
  ...(camera.pitch !== undefined ? { pitch: round(clamp(camera.pitch, -60, 60), 8) } : {}),
});

export const fitCountryCamera = (countryId: string): CameraState | null => {
  const country = findCountry(countryId);
  if (!country) return null;
  const bounds = pathBounds(country.path);
  return bounds ? fitBounds(bounds) : null;
};

export const fitLayersCamera = (layers: Layer[], fallback: CameraState): CameraState => {
  if (!layers.length) return fallback;
  const bounds = layers.map(layerBounds).filter((bounds): bounds is Bounds => bounds !== null);
  return bounds.length ? fitBounds(mergeBounds(bounds)) : fallback;
};

export const fitLayerCamera = (layer: Layer, fallback: CameraState): CameraState => {
  const bounds = layerBounds(layer);
  return bounds ? fitBounds(bounds) : fallback;
};

export const fitSelectionCamera = (layers: Layer[], selectedId: string | null, fallback: CameraState) => {
  const selected = layers.find((layer) => layer.id === selectedId);
  return selected ? fitLayerCamera(selected, fallback) : fitLayersCamera(layers, fallback);
};

export const autoReframeCamera = (
  layers: Layer[],
  current: CameraState,
  _layout: CanvasLayout,
): CameraState => fitLayersCamera(layers, current);

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const fitBounds = (bounds: Bounds): CameraState => {
  const paddedWidth = Math.max(1, bounds.maxX - bounds.minX + CAMERA_SETTINGS.fitPadding * 2);
  const paddedHeight = Math.max(1, bounds.maxY - bounds.minY + CAMERA_SETTINGS.fitPadding * 2);
  const zoom = clamp(
    Math.min(CAMERA_VIEWPORT.width / paddedWidth, CAMERA_VIEWPORT.height / paddedHeight),
    CAMERA_SETTINGS.minZoom,
    CAMERA_SETTINGS.maxZoom,
  );
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return constrainCamera({
    x: CAMERA_VIEWPORT.width / 2 - centerX * zoom,
    y: CAMERA_VIEWPORT.height / 2 - centerY * zoom,
    zoom,
  });
};

const layerBounds = (layer: Layer): Bounds | null => {
  if (layer.type === 'region' && layer.countryId) return pathBounds(findCountry(layer.countryId)?.path ?? '');
  if (layer.type === 'shape' || layer.type === 'image')
    return {
      minX: layer.x,
      minY: layer.y,
      maxX: layer.x + (layer.width ?? 0),
      maxY: layer.y + (layer.height ?? 0),
    };
  const radius = layer.type === 'geo-effect' ? (layer.effectSize ?? 44) : layer.type === 'text' ? 36 : 10;
  return {
    minX: Math.min(layer.x, layer.x2 ?? layer.x) - radius,
    minY: Math.min(layer.y, layer.y2 ?? layer.y) - radius,
    maxX: Math.max(layer.x, layer.x2 ?? layer.x) + radius,
    maxY: Math.max(layer.y, layer.y2 ?? layer.y) + radius,
  };
};

const mergeBounds = (bounds: Bounds[]): Bounds => ({
  minX: Math.min(...bounds.map((bound) => bound.minX)),
  minY: Math.min(...bounds.map((bound) => bound.minY)),
  maxX: Math.max(...bounds.map((bound) => bound.maxX)),
  maxY: Math.max(...bounds.map((bound) => bound.maxY)),
});

const pathBounds = (path: string): Bounds | null => {
  const numbers = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  if (numbers.length < 4) return null;
  const xs = numbers.filter((_, index) => index % 2 === 0);
  const ys = numbers.filter((_, index) => index % 2 === 1);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
};

const cubicBezierY = (t: number, x1: number, y1: number, x2: number, y2: number) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const sample = (a: number, b: number, u: number) =>
    3 * a * (1 - u) * (1 - u) * u + 3 * b * (1 - u) * u * u + u * u * u;
  let low = 0;
  let high = 1;
  let u = t;
  for (let index = 0; index < 8; index += 1) {
    u = (low + high) / 2;
    if (sample(x1, x2, u) < t) low = u;
    else high = u;
  }
  return sample(y1, y2, u);
};

const round = (value: number, decimals: number) => {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
};
