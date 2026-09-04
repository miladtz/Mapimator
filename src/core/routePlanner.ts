import type {
  CustomRouteGeneratorSettings,
  CustomRoutePathShape,
  Layer,
  PathType,
  RoutePoint,
  RouteSegment,
  RouteDefinition,
} from './project';
import {
  createRouteLayer,
  curvedFlowGeometry,
  greatCircleGeometry,
  pathDistanceMeters,
  unwrapRouteLongitude,
} from './routes';
import {
  customRouteSettings,
  customRouteSettingsFromGeometry,
  generateCustomRouteGeometry,
} from './customRoutePath';

export type RoutePreference = 'fastest' | 'shortest' | 'recommended';
export type RoutePickTarget = 'source' | 'destination' | { id: string; kind: 'stop' };
export interface RoutePlanLeg {
  distanceMeters: number;
  estimatedDurationSeconds: number;
}
export interface NormalizedRoutePlan {
  id: string;
  provider: string;
  providerVersion: string;
  pathType: PathType;
  geometry: [number, number][];
  distanceMeters: number;
  estimatedDurationSeconds: number;
  routeSummary: string;
  legs: RoutePlanLeg[];
  alternativeRank: number;
  attribution?: string;
  routedStart?: [number, number];
  routedEnd?: [number, number];
}
export type AirModel = 'great-circle' | 'direct';
export interface RoutePlannerSection {
  id: string;
  startPointId: string;
  endPointId: string;
  pathType: PathType;
  airModel: AirModel;
  status: 'idle' | 'calculating' | 'ready' | 'error' | 'custom';
  plans: NormalizedRoutePlan[];
  selectedPlanId?: string;
  error?: string;
  customSettings?: CustomRouteGeneratorSettings;
}
export interface RoutePlannerDraft {
  source?: RoutePoint;
  destination?: RoutePoint;
  stops: RoutePoint[];
  sections: RoutePlannerSection[];
  preference: RoutePreference;
  status: 'idle' | 'calculating' | 'ready' | 'error';
  error?: string;
}

export const routePlannerPoints = (draft: RoutePlannerDraft) =>
  [draft.source, ...draft.stops, draft.destination].filter((point): point is RoutePoint => Boolean(point));
const sectionIdentity = (startPointId: string, endPointId: string) =>
  `route-section-${startPointId}-${endPointId}`;

export const reconcileRouteSections = (draft: RoutePlannerDraft): RoutePlannerDraft => {
  const points = routePlannerPoints(draft);
  const previous = new Map(
    draft.sections.map((section) => [`${section.startPointId}:${section.endPointId}`, section]),
  );
  const sections = points.slice(0, -1).map((point, index) => {
    const end = points[index + 1];
    return (
      previous.get(`${point.id}:${end.id}`) ?? {
        id: sectionIdentity(point.id, end.id),
        startPointId: point.id,
        endPointId: end.id,
        pathType: 'road' as const,
        airModel: 'great-circle' as const,
        status: 'idle' as const,
        plans: [],
      }
    );
  });
  return { ...draft, sections, status: 'idle', error: undefined };
};
export const createRoutePlannerDraft = (): RoutePlannerDraft => ({
  stops: [],
  sections: [],
  preference: 'fastest',
  status: 'idle',
});

const cloneRoutePoint = (point: RoutePoint): RoutePoint => ({ ...point });
const cloneGeometry = (geometry: readonly [number, number][]): [number, number][] =>
  geometry.map((coordinate) => [...coordinate] as [number, number]);

