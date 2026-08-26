import { findCountry } from '../data/worldMap';
import type { CameraState, CanvasLayout, Layer, TransitionPreset, TransitionType } from './project';

export const CAMERA_VIEWPORT = { width: 1000, height: 560 };

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

export const constrainCamera = (camera: CameraState): CameraState => {
  const zoom = clamp(camera.zoom, CAMERA_SETTINGS.minZoom, CAMERA_SETTINGS.maxZoom);
  const minX = CAMERA_VIEWPORT.width - CAMERA_VIEWPORT.width * zoom;
  const minY = CAMERA_VIEWPORT.height - CAMERA_VIEWPORT.height * zoom;
  return roundCamera({
    x: clamp(camera.x, minX, 0),
    y: clamp(camera.y, minY, 0),
    zoom,
  });
};

export const applyEdgeResistance = (camera: CameraState): CameraState => {
  const constrained = constrainCamera(camera);
  return roundCamera({
    x: constrained.x + (camera.x - constrained.x) * CAMERA_SETTINGS.edgeResistance,
    y: constrained.y + (camera.y - constrained.y) * CAMERA_SETTINGS.edgeResistance,
    zoom: constrained.zoom,
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
  const worldX = (viewportX - camera.x) / camera.zoom;
  const worldY = (viewportY - camera.y) / camera.zoom;
  return constrainCamera({
    x: viewportX - worldX * nextZoom,
    y: viewportY - worldY * nextZoom,
    zoom: nextZoom,
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
  return roundCamera({
    x: interpolateNumber(from.x, to.x, position),
    y: interpolateNumber(from.y, to.y, position),
    zoom,
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
  return roundCamera({
    x: interpolateNumber(from.x, to.x, position),
    y: interpolateNumber(from.y, to.y, position),
    zoom,
  });
};

export const fitWorldCamera = (): CameraState => ({ x: 0, y: 0, zoom: 1 });

export const roundCamera = (camera: CameraState): CameraState => ({
  x: round(camera.x, 8),
  y: round(camera.y, 8),
  zoom: round(camera.zoom, 10),
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
