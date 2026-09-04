import type {
  Layer,
  PathType,
  RouteDefaults,
  RouteGeometryMode,
  RouteRenderSegmentState,
  RouteSegment,
  RouteSegmentAnimation,
  RouteSegmentAppearance,
  RouteVehicleType,
  RoutePoint,
  SegmentLayerAnimation,
} from './project';

export const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
const EARTH_RADIUS_METERS = 6_371_008.8;
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const radians = (degrees: number) => (degrees * Math.PI) / 180;
const degrees = (value: number) => (value * 180) / Math.PI;
export const normalizeRouteLongitude = (longitude: number) => ((longitude + 540) % 360) - 180;
export const unwrapRouteLongitude = (longitude: number, reference: number) => {
  let value = normalizeRouteLongitude(longitude);
  while (value - reference > 180) value -= 360;
  while (value - reference < -180) value += 360;
  return value;
};

export const ROUTE_DEFAULTS: RouteDefaults = {
  lineColor: '#64d5ba',
  lineOpacity: 1,
  lineWidth: 4,
  lineStyle: 'solid',
  arrow: 'end',
};

export const PATH_TYPE_LABELS: Record<PathType, string> = {
  road: 'Road',
  maritime: 'Maritime',
  air: 'Air',
  custom: 'Custom',
};
/** @deprecated use PATH_TYPE_LABELS */
export const ROUTE_TRANSPORT_LABELS: Record<string, string> = PATH_TYPE_LABELS;

export const ROUTE_VEHICLE_LABELS: Record<RouteVehicleType, string> = {
  none: 'None',
  dot: 'Directional Dot',
  pulse: 'Pulse',
  arrow: 'Arrow Capsule',
  money: 'Capital / Money',
  package: 'Package / Logistics',
  person: 'Person / Migration',
  sedan: 'Sedan',
  suv: 'SUV',
  taxi: 'Taxi',
  pickup: 'Pickup',
  van: 'Van',
  bus: 'Bus',
  coach: 'Coach',
  'delivery-van': 'Delivery Van',
  'small-truck': 'Small Truck',
  'box-truck': 'Box Truck',
  'semi-truck': 'Semi Truck',
  'tanker-truck': 'Tanker Truck',
  motorcycle: 'Motorcycle',
  'passenger-train': 'Passenger Train',
  'high-speed-train': 'High-speed Train',
  'commuter-train': 'Commuter Train',
  metro: 'Metro',
  'freight-train': 'Freight Train',
  'passenger-plane': 'Passenger Plane',
  'cargo-plane': 'Cargo Plane',
  'private-jet': 'Private Jet',
  'small-plane': 'Small Plane',
  helicopter: 'Helicopter',
  ferry: 'Ferry',
  'small-boat': 'Small Boat',
  yacht: 'Yacht',
  'container-ship': 'Container Ship',
  'cargo-ship': 'Cargo Ship',
  'cargo-vessel': 'Cargo Vessel',
  tanker: 'Tanker',
  'bulk-carrier': 'Bulk Carrier',
  'oil-tanker': 'Oil Tanker',
  'lng-carrier': 'LNG Carrier',
  'cruise-ship': 'Cruise Ship',
  speedboat: 'Speedboat',
  sailboat: 'Sailboat',
  'directional-capsule': 'Directional Capsule',
  custom: 'Custom Vehicle Image',
};

export const ROUTE_VEHICLE_GROUPS: ReadonlyArray<{
  label: 'Road' | 'Air' | 'Marine' | 'Abstract';
  vehicles: readonly RouteVehicleType[];
}> = [
  {
    label: 'Road',
    vehicles: [
      'sedan',
      'suv',
      'taxi',
      'pickup',
      'van',
      'delivery-van',
      'bus',
      'coach',
      'small-truck',
      'box-truck',
      'semi-truck',
      'tanker-truck',
      'motorcycle',
      'passenger-train',
      'high-speed-train',
      'commuter-train',
      'metro',
      'freight-train',
    ],
  },
  { label: 'Air', vehicles: ['passenger-plane', 'cargo-plane', 'private-jet', 'small-plane', 'helicopter'] },
  {
    label: 'Marine',
    vehicles: [
      'container-ship',
      'cargo-ship',
      'cargo-vessel',
      'bulk-carrier',
      'oil-tanker',
      'lng-carrier',
      'ferry',
      'cruise-ship',
      'small-boat',
      'speedboat',
      'yacht',
      'sailboat',
      'tanker',
    ],
  },
  {
    label: 'Abstract',
    vehicles: ['dot', 'pulse', 'arrow', 'directional-capsule', 'package', 'person', 'money'],
  },
];

