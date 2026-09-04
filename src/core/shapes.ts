import type { Layer, SegmentLayerAnimation, ShapeKind, ShapePoint } from './project';
import { lngLatToMapMotionWorld, mapMotionWorldToLngLat } from './openFreeMapAdapter';

export type ShapeCoordinate = [number, number];
export const SHAPE_KM_PER_WORLD_UNIT = 40.075;
const EARTH_RADIUS_METERS = 6_378_137;

export const supportsDrawShape = (kind: ShapeKind | undefined): boolean => kind !== undefined;

export interface ShapeAppearOption {
  value: NonNullable<SegmentLayerAnimation['appearType']>;
  label: string;
}

const STANDARD_APPEAR_OPTIONS: readonly ShapeAppearOption[] = [
  { value: 'fade', label: 'Fade' },
  { value: 'pop', label: 'Pop' },
  { value: 'drop', label: 'Drop' },
];

const DRAW_SHAPE_OPTION: ShapeAppearOption = { value: 'draw-shape', label: 'Draw Shape' };

/** Final option list consumed by the real View/Transition Inspector selectors. */
export const getAppearOptionsForLayer = (
  layer: Pick<Layer, 'type' | 'shapeKind'>,
): readonly ShapeAppearOption[] =>
  layer.type === 'shape' && supportsDrawShape(layer.shapeKind)
    ? [...STANDARD_APPEAR_OPTIONS, DRAW_SHAPE_OPTION]
    : STANDARD_APPEAR_OPTIONS;

export const shapeWorldToMercatorMeters = (x: number, y: number): ShapeCoordinate => {
  const [longitude, latitude] = mapMotionWorldToLngLat(x, y);
  return [
    EARTH_RADIUS_METERS * ((longitude * Math.PI) / 180),
    EARTH_RADIUS_METERS * Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360)),
  ];
};

const mercatorMetersToWorld = (x: number, y: number) => {
  const longitude = (x / EARTH_RADIUS_METERS) * (180 / Math.PI);
  const latitude = (2 * Math.atan(Math.exp(y / EARTH_RADIUS_METERS)) - Math.PI / 2) * (180 / Math.PI);
  return lngLatToMapMotionWorld(longitude, latitude);
};

const localMetricPoint = (centerX: number, centerY: number, eastKm: number, southKm: number) => {
  const center = shapeWorldToMercatorMeters(centerX, centerY);
  return mercatorMetersToWorld(center[0] + eastKm * 1000, center[1] - southKm * 1000);
};

const point = (x: number, y: number): ShapePoint => ({ id: `shape-point-${crypto.randomUUID()}`, x, y });
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const createShapePoints = (kind: ShapeKind, x: number, y: number): ShapePoint[] => {
  if (kind === 'rectangle' || kind === 'ellipse') {
    const first = localMetricPoint(x, y, -500, -325);
    const second = localMetricPoint(x, y, 500, 325);
    return [point(first.x, first.y), point(second.x, second.y)];
  }
  if (kind === 'circle' || kind === 'square') {
    const first = localMetricPoint(x, y, -500, -500);
    const second = localMetricPoint(x, y, 500, 500);
    return [point(first.x, first.y), point(second.x, second.y)];
  }
  if (kind === 'triangle' || kind === 'regular-polygon') {
    const sides = kind === 'triangle' ? 3 : 5;
    return Array.from({ length: sides }, (_, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / sides;
      const vertex = localMetricPoint(x, y, Math.cos(angle) * 500, Math.sin(angle) * 500);
      return point(vertex.x, vertex.y);
    });
  }
  if (kind === 'polyline') return [point(x - 65, y + 25), point(x, y - 25), point(x + 65, y + 20)];
  if (kind === 'polygon') return [point(x, y - 55), point(x + 60, y + 38), point(x - 60, y + 38)];
  if (kind === 'free-draw')
    return [point(x - 65, y + 20), point(x - 25, y - 28), point(x + 10, y + 12), point(x + 65, y - 20)];
  if (kind === 'arrow') return [point(x - 35, y), point(x + 35, y)];
  return [point(x - 55, y - 35), point(x + 55, y + 35)];
};

