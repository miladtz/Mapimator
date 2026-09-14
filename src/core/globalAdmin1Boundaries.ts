import type { RegionGeometry } from './project';
import type { SearchResult } from './locationSearch';
import { ADMINISTRATIVE_REGIONS } from './regions';

export const GLOBAL_ADMIN1_DATASET = {
  id: 'mapmotion-gbopen-adm1-v6',
  source: 'geoBoundaries-gbOpen',
  sourceVersion: 'v6.0.0',
  license: 'CC BY 4.0',
  attribution: 'Administrative boundaries: geoBoundaries gbOpen (CC BY 4.0).',
} as const;

export interface GlobalAdmin1BoundaryRef {
  id: string;
  sourceId: string;
  countryCode: string;
  name: string;
  iso3166_2?: string;
  asset: string;
}

export interface GlobalAdmin1Boundary extends GlobalAdmin1BoundaryRef {
  source: 'geoBoundaries-gbOpen';
  sourceVersion: 'v6.0.0';
  adminLevel: 1;
  geometry: RegionGeometry;
}

let indexPromise: Promise<readonly GlobalAdmin1BoundaryRef[]> | undefined;
const countryPromises = new Map<string, Promise<readonly GlobalAdmin1Boundary[]>>();

const assetUrl = (relative: string) =>
  `${import.meta.env.BASE_URL}map-data/gbopen-adm1-v6/${relative}`;

const loadJson = async <T>(relative: string): Promise<T> => {
  const response = await fetch(assetUrl(relative));
  if (!response.ok) throw new Error(`Boundary asset unavailable (${response.status}).`);
  return response.json() as Promise<T>;
};

export const loadGlobalAdmin1Index = () =>
  (indexPromise ??= loadJson<readonly GlobalAdmin1BoundaryRef[]>('index.json'));

const alpha3For = (countryCode?: string) => {
  const normalized = countryCode?.trim().toUpperCase();
  if (!normalized) return undefined;
  if (normalized.length === 3) return normalized;
  return ADMINISTRATIVE_REGIONS.find(
    (region) => region.kind === 'country' && region.countryCode2.toUpperCase() === normalized,
  )?.countryCode;
};

const normalize = (value?: string) =>
  value
    ?.normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLocaleLowerCase();

export const resolveGlobalAdmin1BoundaryRef = async (entity: SearchResult) => {
  const index = await loadGlobalAdmin1Index();
  const explicitId = entity.geographicFeatureId;
  if (explicitId?.startsWith('gbopen-v6-adm1-'))
    return index.find((candidate) => candidate.id === explicitId);
  if (entity.category !== 'Administrative Region') return undefined;
  const osmValue = entity.sourceMetadata?.osmValue;
  if (entity.source === 'geocoder' && osmValue !== 'state' && osmValue !== 'province') return undefined;
  const countryCode = alpha3For(entity.countryCode);
  if (!countryCode) return undefined;
  const adminCode = entity.adminCode?.toUpperCase();
  if (adminCode) {
    const byIso = index.filter(
      (candidate) => candidate.countryCode === countryCode && candidate.iso3166_2?.toUpperCase() === adminCode,
    );
    if (byIso.length === 1) return byIso[0];
  }
  const name = normalize(entity.name);
  const matches = index.filter(
    (candidate) => candidate.countryCode === countryCode && normalize(candidate.name) === name,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return undefined;

  // Photon often returns only a local-script ADM1 name. A unique containing ADM1 polygon is
  // a deterministic geographic concordance for an ADM1 result; cities/ADM2 never enter this path.
  const countryAsset = index.find((candidate) => candidate.countryCode === countryCode)?.asset;
  if (!countryAsset) return undefined;
  const boundaries = await loadCountry(countryCode, countryAsset);
  const containing = boundaries.filter((boundary) =>
    geometryContainsPoint(boundary.geometry, entity.coordinates.longitude, entity.coordinates.latitude),
  );
  return containing.length === 1 ? index.find((candidate) => candidate.id === containing[0].id) : undefined;
};

const loadCountry = (countryCode: string, asset: string) =>
  countryPromises.get(countryCode) ??
    (() => {
      const promise = loadJson<readonly GlobalAdmin1Boundary[]>(asset);
      countryPromises.set(countryCode, promise);
      return promise;
    })();

const ringContainsPoint = (ring: readonly number[][], longitude: number, latitude: number) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = longitude + ((((ring[i][0] - longitude + 180) % 360) + 360) % 360) - 180;
    const bx = longitude + ((((ring[j][0] - longitude + 180) % 360) + 360) % 360) - 180;
    const ay = ring[i][1];
    const by = ring[j][1];
    if (ay > latitude !== by > latitude && longitude < ((bx - ax) * (latitude - ay)) / (by - ay) + ax)
      inside = !inside;
  }
  return inside;
};

const geometryContainsPoint = (geometry: RegionGeometry, longitude: number, latitude: number) => {
  const polygons = (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates) as number[][][][];
  return polygons.some(
    (polygon) =>
      polygon.length > 0 &&
      ringContainsPoint(polygon[0], longitude, latitude) &&
      !polygon.slice(1).some((hole) => ringContainsPoint(hole, longitude, latitude)),
  );
};

export const loadGlobalAdmin1Boundary = async (reference: GlobalAdmin1BoundaryRef) => {
  const boundaries = await loadCountry(reference.countryCode, reference.asset);
  return boundaries.find((boundary) => boundary.id === reference.id);
};