/** Map a PathType to a sensible default vehicle for rendering. */
export const defaultVehicleForPathType = (pathType: PathType): RouteVehicleType => {
  if (pathType === 'air') return 'passenger-plane';
  if (pathType === 'maritime') return 'container-ship';
  if (pathType === 'road') return 'sedan';
  return 'directional-capsule';
};
/** @deprecated use defaultVehicleForPathType */
export const defaultVehicleForMode = (pathType: string): RouteVehicleType =>
  defaultVehicleForPathType(pathType as PathType);

/** True when the geometry is computed locally (not by an external routing provider). */
export const pathTypeSupportsGeneratedGeometry = (pathType: PathType) =>
  pathType === 'air' || pathType === 'custom';
/** @deprecated use pathTypeSupportsGeneratedGeometry */
export const routeModeSupportsGeneratedGeometry = (mode: string) => mode === 'air' || mode === 'custom';

export const pathTypeAvailability = (pathType: PathType) => {
  if (pathType === 'air') return { automatic: true, label: 'Geodesic air route' };
  if (pathType === 'road') return { automatic: true, label: 'OpenRouteService real roads' };
  if (pathType === 'maritime') return { automatic: true, label: 'Built-in Maritime offline' };
  return { automatic: false, label: 'Custom Path' };
};
/** @deprecated use pathTypeAvailability */
export const routeModeAvailability = (mode: string) => pathTypeAvailability(mode as PathType);

export const createRoutePoint = (
  longitude: number,
  latitude: number,
  name?: string,
  source?: Pick<RoutePoint, 'searchResultId' | 'pinLayerId'>,
): RoutePoint => ({
  id: `route-waypoint-${crypto.randomUUID()}`,
  longitude: normalizeRouteLongitude(longitude),
  latitude: clamp(latitude, -WEB_MERCATOR_MAX_LATITUDE, WEB_MERCATOR_MAX_LATITUDE),
  ...(name ? { name } : {}),
  ...source,
});

export const haversineDistanceMeters = (a: readonly number[], b: readonly number[]) => {
  const lat1 = radians(a[1]);
  const lat2 = radians(b[1]);
  const deltaLat = lat2 - lat1;
  const deltaLon = radians(unwrapRouteLongitude(b[0], a[0]) - a[0]);
  const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
};

const unitVector = (point: readonly number[]) => {
  const longitude = radians(point[0]);
  const latitude = radians(point[1]);
  const cosLatitude = Math.cos(latitude);
  return [cosLatitude * Math.cos(longitude), cosLatitude * Math.sin(longitude), Math.sin(latitude)];
};

export const greatCircleGeometry = (
  start: readonly number[],
  end: readonly number[],
  sampleCount?: number,
): [number, number][] => {
  const a = unitVector(start);
  const b = unitVector(end);
  const dot = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
  const omega = Math.acos(dot);
  const count = sampleCount ?? Math.max(8, Math.min(128, Math.ceil(degrees(omega) / 2.5)));
  const sinOmega = Math.sin(omega);
  const output: [number, number][] = [];
  let previousLongitude = start[0];
  for (let index = 0; index <= count; index += 1) {
    const t = index / count;
    let x: number;
    let y: number;
    let z: number;
    if (sinOmega < 1e-8) {
      x = a[0] + (b[0] - a[0]) * t;
      y = a[1] + (b[1] - a[1]) * t;
      z = a[2] + (b[2] - a[2]) * t;
    } else {
      const left = Math.sin((1 - t) * omega) / sinOmega;
      const right = Math.sin(t * omega) / sinOmega;
      x = a[0] * left + b[0] * right;
      y = a[1] * left + b[1] * right;
      z = a[2] * left + b[2] * right;
    }
    const length = Math.hypot(x, y, z) || 1;
    const longitude = unwrapRouteLongitude(degrees(Math.atan2(y / length, x / length)), previousLongitude);
    previousLongitude = longitude;
    output.push([
      longitude,
      clamp(degrees(Math.asin(z / length)), -WEB_MERCATOR_MAX_LATITUDE, WEB_MERCATOR_MAX_LATITUDE),
    ]);
  }
  return output;
};