export const createShapeLayerAt = (kind: ShapeKind, x: number, y: number): Layer => ({
  id: `shape-${crypto.randomUUID()}`,
  type: 'shape',
  name: kind === 'free-draw' ? 'Free Draw' : kind[0].toUpperCase() + kind.slice(1),
  visible: true,
  locked: false,
  opacity: 1,
  color: '#61c4e8',
  x,
  y,
  width: 110,
  height: 70,
  shapeKind: kind,
  shapePoints: createShapePoints(kind, x, y),
  shapeFillColor: '#61c4e8',
  shapeFillOpacity: kind === 'polyline' || kind === 'free-draw' ? 0 : 0.28,
  shapeStrokeColor: '#61c4e8',
  shapeStrokeOpacity: 1,
  shapeStrokeWidth: 3,
  shapeStrokeStyle: 'solid',
  shapeRoundness: 0,
  shapeRotation: 0,
  shapeArrowBodyWidth: 3,
  shapeArrowHeadWidth: 30,
  shapeArrowHeadLength: 32,
  shapeArrowBend: 0,
  shapeArrowHeadSize: 120,
  shapeArrowHeadAngle: 44,
  shapeArrowStartAngle: 0,
  shapeArrowheadEnabled: true,
  shapeWidthKm: 1000,
  shapeHeightKm: kind === 'square' || kind === 'circle' ? 1000 : 650,
  shapeRadiusKm: 500,
  shapeRegularSides: kind === 'triangle' ? 3 : 5,
});

export const moveShape = (layer: Layer, dx: number, dy: number): Layer => {
  const moved = { ...layer, x: layer.x + dx, y: layer.y + dy };
  if (
    ['rectangle', 'square', 'ellipse', 'circle', 'triangle', 'regular-polygon'].includes(
      layer.shapeKind ?? '',
    )
  )
    return resizeExactShape(moved, {});
  return {
    ...moved,
    shapePoints: layer.shapePoints?.map((item) => ({ ...item, x: item.x + dx, y: item.y + dy })),
  };
};

export const duplicateShapeIdentity = (layer: Layer): Layer => ({
  ...layer,
  shapePoints: layer.shapePoints?.map((item) => ({ ...item, id: `shape-point-${crypto.randomUUID()}` })),
});

export const editableShapePoints = (layer: Layer): ShapePoint[] => {
  const points = layer.shapePoints ?? [];
  return layer.shapeKind === 'arrow' && points.length > 2 ? [points[0], points[points.length - 1]] : points;
};

const dimensionsFromPoints = (points: readonly ShapePoint[]) => {
  const projected = points.map(({ x, y }) => shapeWorldToMercatorMeters(x, y));
  const xs = projected.map(([x]) => x);
  const ys = projected.map(([, y]) => y);
  const center = mercatorMetersToWorld(
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (Math.min(...ys) + Math.max(...ys)) / 2,
  );
  return {
    ...center,
    shapeWidthKm: (Math.max(...xs) - Math.min(...xs)) / 1000,
    shapeHeightKm: (Math.max(...ys) - Math.min(...ys)) / 1000,
  };
};

const regularPoints = (
  existing: readonly ShapePoint[],
  centerX: number,
  centerY: number,
  radiusKm: number,
  sides: number,
  rotation: number,
) =>
  Array.from({ length: sides }, (_, index) => {
    const angle = ((rotation - 90 + (index * 360) / sides) * Math.PI) / 180;
    const existingPoint = existing[index];
    return {
      id: existingPoint?.id ?? `shape-point-${crypto.randomUUID()}`,
      ...localMetricPoint(centerX, centerY, Math.cos(angle) * radiusKm, Math.sin(angle) * radiusKm),
    };
  });