/** Restores an accepted Route into a completely isolated Planner draft. */
export const routePlannerDraftFromLayer = (layer: Layer): RoutePlannerDraft => {
  if (layer.type !== 'route') throw new Error('Only a Route Layer can be edited in Route Planner.');
  const acceptedPoints = layer.routePoints ?? [];
  const definition = layer.routeDefinition;
  const source = definition?.source ?? acceptedPoints[0];
  const destination = definition?.destination ?? acceptedPoints.at(-1);
  if (!source || !destination) throw new Error('This Route does not contain editable endpoints.');
  const stops = definition?.stops ?? acceptedPoints.slice(1, -1);
  const definitions: RouteDefinition['sectionDefinitions'] =
    definition?.sectionDefinitions ??
    (layer.routeSegments ?? []).map((segment) => ({
      id: segment.id,
      startPointId: segment.startPointId,
      endPointId: segment.endPointId,
      pathType: segment.pathType,
    }));
  const acceptedSegments = new Map((layer.routeSegments ?? []).map((segment) => [segment.id, segment]));
  const sections: RoutePlannerSection[] = definitions.map((section) => {
    const accepted =
      acceptedSegments.get(section.id) ??
      layer.routeSegments?.find(
        (segment) =>
          segment.startPointId === section.startPointId && segment.endPointId === section.endPointId,
      );
    const settings = section.generatorSettings as
      (Partial<CustomRouteGeneratorSettings> & { airModel?: AirModel }) | undefined;
    const customSettings =
      section.pathType === 'custom' && settings?.version === 1
        ? customRouteSettings(settings.pathShape ?? 'exact', settings.controlPoints ?? [])
        : undefined;
    const plan: NormalizedRoutePlan | undefined = accepted?.geometry?.length
      ? {
          id: `accepted-${section.id}`,
          provider: accepted.providerId ?? 'mapmotion-accepted',
          providerVersion: accepted.providerVersion ?? '1',
          pathType: section.pathType,
          geometry: cloneGeometry(accepted.geometry),
          distanceMeters: accepted.estimatedDistanceMeters ?? pathDistanceMeters(accepted.geometry),
          estimatedDurationSeconds: accepted.estimatedDurationSeconds ?? 0,
          routeSummary: accepted.routeSummary ?? 'Accepted Route geometry',
          legs: [],
          alternativeRank: 0,
          routedStart: accepted.routedStart ? [...accepted.routedStart] : undefined,
          routedEnd: accepted.routedEnd ? [...accepted.routedEnd] : undefined,
        }
      : undefined;
    return {
      id: section.id,
      startPointId: section.startPointId,
      endPointId: section.endPointId,
      pathType: section.pathType,
      airModel:
        settings?.airModel ?? (accepted?.routeSummary?.includes('Direct') ? 'direct' : 'great-circle'),
      status: plan ? 'ready' : section.pathType === 'custom' ? 'custom' : 'idle',
      plans: plan ? [plan] : [],
      selectedPlanId: plan?.id,
      customSettings,
    };
  });
  return reconcileRouteSections({
    source: cloneRoutePoint(source),
    stops: stops.map(cloneRoutePoint),
    destination: cloneRoutePoint(destination),
    sections,
    preference: 'fastest',
    status: sections.every((section) => section.status === 'ready') ? 'ready' : 'idle',
  });
};
export const invalidateRoutePlans = (draft: RoutePlannerDraft) => reconcileRouteSections(draft);
export const setRoutePlannerPoint = (draft: RoutePlannerDraft, target: RoutePickTarget, point: RoutePoint) =>
  (() => {
    const existing =
      target === 'source'
        ? draft.source
        : target === 'destination'
          ? draft.destination
          : draft.stops.find((stop) => stop.id === target.id);
    const replacement = { ...point, id: existing?.id ?? point.id };
    const next = reconcileRouteSections(
      target === 'source'
        ? { ...draft, source: replacement }
        : target === 'destination'
          ? { ...draft, destination: replacement }
          : existing
            ? { ...draft, stops: draft.stops.map((stop) => (stop.id === target.id ? replacement : stop)) }
            : { ...draft, stops: [...draft.stops, replacement] },
    );
    if (!existing) return next;
    let invalidated: RoutePlannerDraft = {
      ...next,
      sections: next.sections.map((section) =>
        section.startPointId === existing.id || section.endPointId === existing.id
          ? {
              ...section,
              status: (section.pathType === 'custom' ? 'custom' : 'idle') as RoutePlannerSection['status'],
              plans: [],
              selectedPlanId: undefined,
              error: undefined,
            }
          : section,
      ),
    };
    for (const section of invalidated.sections) {
      if (
        section.pathType === 'custom' &&
        section.customSettings &&
        (section.startPointId === existing.id || section.endPointId === existing.id)
      ) {
        invalidated = setCustomRouteSection(invalidated, section.id, section.customSettings);
      }
    }
    return invalidated;
  })();
export const setRoutePlannerSectionPathType = (
  draft: RoutePlannerDraft,
  sectionId: string,
  pathType: PathType,
): RoutePlannerDraft => ({
  ...draft,
  sections: draft.sections.map((section) =>
    section.id === sectionId
      ? {
          ...section,
          pathType,
          status: pathType === 'custom' ? 'custom' : 'idle',
          plans: [],
          selectedPlanId: undefined,
          error: undefined,
          customSettings:
            pathType === 'custom'
              ? (section.customSettings ?? customRouteSettings())
              : section.customSettings,
        }
      : section,
  ),
});