export const curvedFlowGeometry = (
  start: readonly number[],
  end: readonly number[],
  curvature = 0.22,
  sampleCount = 48,
): [number, number][] => {
  const endLongitude = unwrapRouteLongitude(end[0], start[0]);
  const dx = endLongitude - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy) || 1;
  const bend = clamp(curvature, -1, 1) * Math.min(40, length * 0.45);
  const control: [number, number] = [
    (start[0] + endLongitude) / 2 - (dy / length) * bend,
    clamp(
      (start[1] + end[1]) / 2 + (dx / length) * bend,
      -WEB_MERCATOR_MAX_LATITUDE,
      WEB_MERCATOR_MAX_LATITUDE,
    ),
  ];
  return Array.from({ length: sampleCount + 1 }, (_, index) => {
    const t = index / sampleCount;
    const u = 1 - t;
    return [
      u * u * start[0] + 2 * u * t * control[0] + t * t * endLongitude,
      u * u * start[1] + 2 * u * t * control[1] + t * t * end[1],
    ];
  });
};

export const straightRouteGeometry = (
  start: readonly number[],
  end: readonly number[],
): [number, number][] => [
  [start[0], start[1]],
  [unwrapRouteLongitude(end[0], start[0]), end[1]],
];

export const buildRouteGeometry = (
  start: RoutePoint,
  end: RoutePoint,
  pathType: PathType,
  geometryMode?: RouteGeometryMode,
  curvature = 0.22,
) => {
  const selected =
    geometryMode ??
    (pathType === 'custom'
      ? 'custom'
      : pathType === 'air'
        ? 'great-circle'
        : pathType === 'maritime'
          ? 'great-circle'
          : 'provider');
  if (selected === 'great-circle')
    return greatCircleGeometry([start.longitude, start.latitude], [end.longitude, end.latitude]);
  if (selected === 'curved')
    return curvedFlowGeometry([start.longitude, start.latitude], [end.longitude, end.latitude], curvature);
  return straightRouteGeometry([start.longitude, start.latitude], [end.longitude, end.latitude]);
};

export const createRouteSegment = (
  start: RoutePoint,
  end: RoutePoint,
  pathType: PathType = 'air',
): RouteSegment => {
  const generated = pathTypeSupportsGeneratedGeometry(pathType);
  const geometryMode: RouteGeometryMode =
    pathType === 'custom' ? 'custom' : generated ? 'great-circle' : 'provider';
  const geometry = buildRouteGeometry(start, end, pathType, geometryMode);
  return {
    id: `route-segment-${crypto.randomUUID()}`,
    startPointId: start.id,
    endPointId: end.id,
    pathType,
    mode: pathType as any,
    geometryMode,
    geometrySource: generated ? 'generated' : 'custom',
    geometry,
    curvature: pathType === 'custom' ? 0.22 : 0,
    estimatedDistanceMeters: pathDistanceMeters(geometry),
    routingStatus: generated ? 'ready' : 'custom',
    appearance: { ...ROUTE_DEFAULTS },
  };
};

export const routeNameFromPoints = (waypoints: readonly RoutePoint[]) =>
  waypoints.map((point, index) => point.name?.trim() || `Point ${index + 1}`).join(' → ');

export const createRouteLayer = (waypoints: readonly RoutePoint[]): Layer => {
  const canonical = waypoints.map((waypoint) => ({ ...waypoint }));
  const segments = canonical
    .slice(0, -1)
    .map((waypoint, index) => createRouteSegment(waypoint, canonical[index + 1]));
  const first = canonical[0] ?? createRoutePoint(0, 0);
  return {
    id: `route-${crypto.randomUUID()}`,
    type: 'route',
    name: routeNameFromPoints(canonical) || 'Route',
    visible: true,
    locked: false,
    opacity: 1,
    color: ROUTE_DEFAULTS.lineColor,
    x: first.longitude,
    y: first.latitude,
    routePoints: canonical,
    routeSegments: segments,
    routeDefaults: { ...ROUTE_DEFAULTS },
  };
};

