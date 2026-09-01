import { CITY_LABELS, CONTINENT_LABELS, MARINE_LABELS } from '../data/worldMap';
import { clamp, roundCamera } from './camera';
import { minimalWrappedRegionBounds } from './geographicRegionFillLayer';
import { lngLatToMapMotionWorld, mapLibreMinimumZoom, mapLibreToMapMotionCamera } from './openFreeMapAdapter';
import type { BasemapRenderer, CameraState } from './project';
import type { LogicalViewport } from './projectRenderViewport';
import { GEOGRAPHIC_REGIONS } from './regions';

export type SearchResultCategory =
  | 'Country'
  | 'Administrative Region'
  | 'Continent'
  | 'Macro Region'
  | 'City'
  | 'Sea'
  | 'Coordinates'
  | 'Landmark'
  | 'POI'
  | 'Airport'
  | 'Address'
  | 'Other';

export interface SearchBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface SearchResult {
  id: string;
  source: 'local' | 'geocoder' | 'coordinates';
  name: string;
  localizedName?: string;
  secondaryText?: string;
  category: SearchResultCategory;
  coordinates: { longitude: number; latitude: number };
  bounds?: SearchBounds;
  countryCode?: string;
  adminCode?: string;
  geographicFeatureId?: string;
  capabilities: { addPin: boolean; addRegion: boolean };
}

export interface SearchProvider {
  id: string;
  attribution: string;
  search(query: string, signal: AbortSignal): Promise<SearchResult[]>;
}

export interface LocationSearchResponse {
  results: SearchResult[];
  onlineUnavailable: boolean;
}

export class LocationSearchController {
  private requestId = 0;
  private active?: AbortController;
  private cache = new Map<string, SearchResult[]>();
  constructor(
    private readonly provider?: SearchProvider,
    private readonly cacheLimit = 24,
  ) {}
  cancel() {
    this.requestId += 1;
    this.active?.abort();
    this.active = undefined;
  }
  async search(query: string): Promise<LocationSearchResponse> {
    const id = ++this.requestId;
    this.active?.abort();
    const coordinate = parseCoordinateQuery(query);
    if (coordinate) return { results: [coordinate], onlineUnavailable: !this.provider };
    const local = searchLocalLocations(query);
    if (!this.provider || !query.trim()) return { results: local, onlineUnavailable: !this.provider };
    const key = normalizeSearchText(query);
    const cached = this.cache.get(key);
    if (cached) return { results: mergeSearchResults(local, cached), onlineUnavailable: false };
    const controller = new AbortController();
    this.active = controller;
    try {
      const online = await this.provider.search(query, controller.signal);
      if (id !== this.requestId) throw new DOMException('Superseded search.', 'AbortError');
      this.cache.set(key, online);
      while (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value!);
      return { results: mergeSearchResults(local, online), onlineUnavailable: false };
    } catch (error) {
      if (controller.signal.aborted || id !== this.requestId) throw error;
      return { results: local, onlineUnavailable: true };
    }
  }
}

const normalizeSearchText = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLocaleLowerCase();

const aliases: Readonly<Record<string, readonly string[]>> = {
  USA: ['usa', 'us', 'united states', 'united states of america', 'آمریکا', 'ایالات متحده'],
  ARE: ['uae', 'united arab emirates', 'امارات', 'امارات متحده عربی'],
  GBR: ['uk', 'united kingdom', 'great britain', 'britain', 'بریتانیا', 'انگلستان'],
  IRN: ['iran', 'iran islamic republic', 'ایران'],
  mena: ['mena', 'middle east and north africa', 'خاورمیانه و شمال آفریقا'],
  gcc: ['gcc', 'gulf cooperation council', 'شورای همکاری خلیج فارس'],
};

const regionBounds = (geometry: (typeof GEOGRAPHIC_REGIONS)[number]['geometry']): SearchBounds => {
  const value = minimalWrappedRegionBounds(geometry);
  return { west: value.minX, south: value.minY, east: value.maxX, north: value.maxY };
};

const wrappedCenter = (bounds: SearchBounds) => {
  const longitude = ((((bounds.west + (bounds.east - bounds.west) / 2 + 180) % 360) + 360) % 360) - 180;
  return { longitude, latitude: (bounds.south + bounds.north) / 2 };
};