export const resizeExactShape = (
  layer: Layer,
  updates: { widthKm?: number; heightKm?: number; radiusKm?: number; sides?: number; rotation?: number },
): Layer => {
  const kind = layer.shapeKind ?? 'rectangle';
  const x = layer.x;
  const y = layer.y;
  const rotation = updates.rotation ?? layer.shapeRotation ?? 0;
  if (kind === 'triangle' || kind === 'regular-polygon') {
    const sides =
      kind === 'triangle' ? 3 : clamp(Math.round(updates.sides ?? layer.shapeRegularSides ?? 5), 3, 64);
    const radiusKm = Math.max(0.001, updates.radiusKm ?? layer.shapeRadiusKm ?? 500);
    return {
      ...layer,
      shapeRotation: rotation,
      shapeRadiusKm: radiusKm,
      shapeRegularSides: sides,
      shapePoints: regularPoints(layer.shapePoints ?? [], x, y, radiusKm, sides, rotation),
    };
  }
  const squareLike = kind === 'square' || kind === 'circle';
  const widthKm = Math.max(0.001, updates.widthKm ?? layer.shapeWidthKm ?? 1000);
  const heightKm = squareLike ? widthKm : Math.max(0.001, updates.heightKm ?? layer.shapeHeightKm ?? 650);
  const first = localMetricPoint(x, y, -widthKm / 2, -heightKm / 2);
  const second = localMetricPoint(x, y, widthKm / 2, heightKm / 2);
  const ids = layer.shapePoints ?? [];
  return {
    ...layer,
    shapeRotation: rotation,
    shapeWidthKm: widthKm,
    shapeHeightKm: heightKm,
    shapeRadiusKm: kind === 'circle' ? widthKm / 2 : layer.shapeRadiusKm,
    shapePoints: [
      { id: ids[0]?.id ?? `shape-point-${crypto.randomUUID()}`, ...first },
      { id: ids[1]?.id ?? `shape-point-${crypto.randomUUID()}`, ...second },
    ],
  };
};

export const updateShapePoint = (layer: Layer, pointId: string, x: number, y: number): Layer => {
  const points = layer.shapePoints ?? [];
  const index = points.findIndex((item) => item.id === pointId);
  if (index < 0) return layer;
  const kind = layer.shapeKind ?? 'rectangle';
  if (kind === 'square' || kind === 'circle') {
    const opposite = points[index === 0 ? 1 : 0];
    const oppositeMetric = shapeWorldToMercatorMeters(opposite.x, opposite.y);
    const draggedMetric = shapeWorldToMercatorMeters(x, y);
    const extent = Math.max(
      Math.abs(draggedMetric[0] - oppositeMetric[0]),
      Math.abs(draggedMetric[1] - oppositeMetric[1]),
    );
    const constrainedMetric: ShapeCoordinate = [
      oppositeMetric[0] + Math.sign(draggedMetric[0] - oppositeMetric[0] || 1) * extent,
      oppositeMetric[1] + Math.sign(draggedMetric[1] - oppositeMetric[1] || 1) * extent,
    ];
    const constrained = mercatorMetersToWorld(...constrainedMetric);
    const next = points.map((item, pointIndex) =>
      pointIndex === index ? { ...item, ...constrained } : item,
    );
    const center = mercatorMetersToWorld(
      (oppositeMetric[0] + constrainedMetric[0]) / 2,
      (oppositeMetric[1] + constrainedMetric[1]) / 2,
    );
    const dimensionKm = extent / 1000;
    return {
      ...layer,
      ...center,
      shapeWidthKm: dimensionKm,
      shapeHeightKm: dimensionKm,
      shapeRadiusKm: kind === 'circle' ? dimensionKm / 2 : layer.shapeRadiusKm,
      shapePoints: next,
    };
  }
  if (kind === 'triangle' || kind === 'regular-polygon') {
    const center = shapeWorldToMercatorMeters(layer.x, layer.y);
    const dragged = shapeWorldToMercatorMeters(x, y);
    const dxKm = (dragged[0] - center[0]) / 1000;
    const dyKm = -(dragged[1] - center[1]) / 1000;
    const radiusKm = Math.max(0.001, Math.hypot(dxKm, dyKm));
    const rotation = (Math.atan2(dyKm, dxKm) * 180) / Math.PI + 90 - (index * 360) / points.length;
    return {
      ...layer,
      shapeRotation: rotation,
      shapeRadiusKm: radiusKm,
      shapePoints: regularPoints(points, layer.x, layer.y, radiusKm, points.length, rotation),
    };
  }
  const next = points.map((item) => (item.id === pointId ? { ...item, x, y } : item));
  return { ...layer, ...dimensionsFromPoints(next), shapePoints: next };
};

export const insertShapePoint = (layer: Layer, afterPointId: string): Layer => {
  if (layer.shapeKind === 'arrow') return layer;
  const points = layer.shapePoints ?? [];
  const index = points.findIndex((item) => item.id === afterPointId);
  if (index < 0 || points.length < 2) return layer;
  if (layer.shapeKind !== 'polygon' && index === points.length - 1) return layer;
  const next = points[(index + 1) % points.length];
  const inserted = point((points[index].x + next.x) / 2, (points[index].y + next.y) / 2);
  return { ...layer, shapePoints: [...points.slice(0, index + 1), inserted, ...points.slice(index + 1)] };
};