export const appendRoutePoint = (layer: Layer, waypoint: RoutePoint): Layer => {
  const routeWaypoints = [...(layer.routePoints ?? []), { ...waypoint }];
  const previous = routeWaypoints.at(-2);
  const routeSegments = [
    ...(layer.routeSegments ?? []),
    ...(previous ? [createRouteSegment(previous, waypoint)] : []),
  ];
  return { ...layer, routePoints: routeWaypoints, routeSegments, name: routeNameFromPoints(routeWaypoints) };
};

export const routeGeographicBounds = (layer: Layer) => {
  const geometries = (layer.routeSegments ?? []).flatMap((segment) => segment.geometry);
  const points = geometries.length
    ? geometries
    : (layer.routePoints ?? []).map((waypoint) => [waypoint.longitude, waypoint.latitude]);
  if (!points.length) return undefined;
  let previous = points[0][0];
  const unwrapped = points.map((point) => {
    previous = unwrapRouteLongitude(point[0], previous);
    return [previous, point[1]] as [number, number];
  });
  return unwrapped.reduce(
    (bounds, point) => ({
      west: Math.min(bounds.west, point[0]),
      south: Math.min(bounds.south, point[1]),
      east: Math.max(bounds.east, point[0]),
      north: Math.max(bounds.north, point[1]),
    }),
    { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity },
  );
};

export const resolveRouteAppearance = (layer: Layer, segment: RouteSegment): RouteDefaults => ({
  ...ROUTE_DEFAULTS,
  ...(layer.routeDefaults ?? {}),
  ...(segment.appearance ?? {}),
});

const routePathMetricCache = new WeakMap<object, { cumulative: number[]; total: number }>();
export const routePathMetrics = (geometry: readonly (readonly number[])[]) => {
  const cached = routePathMetricCache.get(geometry);
  if (cached) return cached;
  const cumulative = [0];
  for (let index = 1; index < geometry.length; index += 1)
    cumulative.push(cumulative[index - 1] + haversineDistanceMeters(geometry[index - 1], geometry[index]));
  const metrics = { cumulative, total: cumulative.at(-1) ?? 0 };
  routePathMetricCache.set(geometry, metrics);
  return metrics;
};
export const pathDistanceMeters = (geometry: readonly (readonly number[])[]) =>
  routePathMetrics(geometry).total;

export const routePositionAtProgress = (geometry: readonly (readonly number[])[], progress: number) => {
  if (geometry.length === 0) return { coordinate: [0, 0] as [number, number], bearing: 0 };
  if (geometry.length === 1)
    return { coordinate: [geometry[0][0], geometry[0][1]] as [number, number], bearing: 0 };
  const { cumulative, total } = routePathMetrics(geometry);
  const target = clamp(progress) * total;
  let index = cumulative.findIndex((distance) => distance >= target);
  if (index <= 0) index = 1;
  const start = geometry[index - 1];
  const end = geometry[index];
  const span = Math.max(1e-9, cumulative[index] - cumulative[index - 1]);
  const t = clamp((target - cumulative[index - 1]) / span);
  const endLongitude = unwrapRouteLongitude(end[0], start[0]);
  const coordinate: [number, number] = [
    start[0] + (endLongitude - start[0]) * t,
    start[1] + (end[1] - start[1]) * t,
  ];
  const longitudeDelta = radians(endLongitude - start[0]);
  const lat1 = radians(start[1]);
  const lat2 = radians(end[1]);
  const y = Math.sin(longitudeDelta) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(longitudeDelta);
  return { coordinate, bearing: (degrees(Math.atan2(y, x)) + 360) % 360 };
};

export const routePrefixGeometry = (
  geometry: readonly (readonly number[])[],
  progress: number,
): [number, number][] => {
  if (geometry.length < 2 || progress <= 0) return [];
  if (progress >= 1) return geometry.map((point) => [point[0], point[1]]);
  const { cumulative, total } = routePathMetrics(geometry);
  const target = clamp(progress) * total;
  let index = cumulative.findIndex((distance) => distance >= target);
  if (index <= 0) index = 1;
  const output = geometry.slice(0, index).map((point) => [point[0], point[1]] as [number, number]);
  output.push(routePositionAtProgress(geometry, progress).coordinate);
  return output;
};