const regionResults: SearchResult[] = GEOGRAPHIC_REGIONS.map((region) => {
  const bounds = regionBounds(region.geometry);
  const category: SearchResultCategory =
    region.kind === 'country'
      ? 'Country'
      : region.kind === 'admin1'
        ? 'Administrative Region'
        : region.kind === 'continent'
          ? 'Continent'
          : 'Macro Region';
  return {
    id: `local:region:${region.id}`,
    source: 'local',
    name: region.name,
    localizedName: region.localName !== region.name ? region.localName : undefined,
    secondaryText:
      region.kind === 'admin1'
        ? region.countryCode
        : region.kind === 'country'
          ? region.continent
          : undefined,
    category,
    coordinates: wrappedCenter(bounds),
    bounds,
    countryCode: region.countryCode || undefined,
    adminCode: 'adminCode' in region ? region.adminCode : undefined,
    geographicFeatureId: region.id,
    capabilities: { addPin: true, addRegion: true },
  };
});

const pointResult = (
  prefix: string,
  label: (typeof CITY_LABELS)[number],
  category: SearchResultCategory,
): SearchResult => ({
  id: `local:${prefix}:${label.id}`,
  source: 'local',
  name: label.name,
  localizedName: label.nameFa,
  category,
  coordinates: {
    longitude: (label.point[0] / 1000) * 360 - 180,
    latitude: clamp(90 - (label.point[1] / 560) * 180, -85.05112878, 85.05112878),
  },
  capabilities: { addPin: true, addRegion: false },
});

const localPointResults = [
  ...CITY_LABELS.map((label) => pointResult('city', label, 'City')),
  ...MARINE_LABELS.map((label) => pointResult('marine', label, 'Sea')),
  ...CONTINENT_LABELS.map((label) => pointResult('continent-label', label, 'Continent')),
];

const searchableValues = (result: SearchResult) => {
  const values = [
    result.name,
    result.localizedName,
    result.countryCode,
    result.adminCode,
    result.geographicFeatureId,
    ...(result.geographicFeatureId ? (aliases[result.geographicFeatureId] ?? []) : []),
    ...(result.countryCode ? (aliases[result.countryCode] ?? []) : []),
  ];
  return values.filter(Boolean).map((value) => normalizeSearchText(value!));
};

export const parseCoordinateQuery = (query: string): SearchResult | null => {
  const normalized = query.trim().toUpperCase();
  const hemisphere = normalized.match(
    /^([+-]?\d+(?:\.\d+)?)\s*([NS])\s*[, ]+\s*([+-]?\d+(?:\.\d+)?)\s*([EW])$/,
  );
  const decimal = normalized.match(/^([+-]?\d+(?:\.\d+)?)\s*(?:,|\s)\s*([+-]?\d+(?:\.\d+)?)$/);
  if (!hemisphere && !decimal) return null;
  const latitude = Number(hemisphere?.[1] ?? decimal?.[1]) * (hemisphere?.[2] === 'S' ? -1 : 1);
  const longitude = Number(hemisphere?.[3] ?? decimal?.[2]) * (hemisphere?.[4] === 'W' ? -1 : 1);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    return null;
  const displayLatitude = clamp(latitude, -85.05112878, 85.05112878);
  return {
    id: `coordinates:${latitude.toFixed(6)}:${longitude.toFixed(6)}`,
    source: 'coordinates',
    name: 'Coordinates',
    secondaryText: `${latitude.toFixed(6)}, ${longitude.toFixed(6)}${displayLatitude !== latitude ? ' · Mercator display clamped' : ''}`,
    category: 'Coordinates',
    coordinates: { longitude, latitude: displayLatitude },
    capabilities: { addPin: true, addRegion: false },
  };
};

export const searchLocalLocations = (query: string, limit = 20) => {
  const coordinate = parseCoordinateQuery(query);
  if (coordinate) return [coordinate];
  const needle = normalizeSearchText(query);
  if (!needle) return [];
  return [...regionResults, ...localPointResults]
    .map((result) => {
      const values = searchableValues(result);
      const exact = values.some((value) => value === needle);
      const prefix = values.some((value) => value.startsWith(needle));
      const includes = values.some((value) => value.includes(needle));
      return { result, score: exact ? 0 : prefix ? 1 : includes ? 2 : 99 };
    })
    .filter(({ score }) => score < 99)
    .sort((a, b) => a.score - b.score || a.result.name.localeCompare(b.result.name))
    .map(({ result }) => result)
    .filter((result, index, results) => {
      const key = `${result.category}:${normalizeSearchText(result.name)}:${result.countryCode ?? ''}`;
      return (
        results.findIndex(
          (candidate) =>
            `${candidate.category}:${normalizeSearchText(candidate.name)}:${candidate.countryCode ?? ''}` ===
            key,
        ) === index
      );
    })
    .slice(0, limit);
};

