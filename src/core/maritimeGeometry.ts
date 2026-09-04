export type Coordinate = [number, number];
export type PolygonRings = Coordinate[][];

export const pointInRing = ([longitude, latitude]: Coordinate, ring: Coordinate[]) => {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x, y] = ring[index];
    const [previousX, previousY] = ring[previous];
    if (
      y > latitude !== previousY > latitude &&
      longitude < ((previousX - x) * (latitude - y)) / (previousY - y) + x
    )
      inside = !inside;
  }
  return inside;
};

/** OpenMapTiles water polygons retain interior rings: an island hole is land. */
export const pointInPolygon = (point: Coordinate, polygon: PolygonRings) =>
  Boolean(
    polygon[0]?.length &&
    pointInRing(point, polygon[0]) &&
    !polygon.slice(1).some((hole) => pointInRing(point, hole)),
  );

export const haversineMeters = (a: Coordinate, b: Coordinate) => {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeA = radians(a[1]);
  const latitudeB = radians(b[1]);
  const latitudeDelta = latitudeB - latitudeA;
  let longitudeDelta = radians(b[0] - a[0]);
  while (longitudeDelta > Math.PI) longitudeDelta -= Math.PI * 2;
  while (longitudeDelta < -Math.PI) longitudeDelta += Math.PI * 2;
  const value =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return 12_742_017.6 * Math.asin(Math.min(1, Math.sqrt(value)));
};

export const segmentIsWaterSafe = (
  start: Coordinate,
  end: Coordinate,
  isWater: (point: Coordinate) => boolean,
  spacingMeters = 30,
) => {
  const samples = Math.max(2, Math.ceil(haversineMeters(start, end) / spacingMeters));
  let longitudeDelta = end[0] - start[0];
  if (longitudeDelta > 180) longitudeDelta -= 360;
  if (longitudeDelta < -180) longitudeDelta += 360;
  for (let index = 1; index < samples; index += 1) {
    const amount = index / samples;
    const point: Coordinate = [start[0] + longitudeDelta * amount, start[1] + (end[1] - start[1]) * amount];
    if (!isWater(point)) return false;
  }
  return true;
};

export const geometryIsWaterSafe = (
  geometry: Coordinate[],
  isWater: (point: Coordinate) => boolean,
  endpointConnectorMeters = 1_500,
) => {
  const start = geometry[0];
  const end = geometry.at(-1)!;
  const isEndpointConnector = (point: Coordinate) =>
    haversineMeters(start, point) <= endpointConnectorMeters ||
    haversineMeters(end, point) <= endpointConnectorMeters;
  return (
    geometry.slice(1, -1).every((point) => isWater(point) || isEndpointConnector(point)) &&
    geometry.slice(0, -1).every((point, index) => {
      const next = geometry[index + 1];
      return (
        segmentIsWaterSafe(point, next, isWater) || (isEndpointConnector(point) && isEndpointConnector(next))
      );
    })
  );
};

export const findNearestWaterCoordinate = (
  point: Coordinate,
  isWater: (candidate: Coordinate) => boolean,
  cellDegrees = 0.0015,
  maxRadiusDegrees = 0.12,
): Coordinate => {
  if (isWater(point)) return point;
  const cells = Math.ceil(maxRadiusDegrees / cellDegrees);
  for (let radius = 1; radius <= cells; radius += 1) {
    for (let y = -radius; y <= radius; y += 1)
      for (let x = -radius; x <= radius; x += 1) {
        if (Math.abs(x) !== radius && Math.abs(y) !== radius) continue;
        const candidate: Coordinate = [point[0] + x * cellDegrees, point[1] + y * cellDegrees];
        if (isWater(candidate)) return candidate;
      }
  }
  throw new Error('No navigable water exists near the macro route point.');
};

export const densifyMaritimeGeometry = (geometry: Coordinate[], maxMeters = 800) =>
  geometry
    .slice(0, -1)
    .flatMap((start, index) => {
      const end = geometry[index + 1];
      const count = Math.max(1, Math.ceil(haversineMeters(start, end) / maxMeters));
      return Array.from({ length: count }, (_, step) => {
        const amount = step / count;
        return [
          start[0] + (end[0] - start[0]) * amount,
          start[1] + (end[1] - start[1]) * amount,
        ] as Coordinate;
      });
    })
    .concat([geometry.at(-1)!]);

/** Chaikin smoothing is accepted only when every resulting chord remains in water. */
export const smoothWaterSafe = (
  geometry: Coordinate[],
  isWater: (point: Coordinate) => boolean,
  passes = 2,
  endpointConnectorMeters = 0,
) => {
  let current = geometry;
  for (let pass = 0; pass < passes; pass += 1) {
    const candidate: Coordinate[] = [current[0]];
    for (let index = 0; index < current.length - 1; index += 1) {
      const a = current[index];
      const b = current[index + 1];
      candidate.push(
        [a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25],
        [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75],
      );
    }
    candidate.push(current.at(-1)!);
    if (geometryIsWaterSafe(candidate, isWater, endpointConnectorMeters)) current = candidate;
  }
  return current;
};