const timedProgress = (
  time: number,
  enabled: boolean | undefined,
  delay: number | undefined,
  duration: number | undefined,
) => {
  if (!enabled) return 1;
  const start = Math.max(0, delay ?? 0);
  const length = Math.max(0, duration ?? 1.5);
  if (length === 0) return time >= start ? 1 : 0;
  return clamp((time - start) / length);
};

const MAX_SIMULTANEOUS_ROUTE_VEHICLES = 512;
/** Pure seek-safe launch evaluation. No retained spawn state or frame history. */
export const evaluateRouteVehicleInstances = (
  sectionId: string,
  timing: RouteSegmentAnimation,
  segmentLocalTime: number,
) => {
  if (!timing.vehicleEnabled) return [];
  const delay = Math.max(0, timing.vehicleDelay ?? timing.drawDelay ?? 0);
  if (segmentLocalTime < delay) return [];
  const duration = Math.max(0, timing.vehicleDuration ?? timing.drawDuration ?? 1.5);
  if (!timing.vehicleRepetitive)
    return [
      {
        id: `${sectionId}-vehicle-0`,
        progress: duration === 0 ? 1 : clamp((segmentLocalTime - delay) / duration),
      },
    ];
  const interval = Math.max(0.05, timing.vehicleInterval ?? 1);
  const traversalDuration = Math.max(0.05, duration);
  const latest = Math.floor((segmentLocalTime - delay) / interval);
  const earliest = Math.max(0, Math.floor((segmentLocalTime - delay - traversalDuration) / interval) + 1);
  const boundedEarliest = Math.max(earliest, latest - MAX_SIMULTANEOUS_ROUTE_VEHICLES + 1);
  return Array.from({ length: Math.max(0, latest - boundedEarliest + 1) }, (_, offset) => {
    const launchIndex = boundedEarliest + offset;
    return {
      id: `${sectionId}-vehicle-${launchIndex}`,
      progress: clamp((segmentLocalTime - (delay + launchIndex * interval)) / traversalDuration),
    };
  });
};

export const evaluateRouteRenderState = (
  layer: Layer,
  animation: SegmentLayerAnimation | undefined,
  segmentLocalTime: number,
): RouteRenderSegmentState[] =>
  (layer.routeSegments ?? []).map((segment) => {
    const timing: RouteSegmentAnimation = {
      ...(animation?.routeDefaults ?? {}),
      ...(animation?.routeSegmentAnimations?.[segment.id] ?? {}),
    };
    const exists = timing.included ?? true;
    const appearEnabled = timing.appearEnabled ?? timing.drawEnabled ?? false;
    const appearType = timing.appearType ?? (timing.drawEnabled ? 'draw-route' : 'fade');
    const appearProgress = timedProgress(
      segmentLocalTime,
      appearEnabled,
      timing.appearDelay ?? timing.drawDelay,
      timing.appearDuration ?? timing.drawDuration,
    );
    const drawProgress =
      exists && appearEnabled && appearType === 'draw-route' ? appearProgress : exists ? 1 : 0;
    const opacityMultiplier =
      exists && (!appearEnabled || appearType === 'draw-route') ? 1 : exists ? appearProgress : 0;
    const hasVehicleTiming = Boolean(timing.vehicleEnabled || timing.drawEnabled);
    const vehicleProgress = !hasVehicleTiming
      ? 0
      : timing.vehicleFollowsDraw !== false
        ? drawProgress
        : timedProgress(segmentLocalTime, timing.vehicleEnabled, timing.vehicleDelay, timing.vehicleDuration);
    const wipeProgress = timedProgress(
      segmentLocalTime,
      timing.wipeEnabled ?? timing.routeWipeEnabled,
      timing.wipeDelay ?? timing.routeWipeDelay,
      timing.wipeDuration ?? timing.routeWipeDuration,
    );
    const wipe = timing.wipeEnabled || timing.routeWipeEnabled ? wipeProgress : 0;
    const vehicleInstances =
      exists && wipe < 1 ? evaluateRouteVehicleInstances(segment.id, timing, segmentLocalTime) : [];
    return {
      segmentId: segment.id,
      exists,
      opacityMultiplier,
      drawProgress,
      wipeProgress: wipe,
      // An enabled vehicle remains visible at its destination after movement
      // completes. Previously progress === 1 removed it for the rest of the
      // View/Transition, including most inspected and exported frames.
      vehicleVisible: vehicleInstances.length > 0,
      vehicleProgress: vehicleInstances[0]?.progress ?? vehicleProgress,
      vehicleType: timing.vehicleType ?? 'directional-capsule',
      vehicleSize: timing.vehicleSize ?? 22,
      vehicleOpacity: timing.vehicleOpacity ?? 1,
      vehicleColor: timing.vehicleColor ?? '#ffffff',
      vehicleAccentColor: timing.vehicleAccentColor ?? '#64d5ba',
      vehicleOrientationOffset: timing.vehicleOrientationOffset ?? 0,
      vehicleFollowDirection: timing.vehicleFollowDirection ?? true,
      vehicleAssetId: timing.vehicleAssetId,
      vehicleInstances,
    };
  });