export const deleteShapePoint = (layer: Layer, pointId: string): Layer => {
  if (layer.shapeKind === 'arrow') return layer;
  const minimum = layer.shapeKind === 'polygon' ? 3 : 2;
  const points = layer.shapePoints ?? [];
  return points.length <= minimum
    ? layer
    : { ...layer, shapePoints: points.filter((item) => item.id !== pointId) };
};

export const simplifyShapePoints = (points: readonly ShapePoint[], tolerance = 1.5): ShapePoint[] => {
  if (points.length <= 2) return points.map((item) => ({ ...item }));
  const distanceToSegment = (candidate: ShapePoint, start: ShapePoint, end: ShapePoint) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const denominator = dx * dx + dy * dy || 1;
    const t = clamp(((candidate.x - start.x) * dx + (candidate.y - start.y) * dy) / denominator, 0, 1);
    return Math.hypot(candidate.x - (start.x + dx * t), candidate.y - (start.y + dy * t));
  };
  const reduce = (items: readonly ShapePoint[]): ShapePoint[] => {
    let furthest = 0;
    let furthestIndex = 0;
    for (let index = 1; index < items.length - 1; index += 1) {
      const distance = distanceToSegment(items[index], items[0], items[items.length - 1]);
      if (distance > furthest) {
        furthest = distance;
        furthestIndex = index;
      }
    }
    if (furthest <= tolerance) return [{ ...items[0] }, { ...items[items.length - 1] }];
    return [...reduce(items.slice(0, furthestIndex + 1)).slice(0, -1), ...reduce(items.slice(furthestIndex))];
  };
  return reduce(points);
};

export const roundedShapeCoordinates = (
  points: readonly ShapePoint[],
  roundness: number,
  closed: boolean,
): ShapeCoordinate[] => {
  const authored = points.map(({ x, y }): ShapeCoordinate => [x, y]);
  if (authored.length < 3 || roundness <= 0) return authored;
  const amount = clamp(roundness, 0, 100) / 100 / 3;
  const result: ShapeCoordinate[] = [];
  if (!closed) result.push(authored[0]);
  const start = closed ? 0 : 1;
  const end = closed ? authored.length : authored.length - 1;
  for (let index = start; index < end; index += 1) {
    const previous = authored[(index - 1 + authored.length) % authored.length];
    const current = authored[index];
    const next = authored[(index + 1) % authored.length];
    const incoming: ShapeCoordinate = [
      current[0] + (previous[0] - current[0]) * amount,
      current[1] + (previous[1] - current[1]) * amount,
    ];
    const outgoing: ShapeCoordinate = [
      current[0] + (next[0] - current[0]) * amount,
      current[1] + (next[1] - current[1]) * amount,
    ];
    result.push(incoming);
    for (let step = 1; step <= 4; step += 1) {
      const t = step / 4;
      const inverse = 1 - t;
      result.push([
        inverse * inverse * incoming[0] + 2 * inverse * t * current[0] + t * t * outgoing[0],
        inverse * inverse * incoming[1] + 2 * inverse * t * current[1] + t * t * outgoing[1],
      ]);
    }
  }
  if (!closed) result.push(authored[authored.length - 1]);
  return result;
};

const rotateAround = (
  coordinate: ShapeCoordinate,
  center: ShapeCoordinate,
  degrees: number,
): ShapeCoordinate => {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = coordinate[0] - center[0];
  const dy = coordinate[1] - center[1];
  return [center[0] + dx * cosine - dy * sine, center[1] + dx * sine + dy * cosine];
};

const ellipseCoordinates = (points: readonly ShapePoint[], rotation: number): ShapeCoordinate[] => {
  if (points.length < 2) return [];
  const first = shapeWorldToMercatorMeters(points[0].x, points[0].y);
  const second = shapeWorldToMercatorMeters(points[1].x, points[1].y);
  const center: ShapeCoordinate = [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2];
  const rx = Math.abs(second[0] - first[0]) / 2;
  const ry = Math.abs(second[1] - first[1]) / 2;
  return Array.from({ length: 49 }, (_, index) => {
    const angle = (index / 48) * Math.PI * 2;
    const rendered = rotateAround(
      [center[0] + Math.cos(angle) * rx, center[1] - Math.sin(angle) * ry],
      center,
      -rotation,
    );
    const world = mercatorMetersToWorld(...rendered);
    return [world.x, world.y];
  });
};