export const setCustomRouteSection = (
  draft: RoutePlannerDraft,
  sectionId: string,
  settings: CustomRouteGeneratorSettings,
): RoutePlannerDraft => {
  const points = new Map(routePlannerPoints(draft).map((point) => [point.id, point]));
  return {
    ...draft,
    error: undefined,
    sections: draft.sections.map((section) => {
      if (section.id !== sectionId) return section;
      const start = points.get(section.startPointId);
      const end = points.get(section.endPointId);
      if (!start || !end)
        return { ...section, status: 'error', error: 'Route Section endpoints are missing.' };
      const geometry = generateCustomRouteGeometry(start, end, settings);
      const distanceMeters = pathDistanceMeters(geometry);
      const plan: NormalizedRoutePlan = {
        id: `custom-${section.id}`,
        provider: 'mapmotion-custom',
        providerVersion: '1',
        pathType: 'custom',
        geometry,
        distanceMeters,
        estimatedDurationSeconds: 0,
        routeSummary: settings.pathShape === 'smooth' ? 'Custom Smooth Path' : 'Custom Exact Path',
        legs: [],
        alternativeRank: 0,
      };
      return {
        ...section,
        customSettings: customRouteSettings(settings.pathShape, settings.controlPoints),
        plans: [plan],
        selectedPlanId: plan.id,
        status: 'ready',
        error: undefined,
      };
    }),
  };
};

export const setCustomRoutePathShape = (
  draft: RoutePlannerDraft,
  sectionId: string,
  pathShape: CustomRoutePathShape,
) => {
  const section = draft.sections.find((candidate) => candidate.id === sectionId);
  if (!section?.customSettings) return draft;
  const settings = customRouteSettings(pathShape, section.customSettings.controlPoints);
  return section.status === 'ready' && section.plans.length
    ? setCustomRouteSection(draft, sectionId, settings)
    : {
        ...draft,
        sections: draft.sections.map((candidate) =>
          candidate.id === sectionId ? { ...candidate, customSettings: settings } : candidate,
        ),
      };
};

export const convertMaritimeSectionToCustom = (draft: RoutePlannerDraft, sectionId: string) => {
  const section = draft.sections.find((candidate) => candidate.id === sectionId);
  const plan =
    section?.plans.find((candidate) => candidate.id === section.selectedPlanId) ?? section?.plans[0];
  if (!section || section.pathType !== 'maritime' || !plan) return draft;
  const converted = setRoutePlannerSectionPathType(draft, sectionId, 'custom');
  return setCustomRouteSection(converted, sectionId, customRouteSettingsFromGeometry(plan.geometry));
};

export const moveStop = (
  draft: RoutePlannerDraft,
  stopId: string,
  direction: 'up' | 'down',
): RoutePlannerDraft => {
  const stops = [...draft.stops];
  const index = stops.findIndex((s) => s.id === stopId);
  if (index < 0) return draft;
  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= stops.length) return draft;
  [stops[index], stops[swapIndex]] = [stops[swapIndex], stops[index]];
  return reconcileRouteSections({ ...draft, stops });
};

export const removeStop = (draft: RoutePlannerDraft, stopId: string): RoutePlannerDraft => {
  const removed = draft.stops.find((stop) => stop.id === stopId);
  const points = routePlannerPoints(draft);
  const index = points.findIndex((point) => point.id === stopId);
  const left =
    index > 0
      ? draft.sections.find(
          (section) => section.startPointId === points[index - 1].id && section.endPointId === stopId,
        )
      : undefined;
  const right =
    index >= 0 && index < points.length - 1
      ? draft.sections.find(
          (section) => section.startPointId === stopId && section.endPointId === points[index + 1].id,
        )
      : undefined;
  const stops = draft.stops.filter((s) => s.id !== stopId);
  let next = reconcileRouteSections({ ...draft, stops });
  if (removed?.sourceControlPointId && left?.customSettings && right?.customSettings) {
    const merged = next.sections.find(
      (section) => section.startPointId === left.startPointId && section.endPointId === right.endPointId,
    );
    if (merged)
      next = setCustomRouteSection(
        next,
        merged.id,
        customRouteSettings(left.customSettings.pathShape, [
          ...left.customSettings.controlPoints,
          { id: removed.sourceControlPointId, longitude: removed.longitude, latitude: removed.latitude },
          ...right.customSettings.controlPoints,
        ]),
      );
  }
  return next;
};

export const replaceStopPoint = (
  draft: RoutePlannerDraft,
  stopId: string,
  point: RoutePoint,
): RoutePlannerDraft => {
  return setRoutePlannerPoint(draft, { id: stopId, kind: 'stop' }, point);
};