export const applyRouteEvaluation = (
  layer: Layer,
  animation: SegmentLayerAnimation | undefined,
  segmentLocalTime: number,
) => {
  layer.routeRenderState = evaluateRouteRenderState(layer, animation, segmentLocalTime);
};

export const reverseRouteLayer = (layer: Layer): Layer => {
  const waypoints = [...(layer.routePoints ?? [])].reverse().map((waypoint) => ({ ...waypoint }));
  const existing = new Map(
    (layer.routeSegments ?? []).map((segment) => [`${segment.startPointId}:${segment.endPointId}`, segment]),
  );
  const segments = waypoints.slice(0, -1).map((start, index) => {
    const end = waypoints[index + 1];
    const source = existing.get(`${end.id}:${start.id}`);
    if (!source) return createRouteSegment(start, end);
    return {
      ...structuredClone(source),
      id: `route-segment-${crypto.randomUUID()}`,
      startPointId: start.id,
      endPointId: end.id,
      geometry: [...source.geometry].reverse().map((point) => [point[0], point[1]] as [number, number]),
    };
  });
  return {
    ...layer,
    name: routeNameFromPoints(waypoints),
    routePoints: waypoints,
    routeSegments: segments,
  };
};

export const duplicateRouteIdentity = (layer: Layer): Layer => {
  if (layer.type !== 'route') return structuredClone(layer);
  const waypointIds = new Map<string, string>();
  const routeWaypoints = (layer.routePoints ?? []).map((waypoint) => {
    const id = `route-waypoint-${crypto.randomUUID()}`;
    waypointIds.set(waypoint.id, id);
    return { ...waypoint, id };
  });
  const routeSegments = (layer.routeSegments ?? []).map((segment) => ({
    ...structuredClone(segment),
    id: `route-segment-${crypto.randomUUID()}`,
    startPointId: waypointIds.get(segment.startPointId) ?? segment.startPointId,
    endPointId: waypointIds.get(segment.endPointId) ?? segment.endPointId,
  }));
  return { ...structuredClone(layer), routePoints: routeWaypoints, routeSegments };
};

export const updateRoutePoint = (layer: Layer, waypointId: string, patch: Partial<RoutePoint>): Layer => {
  const routeWaypoints = (layer.routePoints ?? []).map((waypoint) =>
    waypoint.id === waypointId ? { ...waypoint, ...patch } : waypoint,
  );
  const byId = new Map(routeWaypoints.map((waypoint) => [waypoint.id, waypoint]));
  const routeSegments = (layer.routeSegments ?? []).map((segment) => {
    if (segment.startPointId !== waypointId && segment.endPointId !== waypointId) return segment;
    const start = byId.get(segment.startPointId);
    const end = byId.get(segment.endPointId);
    if (!start || !end) return segment;
    if (segment.pathType === 'air' || segment.pathType === 'custom') {
      const geometry = buildRouteGeometry(
        start,
        end,
        segment.pathType,
        segment.geometryMode,
        segment.curvature,
      );
      return {
        ...segment,
        geometry,
        estimatedDistanceMeters: pathDistanceMeters(geometry),
        routingStatus: 'ready' as const,
      };
    }
    return {
      ...segment,
      routingStatus: segment.geometry.length >= 2 ? ('stale' as const) : segment.routingStatus,
    };
  });
  return { ...layer, routePoints: routeWaypoints, routeSegments, name: routeNameFromPoints(routeWaypoints) };
};