const rectangleCoordinates = (points: readonly ShapePoint[], rotation: number): ShapeCoordinate[] => {
  if (points.length < 2) return [];
  const first = shapeWorldToMercatorMeters(points[0].x, points[0].y);
  const second = shapeWorldToMercatorMeters(points[1].x, points[1].y);
  const center: ShapeCoordinate = [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2];
  return [
    [first[0], first[1]],
    [second[0], first[1]],
    [second[0], second[1]],
    [first[0], second[1]],
  ].map((item) => {
    const rendered = rotateAround(item as ShapeCoordinate, center, -rotation);
    const world = mercatorMetersToWorld(...rendered);
    return [world.x, world.y];
  });
};

export const arrowHeadCoordinates = (layer: Layer): ShapeCoordinate[] => {
  if (layer.shapeArrowheadEnabled === false) return [];
  if ((layer.shapePathProgress ?? 1) < 0.999) return [];
  const centerline = evaluatedShapeCoordinates(layer).coordinates;
  if (centerline.length < 2) return [];
  const tip = shapeWorldToMercatorMeters(...centerline.at(-1)!);
  const previous = shapeWorldToMercatorMeters(...centerline.at(-2)!);
  const length = Math.max(0.001, Math.hypot(tip[0] - previous[0], tip[1] - previous[1]));
  const tx = (tip[0] - previous[0]) / length;
  const ty = (tip[1] - previous[1]) / length;
  const headLength = Math.max(1, layer.shapeArrowHeadSize ?? layer.shapeArrowHeadLength ?? 120) * 1000;
  const halfWidth = Math.tan((clamp(layer.shapeArrowHeadAngle ?? 44, 10, 140) * Math.PI) / 360) * headLength;
  const base: ShapeCoordinate = [tip[0] - tx * headLength, tip[1] - ty * headLength];
  return (
    [
      tip,
      [base[0] - ty * halfWidth, base[1] + tx * halfWidth],
      [base[0] + ty * halfWidth, base[1] - tx * halfWidth],
    ] as ShapeCoordinate[]
  ).map((coordinate) => {
    const world = mercatorMetersToWorld(...coordinate);
    return [world.x, world.y];
  });
};

export const parabolicArrowCoordinates = (layer: Layer, samples = 65): ShapeCoordinate[] => {
  const points = layer.shapePoints ?? [];
  if (points.length < 2) return [];
  const start = shapeWorldToMercatorMeters(points[0].x, points[0].y);
  const endPoint = points.at(-1)!;
  const end = shapeWorldToMercatorMeters(endPoint.x, endPoint.y);
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const chordLength = Math.max(0.001, Math.hypot(dx, dy));
  const tx = dx / chordLength;
  const ty = dy / chordLength;
  const nx = -ty;
  const ny = tx;
  const slope = Math.tan((clamp(layer.shapeArrowStartAngle ?? 0, -80, 80) * Math.PI) / 180);
  const coefficient = -slope / chordLength;
  return Array.from({ length: Math.max(3, samples) }, (_, index) => {
    const localX = (index / (Math.max(3, samples) - 1)) * chordLength;
    const localY = coefficient * localX * localX + slope * localX;
    const world = mercatorMetersToWorld(
      start[0] + tx * localX + nx * localY,
      start[1] + ty * localX + ny * localY,
    );
    return [world.x, world.y];
  });
};

const deriveRenderedShapeCoordinates = (
  layer: Layer,
): { coordinates: ShapeCoordinate[]; closed: boolean } => {
  const kind = layer.shapeKind ?? 'rectangle';
  const points = layer.shapePoints ?? [
    { id: `${layer.id}-legacy-start`, x: layer.x, y: layer.y },
    {
      id: `${layer.id}-legacy-end`,
      x: layer.x2 ?? layer.x + (layer.width ?? 100),
      y: layer.y2 ?? layer.y + (layer.height ?? 55),
    },
  ];
  if (kind === 'arrow') {
    return { coordinates: parabolicArrowCoordinates({ ...layer, shapePoints: points }), closed: false };
  }
  if (kind === 'ellipse' || kind === 'circle')
    return { coordinates: ellipseCoordinates(points, layer.shapeRotation ?? 0), closed: true };
  if (kind === 'rectangle' || kind === 'square') {
    const rectangle = rectangleCoordinates(points, layer.shapeRotation ?? 0).map(([x, y], index) => ({
      id: `rectangle-${index}`,
      x,
      y,
    }));
    return { coordinates: roundedShapeCoordinates(rectangle, layer.shapeRoundness ?? 0, true), closed: true };
  }
  const closed = kind === 'polygon' || kind === 'triangle' || kind === 'regular-polygon';
  return { coordinates: roundedShapeCoordinates(points, layer.shapeRoundness ?? 0, closed), closed };
};