export const mergeSearchResults = (local: SearchResult[], online: SearchResult[], limit = 20) => {
  const result = [...local];
  for (const candidate of online) {
    const duplicate = result.some(
      (current) =>
        (candidate.countryCode &&
          current.countryCode === candidate.countryCode &&
          current.category === candidate.category) ||
        (normalizeSearchText(current.name) === normalizeSearchText(candidate.name) &&
          current.category === candidate.category &&
          Math.hypot(
            current.coordinates.longitude - candidate.coordinates.longitude,
            current.coordinates.latitude - candidate.coordinates.latitude,
          ) < 0.1),
    );
    if (!duplicate) result.push(candidate);
  }
  return result.slice(0, limit);
};

const categoryZoom: Readonly<Partial<Record<SearchResultCategory, number>>> = {
  City: 9,
  Landmark: 15,
  POI: 15,
  Airport: 13,
  Address: 16,
  Coordinates: 12,
  Sea: 5,
};

const mercatorY = (latitude: number) => {
  const radians = (clamp(latitude, -85.05112878, 85.05112878) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
};

export const mapLibreZoomForBounds = (bounds: SearchBounds, viewport: LogicalViewport, padding = 48) => {
  const width = Math.max(1, viewport.width - padding * 2);
  const height = Math.max(1, viewport.height - padding * 2);
  const longitudeSpan = Math.max(1e-9, Math.min(360, bounds.east - bounds.west));
  const latitudeSpan = Math.max(1e-9, Math.abs(mercatorY(bounds.north) - mercatorY(bounds.south)));
  return clamp(
    Math.min(Math.log2(width / (512 * (longitudeSpan / 360))), Math.log2(height / (512 * latitudeSpan))),
    mapLibreMinimumZoom(viewport),
    22,
  );
};

export const cameraForSearchResult = (
  result: SearchResult,
  current: CameraState,
  renderer: BasemapRenderer,
  viewport: LogicalViewport,
) => {
  if (renderer === 'online') {
    const zoom = result.bounds
      ? mapLibreZoomForBounds(result.bounds, viewport)
      : (categoryZoom[result.category] ?? 10);
    const bearing = current.bearing ?? 0;
    return mapLibreToMapMotionCamera(
      { lng: result.coordinates.longitude, lat: result.coordinates.latitude },
      zoom,
      bearing,
      0,
      bearing,
      viewport,
    );
  }
  const point = lngLatToMapMotionWorld(result.coordinates.longitude, result.coordinates.latitude);
  const zoom = result.bounds ? 2.5 : result.category === 'City' ? 3.5 : 4;
  return roundCamera({
    ...current,
    x: 500 - point.x * zoom,
    y: 280 - point.y * zoom,
    zoom,
    pitch: 0,
  });
};

export interface PhotonFeature {
  properties?: Record<string, unknown>;
  geometry?: { coordinates?: unknown };
  bbox?: unknown;
}

export const normalizePhotonResults = (features: readonly PhotonFeature[]): SearchResult[] =>
  features.flatMap((feature, index) => {
    const coordinates = feature.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);
    if (
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      Math.abs(longitude) > 180 ||
      Math.abs(latitude) > 90
    )
      return [];
    const properties = feature.properties ?? {};
    const osmValue = String(properties.osm_value ?? properties.type ?? '');
    const category: SearchResultCategory =
      osmValue === 'city'
        ? 'City'
        : osmValue === 'airport'
          ? 'Airport'
          : osmValue === 'house'
            ? 'Address'
            : 'POI';
    const rawBounds = feature.bbox;
    const bounds =
      Array.isArray(rawBounds) &&
      rawBounds.length === 4 &&
      rawBounds.every((value) => Number.isFinite(Number(value)))
        ? {
            west: Number(rawBounds[0]),
            south: Number(rawBounds[1]),
            east: Number(rawBounds[2]),
            north: Number(rawBounds[3]),
          }
        : undefined;
    return [
      {
        id: `geocoder:photon:${String(properties.osm_id ?? index)}`,
        source: 'geocoder' as const,
        name: String(properties.name ?? properties.street ?? 'Unnamed place'),
        localizedName: typeof properties.name_fa === 'string' ? properties.name_fa : undefined,
        secondaryText: [properties.state, properties.country].filter(Boolean).join(', '),
        category,
        coordinates: { longitude, latitude: clamp(latitude, -85.05112878, 85.05112878) },
        bounds,
        countryCode:
          typeof properties.countrycode === 'string' ? properties.countrycode.toUpperCase() : undefined,
        capabilities: { addPin: true, addRegion: false },
      },
    ];
  });

export const trimRecentSearches = (results: readonly SearchResult[], limit = 8) =>
  results
    .filter((result, index) => results.findIndex((candidate) => candidate.id === result.id) === index)
    .slice(0, limit);