export const addRoutePlannerStop = (draft: RoutePlannerDraft, point: RoutePoint) =>
  setRoutePlannerPoint(draft, { id: point.id, kind: 'stop' }, point);

export const promoteCustomControlsToStops = (
  draft: RoutePlannerDraft,
  sectionId: string,
  controlIds: readonly string[],
): RoutePlannerDraft => {
  const section = draft.sections.find((candidate) => candidate.id === sectionId);
  if (!section?.customSettings || section.status !== 'ready') return draft;
  const selected = section.customSettings.controlPoints.filter((point) => controlIds.includes(point.id));
  if (!selected.length) return draft;
  const startIndex = routePlannerPoints(draft).findIndex((point) => point.id === section.startPointId);
  const promoted = selected.map((point) => ({
    id: `route-point-${point.id}`,
    longitude: point.longitude,
    latitude: point.latitude,
    name: `Path Point`,
    sourceControlPointId: point.id,
  }));
  const stops = [...draft.stops];
  stops.splice(startIndex, 0, ...promoted);
  let next = reconcileRouteSections({ ...draft, stops });
  const boundaries = new Set(selected.map((point) => point.id));
  let group: typeof section.customSettings.controlPoints = [];
  const groups: (typeof section.customSettings.controlPoints)[] = [];
  for (const point of section.customSettings.controlPoints) {
    if (boundaries.has(point.id)) {
      groups.push(group);
      group = [];
    } else group.push(point);
  }
  groups.push(group);
  const chain = [section.startPointId, ...promoted.map((point) => point.id), section.endPointId];
  const originalPlan = section.plans.find((plan) => plan.id === section.selectedPlanId) ?? section.plans[0];
  const splitGeometries: [number, number][][] = [];
  if (originalPlan) {
    let cursor = 0;
    for (const boundary of selected) {
      const splitIndex = originalPlan.geometry.findIndex(
        (coordinate, coordinateIndex) =>
          coordinateIndex >= cursor &&
          Math.abs(coordinate[0] - boundary.longitude) < 1e-8 &&
          Math.abs(coordinate[1] - boundary.latitude) < 1e-8,
      );
      if (splitIndex > cursor) {
        splitGeometries.push(originalPlan.geometry.slice(cursor, splitIndex + 1));
        cursor = splitIndex;
      }
    }
    splitGeometries.push(originalPlan.geometry.slice(cursor));
  }
  for (let index = 0; index < chain.length - 1; index += 1) {
    const child = next.sections.find(
      (candidate) => candidate.startPointId === chain[index] && candidate.endPointId === chain[index + 1],
    );
    if (child) {
      next = setCustomRouteSection(
        next,
        child.id,
        customRouteSettings(section.customSettings.pathShape, groups[index]),
      );
      const preserved = splitGeometries[index];
      if (preserved?.length > 1)
        next = {
          ...next,
          sections: next.sections.map((candidate) =>
            candidate.id === child.id
              ? {
                  ...candidate,
                  plans: candidate.plans.map((plan) =>
                    plan.id === candidate.selectedPlanId
                      ? { ...plan, geometry: preserved, distanceMeters: pathDistanceMeters(preserved) }
                      : plan,
                  ),
                }
              : candidate,
          ),
        };
    }
  }
  return next;
};

export const setSectionAirModel = (
  draft: RoutePlannerDraft,
  sectionId: string,
  airModel: AirModel,
): RoutePlannerDraft => ({
  ...draft,
  sections: draft.sections.map((section) =>
    section.id === sectionId
      ? { ...section, airModel, status: 'idle', plans: [], selectedPlanId: undefined, error: undefined }
      : section,
  ),
});
/** @deprecated use setRoutePlannerSectionPathType */
export const setRoutePlannerSectionMode = (
  draft: RoutePlannerDraft,
  sectionId: string,
  mode: string,
): RoutePlannerDraft => setRoutePlannerSectionPathType(draft, sectionId, mode as PathType);