export const deleteRoutePoint = (layer: Layer, waypointId: string): Layer => {
  const original = layer.routePoints ?? [];
  if (original.length <= 2 || !original.some((waypoint) => waypoint.id === waypointId)) return layer;
  const routeWaypoints = original.filter((waypoint) => waypoint.id !== waypointId);
  const retained = new Map(
    (layer.routeSegments ?? []).map((segment) => [`${segment.startPointId}:${segment.endPointId}`, segment]),
  );
  const routeSegments = routeWaypoints.slice(0, -1).map((start, index) => {
    const end = routeWaypoints[index + 1];
    return retained.get(`${start.id}:${end.id}`) ?? createRouteSegment(start, end);
  });
  return { ...layer, routePoints: routeWaypoints, routeSegments, name: routeNameFromPoints(routeWaypoints) };
};

export const setRouteSectionPathType = (layer: Layer, segmentId: string, pathType: PathType): Layer => {
  const byId = new Map((layer.routePoints ?? []).map((waypoint) => [waypoint.id, waypoint]));
  return {
    ...layer,
    routeSegments: (layer.routeSegments ?? []).map((segment) => {
      if (segment.id !== segmentId) return segment;
      const start = byId.get(segment.startPointId);
      const end = byId.get(segment.endPointId);
      if (!start || !end) return segment;
      const generated = pathTypeSupportsGeneratedGeometry(pathType);
      const geometryMode: RouteGeometryMode =
        pathType === 'custom' ? 'custom' : generated ? 'great-circle' : 'provider';
      const geometry = generated
        ? buildRouteGeometry(start, end, pathType, geometryMode, segment.curvature)
        : segment.geometry;
      return {
        ...segment,
        pathType,
        mode: pathType as any,
        geometryMode,
        geometrySource: generated ? 'generated' : segment.geometrySource,
        geometry,
        estimatedDistanceMeters: pathDistanceMeters(geometry),
        routingStatus: pathType === 'custom' ? 'custom' : pathType === 'road' ? 'stale' : 'ready',
      };
    }),
  };
};

export const autoSequenceRouteSegments = (
  segments: readonly RouteSegment[],
  secondsPerSegment = 2,
): Record<string, RouteSegmentAnimation> =>
  Object.fromEntries(
    segments.map((segment, index) => [
      segment.id,
      {
        drawEnabled: true,
        drawDelay: index * secondsPerSegment,
        drawDuration: secondsPerSegment,
        vehicleEnabled: true,
        vehicleDelay: index * secondsPerSegment,
        vehicleDuration: secondsPerSegment,
        vehicleFollowsDraw: true,
      },
    ]),
  );

