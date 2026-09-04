import { invoke } from '@tauri-apps/api/core';
import type { PathType, RoutePoint } from './project';
import type { NormalizedRoutePlan, RoutePreference } from './routePlanner';
import { planMaritimeRoute } from './maritimeRouting';

export interface RoutingServiceSettings {
  openRouteServiceApiKey: string;
}

export const EMPTY_ROUTING_SETTINGS: RoutingServiceSettings = {
  openRouteServiceApiKey: '',
};

const environmentSettings = (): RoutingServiceSettings => ({
  openRouteServiceApiKey: String(import.meta.env.VITE_MAPMOTION_ORS_API_KEY ?? '').trim(),
});

export const loadRoutingServiceSettings = async (): Promise<RoutingServiceSettings> => {
  let stored = EMPTY_ROUTING_SETTINGS;
  try {
    stored = await invoke<RoutingServiceSettings>('read_routing_service_settings');
  } catch {
    // Browser-only development has no native preferences store.
  }
  const fallback = environmentSettings();
  return {
    openRouteServiceApiKey: stored.openRouteServiceApiKey.trim() || fallback.openRouteServiceApiKey,
  };
};

export const saveRoutingServiceSettings = (settings: RoutingServiceSettings) =>
  invoke('write_routing_service_settings', {
    settings: {
      openRouteServiceApiKey: settings.openRouteServiceApiKey.trim(),
    },
  });

const validCoordinate = (value: unknown): value is [number, number] =>
  Array.isArray(value) &&
  value.length >= 2 &&
  Number.isFinite(value[0]) &&
  Number.isFinite(value[1]) &&
  value[0] >= -180 &&
  value[0] <= 180 &&
  value[1] >= -90 &&
  value[1] <= 90;

const normalizeError = (status: number) => {
  if (status === 401 || status === 403) return new Error('Authentication failed.');
  if (status === 429) return new Error('Routing quota exceeded.');
  if (status === 404) return new Error('No route found.');
  return new Error('Routing service unavailable.');
};

export interface ProviderRouteRequest {
  source: RoutePoint;
  destination: RoutePoint;
  stops?: RoutePoint[];
  pathType: PathType;
  preference: RoutePreference;
}

export interface ConnectedRoutePlanner {
  id: string;
  planRoute(request: ProviderRouteRequest, signal: AbortSignal): Promise<NormalizedRoutePlan[]>;
  testConnection(signal: AbortSignal): Promise<void>;
}

export class OpenRouteServicePlanner implements ConnectedRoutePlanner {
  readonly id = 'openrouteservice';
  constructor(_apiKey?: string) {}
  async planRoute(request: ProviderRouteRequest, signal: AbortSignal) {
    const profile = request.pathType === 'road' ? 'driving-car' : undefined;
    if (!profile) throw new Error('Road routing is unavailable for this path type.');
    const points = [request.source, ...(request.stops ?? []), request.destination];
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const payload = await invoke<{
      features?: Array<{
        geometry?: { coordinates?: unknown[] };
        properties?: {
          summary?: { distance?: number; duration?: number };
          segments?: Array<{ distance?: number; duration?: number }>;
        };
      }>;
    }>('plan_open_route_service_route', {
      request: {
        coordinates: points.map((point) => [point.longitude, point.latitude]),
        profile,
        preference: request.preference,
        alternatives: points.length === 2,
      },
    });
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const plans = (payload.features ?? [])
      .map((feature, index): NormalizedRoutePlan | undefined => {
        const raw = feature.geometry?.coordinates;
        if (!Array.isArray(raw)) return undefined;
        const geometry = raw.filter(validCoordinate).map(([lng, lat]) => [lng, lat] as [number, number]);
        const distance = Number(feature.properties?.summary?.distance);
        const duration = Number(feature.properties?.summary?.duration);
        if (
          geometry.length !== raw.length ||
          geometry.length < 2 ||
          !Number.isFinite(distance) ||
          !Number.isFinite(duration)
        )
          return undefined;
        return {
          id: `ors-${index}-${Math.round(distance)}`,
          provider: this.id,
          providerVersion: 'directions-v2',
          pathType: request.pathType,
          geometry,
          distanceMeters: distance,
          estimatedDurationSeconds: duration,
          routeSummary: index ? `Alternative ${index + 1}` : 'Recommended road route',
          legs: (feature.properties?.segments ?? []).map((leg) => ({
            distanceMeters: Number(leg.distance) || 0,
            estimatedDurationSeconds: Number(leg.duration) || 0,
          })),
          alternativeRank: index,
          attribution: 'openrouteservice · © OpenStreetMap contributors',
        };
      })
      .filter((plan): plan is NormalizedRoutePlan => Boolean(plan));
    if (!plans.length) throw new Error('No route found.');
    return plans
      .sort((a, b) =>
        request.preference === 'shortest'
          ? a.distanceMeters - b.distanceMeters
          : a.estimatedDurationSeconds - b.estimatedDurationSeconds,
      )
      .map((plan, index) => ({ ...plan, alternativeRank: index }));
  }
  async testConnection(signal: AbortSignal) {
    const a = { id: 'test-a', longitude: 8.681495, latitude: 49.41461 };
    const b = { id: 'test-b', longitude: 8.687872, latitude: 49.420318 };
    await this.planRoute({ source: a, destination: b, pathType: 'road', preference: 'fastest' }, signal);
  }
}

export class BuiltInMaritimePlanner implements ConnectedRoutePlanner {
  readonly id = 'mapmotion-maritime';
  async planRoute(request: ProviderRouteRequest, signal: AbortSignal) {
    if (request.pathType !== 'maritime')
      throw new Error('Maritime routing is unavailable for this path type.');
    const result = await planMaritimeRoute(request.source, request.destination, signal);
    return [
      {
        id: `maritime-${Math.round(result.distanceMeters)}`,
        provider: this.id,
        providerVersion: 'arcnautical-1.0.0',
        pathType: request.pathType,
        geometry: result.geometry,
        distanceMeters: result.distanceMeters,
        estimatedDurationSeconds: 0,
        routeSummary: 'Maritime — Approximate',
        legs: [{ distanceMeters: result.distanceMeters, estimatedDurationSeconds: 0 }],
        alternativeRank: 0,
        attribution: 'ArcNautical · approximate sea-route reference',
        routedStart: result.routedStart,
        routedEnd: result.routedEnd,
      },
    ];
  }
  async testConnection(signal: AbortSignal) {
    const a = { id: 'test-a', longitude: 56.27, latitude: 27.18 };
    const b = { id: 'test-b', longitude: 55.27, latitude: 25.25 };
    await this.planRoute(
      { source: a, destination: b, pathType: 'maritime', preference: 'recommended' },
      signal,
    );
  }
}

export const plannerForPathType = (
  pathType: PathType,
  settings: RoutingServiceSettings,
): ConnectedRoutePlanner | undefined => {
  if (pathType === 'road' && settings.openRouteServiceApiKey)
    return new OpenRouteServicePlanner(settings.openRouteServiceApiKey);
  if (pathType === 'maritime') return new BuiltInMaritimePlanner();
  return undefined;
};
/** @deprecated use plannerForPathType */
export const plannerForMode = (mode: string, settings: RoutingServiceSettings) =>
  plannerForPathType(mode as PathType, settings);