const renderedGeometryCache = new Map<string, { coordinates: ShapeCoordinate[]; closed: boolean }>();
export const renderedShapeCoordinates = (
  layer: Layer,
): { coordinates: ShapeCoordinate[]; closed: boolean } => {
  const signature = JSON.stringify([
    layer.id,
    layer.shapeKind,
    layer.shapePoints,
    layer.x,
    layer.y,
    layer.x2,
    layer.y2,
    layer.width,
    layer.height,
    layer.shapeRoundness,
    layer.shapeRotation,
    layer.shapeArrowBodyWidth,
    layer.shapeArrowHeadWidth,
    layer.shapeArrowHeadLength,
    layer.shapeArrowHeadSize,
    layer.shapeArrowHeadAngle,
    layer.shapeArrowStartAngle,
    layer.shapeArrowheadEnabled,
    layer.shapeArrowBend,
    layer.shapeWidthKm,
    layer.shapeHeightKm,
    layer.shapeRadiusKm,
    layer.shapeRegularSides,
  ]);
  const cached = renderedGeometryCache.get(signature);
  if (cached) return cached;
  const rendered = deriveRenderedShapeCoordinates(layer);
  if (renderedGeometryCache.size >= 256)
    renderedGeometryCache.delete(renderedGeometryCache.keys().next().value!);
  renderedGeometryCache.set(signature, rendered);
  return rendered;
};

export const shapePathPrefixByDistance = (
  coordinates: readonly ShapeCoordinate[],
  progress: number,
): ShapeCoordinate[] => {
  if (coordinates.length < 2 || progress >= 1) return coordinates.map((item) => [...item]);
  if (progress <= 0) return [];
  const metric = coordinates.map(([x, y]) => shapeWorldToMercatorMeters(x, y));
  const lengths = metric
    .slice(1)
    .map((item, index) => Math.hypot(item[0] - metric[index][0], item[1] - metric[index][1]));
  const target = lengths.reduce((sum, value) => sum + value, 0) * progress;
  const result: ShapeCoordinate[] = [[...coordinates[0]]];
  let traveled = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    if (traveled + lengths[index] <= target) {
      result.push([...coordinates[index + 1]]);
      traveled += lengths[index];
      continue;
    }
    const local = lengths[index] === 0 ? 0 : (target - traveled) / lengths[index];
    const projected: ShapeCoordinate = [
      metric[index][0] + (metric[index + 1][0] - metric[index][0]) * local,
      metric[index][1] + (metric[index + 1][1] - metric[index][1]) * local,
    ];
    const world = mercatorMetersToWorld(...projected);
    result.push([world.x, world.y]);
    break;
  }
  return result;
};

export const evaluatedShapeCoordinates = (layer: Layer) => {
  const rendered = renderedShapeCoordinates(layer);
  const progress = clamp(layer.shapePathProgress ?? 1, 0, 1);
  const scale = Math.max(0, layer.shapeAnimationScale ?? 1);
  const drop = layer.shapeDropOffsetY ?? 0;
  const center = shapeWorldToMercatorMeters(layer.x, layer.y);
  const transformed = rendered.coordinates.map(([x, y]): ShapeCoordinate => {
    if (scale === 1 && drop === 0) return [x, y];
    const metric = shapeWorldToMercatorMeters(x, y);
    const world = mercatorMetersToWorld(
      center[0] + (metric[0] - center[0]) * scale,
      center[1] + (metric[1] - center[1]) * scale + drop * 4000,
    );
    return [world.x, world.y];
  });
  const drawPath = rendered.closed && progress < 1 ? [...transformed, transformed[0]] : transformed;
  const coordinates = shapePathPrefixByDistance(drawPath, progress);
  return { coordinates, closed: rendered.closed && progress >= 0.999 };
};