export interface RoutePlanRequest {
  origin: RoutePoint;
  destination: RoutePoint;
  waypoints?: RoutePoint[];
  pathType: PathType;
  preference?: 'recommended' | 'fastest' | 'shortest';
}
export interface RoutePlan {
  id: string;
  source: string;
  pathType: PathType;
  geometry: [number, number][];
  distanceMeters?: number;
  estimatedDurationSeconds?: number;
  routeSummary?: string;
  attribution?: string;
  providerMetadata?: Record<string, string | number | boolean>;
}
export interface RoutePlanner {
  readonly id: string;
  readonly version: string;
  planRoute(request: RoutePlanRequest, signal: AbortSignal): Promise<RoutePlan[]>;
}
export class RoutePlannerController {
  readonly #planner?: RoutePlanner;
  readonly #cache = new Map<string, RoutePlan[]>();
  #abort?: AbortController;
  constructor(
    planner?: RoutePlanner,
    private readonly cacheLimit = 24,
  ) {
    this.#planner = planner;
  }
  async plan(request: RoutePlanRequest): Promise<RoutePlan[]> {
    if (!this.#planner) return [];
    const key = JSON.stringify({
      provider: this.#planner.id,
      version: this.#planner.version,
      origin: [request.origin.longitude, request.origin.latitude],
      destination: [request.destination.longitude, request.destination.latitude],
      waypoints: request.waypoints?.map((point) => [point.longitude, point.latitude]),
      pathType: request.pathType,
      preference: request.preference,
    });
    const cached = this.#cache.get(key);
    if (cached) return structuredClone(cached);
    this.#abort?.abort();
    this.#abort = new AbortController();
    const plans = await this.#planner.planRoute(request, this.#abort.signal);
    const normalized = plans
      .filter((plan) => plan.geometry.length >= 2)
      .sort((a, b) =>
        request.preference === 'fastest'
          ? (a.estimatedDurationSeconds ?? Infinity) - (b.estimatedDurationSeconds ?? Infinity)
          : 0,
      );
    this.#cache.set(key, structuredClone(normalized));
    if (this.#cache.size > this.cacheLimit) this.#cache.delete(this.#cache.keys().next().value!);
    return normalized;
  }
  cancel() {
    this.#abort?.abort();
  }
}

export const routeSegmentAppearancePatch = (
  layer: Layer,
  segmentId: string,
  patch: RouteSegmentAppearance,
): Layer => ({
  ...layer,
  routeSegments: (layer.routeSegments ?? []).map((segment) =>
    segment.id === segmentId ? { ...segment, appearance: { ...segment.appearance, ...patch } } : segment,
  ),
});

/** Copies only the source Section's resolved fixed appearance to every Section. */
export const applyRouteSectionAppearanceToAll = (layer: Layer, sourceSegmentId: string): Layer => {
  const source = layer.routeSegments?.find((segment) => segment.id === sourceSegmentId);
  if (!source) return layer;
  const appearance = resolveRouteAppearance(layer, source);
  return {
    ...layer,
    routeSegments: (layer.routeSegments ?? []).map((segment) => ({
      ...segment,
      appearance: { ...appearance },
    })),
  };
};

export const routeSectionTimelineUsage = (
  animation: SegmentLayerAnimation | undefined,
  sectionId: string,
  parentIncluded = true,
): RouteSegmentAnimation => ({
  included: parentIncluded,
  ...(animation?.routeDefaults ?? {}),
  ...(animation?.routeSegmentAnimations?.[sectionId] ?? {}),
});

export const routeParentIncludedFromSections = (
  animation: SegmentLayerAnimation | undefined,
  sectionIds: readonly string[],
  legacyParentIncluded = false,
) =>
  sectionIds.some(
    (sectionId) => routeSectionTimelineUsage(animation, sectionId, legacyParentIncluded).included,
  );

export const patchRouteSectionTimelineUsage = (
  animation: SegmentLayerAnimation | undefined,
  sectionId: string,
  patch: Partial<RouteSegmentAnimation>,
): SegmentLayerAnimation => ({
  ...(animation ?? {}),
  routeSegmentAnimations: {
    ...(animation?.routeSegmentAnimations ?? {}),
    [sectionId]: {
      ...(animation?.routeDefaults ?? {}),
      ...(animation?.routeSegmentAnimations?.[sectionId] ?? {}),
      ...patch,
    },
  },
});

export const setAllRouteSectionsIncluded = (
  animation: SegmentLayerAnimation | undefined,
  sectionIds: readonly string[],
  included: boolean,
): SegmentLayerAnimation => {
  let next = animation ?? {};
  for (const sectionId of sectionIds) next = patchRouteSectionTimelineUsage(next, sectionId, { included });
  return next;
};

/** Copies only one Section's View/Transition usage, never Project appearance or geometry. */
export const applyRouteSectionTimelineToAll = (
  animation: SegmentLayerAnimation | undefined,
  sectionIds: readonly string[],
  sourceSectionId: string,
  legacyParentIncluded = false,
): SegmentLayerAnimation => {
  const source = routeSectionTimelineUsage(animation, sourceSectionId, legacyParentIncluded);
  return {
    ...(animation ?? {}),
    routeSegmentAnimations: Object.fromEntries(
      sectionIds.map((sectionId) => [sectionId, structuredClone(source)]),
    ),
  };
};
