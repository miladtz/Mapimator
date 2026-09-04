import type {
  CustomRouteControlPoint,
  CustomRouteGeneratorSettings,
  CustomRoutePathShape,
  RoutePoint,
} from './project';
import { normalizeRouteLongitude, unwrapRouteLongitude } from './routes';

export const CUSTOM_ROUTE_GENERATOR_VERSION = 1 as const;
const MAX_LATITUDE = 85.051129;
const clampLatitude = (latitude: number) => Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, latitude));
const coordinate = (longitude: number, latitude: number): [number, number] => [
  normalizeRouteLongitude(longitude),
  clampLatitude(latitude),
];

export const createCustomRouteControlPoint = (
  longitude: number,
  latitude: number,
  id = `custom-control-${crypto.randomUUID()}`,
): CustomRouteControlPoint => ({
  id,
  longitude: normalizeRouteLongitude(longitude),
  latitude: clampLatitude(latitude),
});

export const customRouteSettings = (
  pathShape: CustomRoutePathShape = 'exact',
  controlPoints: readonly CustomRouteControlPoint[] = [],
): CustomRouteGeneratorSettings => ({
  version: CUSTOM_ROUTE_GENERATOR_VERSION,
  pathShape,
  controlPoints: controlPoints.map((point) => ({ ...point })),
});

export const customRouteAuthoredCoordinates = (
  start: RoutePoint,
  end: RoutePoint,
  controls: readonly CustomRouteControlPoint[],
) =>
  [
    coordinate(start.longitude, start.latitude),
    ...controls.map((point) => coordinate(point.longitude, point.latitude)),
    coordinate(end.longitude, end.latitude),
  ] as [number, number][];

const unwrapCoordinates = (coordinates: readonly (readonly number[])[]) => {
  let previous = coordinates[0]?.[0] ?? 0;
  return coordinates.map((point, index) => {
    const longitude =
      index === 0 ? normalizeRouteLongitude(point[0]) : unwrapRouteLongitude(point[0], previous);
    previous = longitude;
    return [longitude, clampLatitude(point[1])] as [number, number];
  });
};

const exactGeometry = (authored: readonly (readonly number[])[]) => {
  const points = unwrapCoordinates(authored);
  const output: [number, number][] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const samples = Math.max(
      1,
      Math.min(128, Math.ceil(Math.hypot(end[0] - start[0], end[1] - start[1]) / 2)),
    );
    if (index === 0) output.push([...start]);
    for (let sample = 1; sample <= samples; sample += 1) {
      const t = sample / samples;
      output.push([start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t]);
    }
  }
  return output;
};

const smoothGeometry = (authored: readonly (readonly number[])[]) => {
  const points = unwrapCoordinates(authored);
  if (points.length === 2) return exactGeometry(points);
  const output: [number, number][] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(points.length - 1, index + 2)];
    const samples = Math.max(8, Math.min(48, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 1.5)));
    for (let sample = index === 0 ? 0 : 1; sample <= samples; sample += 1) {
      const t = sample / samples;
      const t2 = t * t;
      const t3 = t2 * t;
      const longitude =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const latitude =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      output.push([
        Math.max(
          Math.min(p0[0], p1[0], p2[0], p3[0]),
          Math.min(Math.max(p0[0], p1[0], p2[0], p3[0]), longitude),
        ),
        clampLatitude(
          Math.max(
            Math.min(p0[1], p1[1], p2[1], p3[1]),
            Math.min(Math.max(p0[1], p1[1], p2[1], p3[1]), latitude),
          ),
        ),
      ]);
    }
  }
  return output;
};

/** Smooth uses deterministic Catmull-Rom interpolation through every authored point. */
export const generateCustomRouteGeometry = (
  start: RoutePoint,
  end: RoutePoint,
  settings: CustomRouteGeneratorSettings,
) => {
  const authored = customRouteAuthoredCoordinates(start, end, settings.controlPoints);
  return settings.pathShape === 'smooth' ? smoothGeometry(authored) : exactGeometry(authored);
};

export const moveCustomRouteControlPoint = (
  settings: CustomRouteGeneratorSettings,
  id: string,
  longitude: number,
  latitude: number,
) =>
  customRouteSettings(
    settings.pathShape,
    settings.controlPoints.map((point) =>
      point.id === id ? createCustomRouteControlPoint(longitude, latitude, point.id) : point,
    ),
  );

export const removeCustomRouteControlPoint = (settings: CustomRouteGeneratorSettings, id: string) =>
  customRouteSettings(
    settings.pathShape,
    settings.controlPoints.filter((point) => point.id !== id),
  );

export const insertCustomRouteControlPoint = (
  settings: CustomRouteGeneratorSettings,
  index: number,
  point: CustomRouteControlPoint,
) =>
  customRouteSettings(settings.pathShape, [
    ...settings.controlPoints.slice(0, Math.max(0, index)),
    point,
    ...settings.controlPoints.slice(Math.max(0, index)),
  ]);

/** Deterministically extracts a bounded editable control set from accepted provider geometry. */
export const customRouteSettingsFromGeometry = (
  geometry: readonly (readonly number[])[],
  maximumControls = 48,
) => {
  const intermediate = geometry.slice(1, -1);
  if (!intermediate.length) return customRouteSettings('exact');
  const stride = Math.max(1, Math.ceil(intermediate.length / maximumControls));
  const sampled = intermediate.filter((_, index) => index % stride === 0);
  if (sampled.at(-1) !== intermediate.at(-1)) sampled.push(intermediate.at(-1)!);
  return customRouteSettings(
    'exact',
    sampled
      .slice(0, maximumControls)
      .map((point, index) =>
        createCustomRouteControlPoint(point[0], point[1], `converted-control-${index + 1}`),
      ),
  );
};