export const planLocalSection = (
  start: RoutePoint,
  end: RoutePoint,
  pathType: PathType,
  airModel: AirModel = 'great-circle',
): NormalizedRoutePlan[] => {
  if (pathType !== 'air' && pathType !== 'custom') return [];
  const geometry =
    pathType === 'air'
      ? airModel === 'direct'
        ? (() => {
            const g: [number, number][] = [];
            const endLongitude = unwrapRouteLongitude(end.longitude, start.longitude);
            const steps = Math.max(
              8,
              Math.ceil(Math.hypot(endLongitude - start.longitude, end.latitude - start.latitude) / 2),
            );
            for (let i = 0; i <= steps; i++) {
              const t = i / steps;
              g.push([
                start.longitude + (endLongitude - start.longitude) * t,
                start.latitude + (end.latitude - start.latitude) * t,
              ]);
            }
            return g;
          })()
        : greatCircleGeometry([start.longitude, start.latitude], [end.longitude, end.latitude])
      : curvedFlowGeometry([start.longitude, start.latitude], [end.longitude, end.latitude]);
  const distanceMeters = pathDistanceMeters(geometry);
  return [
    {
      id: `local-${pathType}-${Math.round(distanceMeters)}`,
      provider: 'mapmotion-local',
      providerVersion: '1',
      pathType,
      geometry,
      distanceMeters,
      estimatedDurationSeconds: 0,
      routeSummary:
        pathType === 'air'
          ? airModel === 'direct'
            ? 'Built-in Direct'
            : 'Built-in Great Circle'
          : 'Built-in Custom Path',
      legs: [],
      alternativeRank: 0,
    },
  ];
};

export const routeLayerFromSections = (draft: RoutePlannerDraft, acceptedLayer?: Layer): Layer => {
  const points = routePlannerPoints(draft);
  if (points.length < 2 || draft.sections.length !== points.length - 1)
    throw new Error('Route endpoints or sections are incomplete.');
  const layer = createRouteLayer(points);
  const segments: RouteSegment[] = draft.sections.map((section) => {
    const plan =
      section.plans.find((candidate) => candidate.id === section.selectedPlanId) ?? section.plans[0];
    const acceptedSegment = acceptedLayer?.routeSegments?.find((segment) => segment.id === section.id);
    const initial =
      acceptedSegment ??
      layer.routeSegments?.find(
        (segment) =>
          segment.startPointId === section.startPointId && segment.endPointId === section.endPointId,
      );
    if (!initial || !plan) throw new Error('Calculate every Route Section before using the Route.');
    return {
      ...initial,
      id: section.id,
      pathType: section.pathType,
      mode: section.pathType as any,
      geometryMode:
        section.pathType === 'custom'
          ? 'custom'
          : plan.provider === 'mapmotion-local'
            ? 'great-circle'
            : 'provider',
      geometrySource:
        section.pathType === 'custom'
          ? 'custom'
          : plan.provider === 'mapmotion-local'
            ? 'generated'
            : 'provider',
      geometry: plan.geometry.map((coordinate) => [...coordinate] as [number, number]),
      providerId: plan.provider,
      providerVersion: plan.providerVersion,
      routeSummary: plan.routeSummary,
      estimatedDistanceMeters: plan.distanceMeters,
      estimatedDurationSeconds: plan.estimatedDurationSeconds,
      routingStatus:
        section.pathType === 'custom' || plan.provider === 'mapmotion-local' ? 'ready' : 'routed',
      routedStart: plan.routedStart,
      routedEnd: plan.routedEnd,
    };
  });
  const routeDefinition: RouteDefinition = {
    source: cloneRoutePoint(points[0]),
    stops: points.slice(1, -1).map(cloneRoutePoint),
    destination: cloneRoutePoint(points.at(-1)!),
    sectionDefinitions: draft.sections.map((section) => ({
      id: section.id,
      startPointId: section.startPointId,
      endPointId: section.endPointId,
      pathType: section.pathType,
      generatorSettings:
        section.pathType === 'custom' && section.customSettings
          ? customRouteSettings(section.customSettings.pathShape, section.customSettings.controlPoints)
          : section.pathType === 'air'
            ? { airModel: section.airModel }
            : undefined,
    })),
  };
  return {
    ...(acceptedLayer ?? layer),
    name: `${points[0].name ?? 'Source'} → ${points.at(-1)?.name ?? 'Destination'}`,
    x: points[0].longitude,
    y: points[0].latitude,
    routePoints: points.map(cloneRoutePoint),
    routeSegments: segments,
    routeDefinition,
  };
};

/** Atomically replaces one accepted Route in place without changing layer ordering. */
export const replaceAcceptedRouteLayer = (
  layers: readonly Layer[],
  routeLayerId: string,
  replacement: Layer,
): Layer[] => {
  if (replacement.type !== 'route' || replacement.id !== routeLayerId)
    throw new Error('Edited Route replacement must preserve the accepted Route Layer ID.');
  if (layers.filter((layer) => layer.id === routeLayerId).length !== 1)
    throw new Error('The accepted Route Layer is no longer uniquely available.');
  return layers.map((layer) => (layer.id === routeLayerId ? replacement : layer));
};