type Node = { x: number; y: number; g: number; f: number; parent?: string };
const keyOf = (x: number, y: number) => `${x}:${y}`;

/** Bounded 8-neighbour A* for one coastal macro chord. */
export const routeAroundLand = (
  start: Coordinate,
  end: Coordinate,
  isWater: (point: Coordinate) => boolean,
  cellDegrees = 0.0015,
  marginDegrees = 0.12,
): Coordinate[] => {
  if (segmentIsWaterSafe(start, end, isWater)) return [start, end];
  const west = Math.min(start[0], end[0]) - marginDegrees;
  const east = Math.max(start[0], end[0]) + marginDegrees;
  const south = Math.min(start[1], end[1]) - marginDegrees;
  const north = Math.max(start[1], end[1]) + marginDegrees;
  const width = Math.ceil((east - west) / cellDegrees) + 1;
  const height = Math.ceil((north - south) / cellDegrees) + 1;
  if (width * height > 180_000) throw new Error('Coastal correction corridor is too large.');
  const coordinateOf = (x: number, y: number): Coordinate => [
    west + x * cellDegrees,
    south + y * cellDegrees,
  ];
  const cellOf = ([longitude, latitude]: Coordinate) => ({
    x: Math.max(0, Math.min(width - 1, Math.round((longitude - west) / cellDegrees))),
    y: Math.max(0, Math.min(height - 1, Math.round((latitude - south) / cellDegrees))),
  });
  const nearestWater = (origin: { x: number; y: number }) => {
    for (let radius = 0; radius < Math.max(width, height); radius += 1)
      for (let y = Math.max(0, origin.y - radius); y <= Math.min(height - 1, origin.y + radius); y += 1)
        for (let x = Math.max(0, origin.x - radius); x <= Math.min(width - 1, origin.x + radius); x += 1)
          if (
            (Math.abs(x - origin.x) === radius || Math.abs(y - origin.y) === radius) &&
            isWater(coordinateOf(x, y))
          )
            return { x, y };
    throw new Error('No navigable water exists in the coastal correction corridor.');
  };
  const first = nearestWater(cellOf(start));
  const last = nearestWater(cellOf(end));
  const open = new Map<string, Node>();
  const nodes = new Map<string, Node>();
  const closed = new Set<string>();
  const startKey = keyOf(first.x, first.y);
  const startNode = { ...first, g: 0, f: Math.hypot(last.x - first.x, last.y - first.y) };
  open.set(startKey, startNode);
  nodes.set(startKey, startNode);
  let finish: Node | undefined;
  const directions = [-1, 0, 1]
    .flatMap((x) => [-1, 0, 1].map((y) => [x, y] as const))
    .filter(([x, y]) => x || y);
  while (open.size) {
    const current = [...open.values()].reduce((best, value) => (value.f < best.f ? value : best));
    const currentKey = keyOf(current.x, current.y);
    open.delete(currentKey);
    closed.add(currentKey);
    if (current.x === last.x && current.y === last.y) {
      finish = current;
      break;
    }
    for (const [dx, dy] of directions) {
      const x = current.x + dx,
        y = current.y + dy;
      const currentCoordinate = coordinateOf(current.x, current.y);
      const nextCoordinate = coordinateOf(x, y);
      if (
        x < 0 ||
        y < 0 ||
        x >= width ||
        y >= height ||
        !isWater(nextCoordinate) ||
        !segmentIsWaterSafe(currentCoordinate, nextCoordinate, isWater)
      )
        continue;
      const key = keyOf(x, y);
      if (closed.has(key)) continue;
      let coastPenalty = 0;
      for (const [nx, ny] of directions) if (!isWater(coordinateOf(x + nx, y + ny))) coastPenalty += 0.35;
      const g = current.g + Math.hypot(dx, dy) + coastPenalty;
      const known = open.get(key);
      if (known && known.g <= g) continue;
      const node = { x, y, g, f: g + Math.hypot(last.x - x, last.y - y), parent: currentKey };
      open.set(key, node);
      nodes.set(key, node);
    }
  }
  if (!finish) throw new Error('No water-connected path around the detailed coastline.');
  const reverse: Coordinate[] = [];
  let cursor: Node | undefined = finish;
  while (cursor) {
    reverse.push(coordinateOf(cursor.x, cursor.y));
    cursor = cursor.parent ? nodes.get(cursor.parent) : undefined;
  }
  const raw = [start, ...reverse.reverse(), end];
  const simplified: Coordinate[] = [raw[0]];
  let index = 0;
  while (index < raw.length - 1) {
    let next = raw.length - 1;
    while (next > index + 1 && !segmentIsWaterSafe(raw[index], raw[next], isWater)) next -= 1;
    if (!segmentIsWaterSafe(raw[index], raw[next], isWater))
      throw new Error('Detailed A* produced an unsafe adjacent edge.');
    simplified.push(raw[next]);
    index = next;
  }
  return simplified;
};
