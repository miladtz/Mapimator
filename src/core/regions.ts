import type { Layer, RegionGeometry } from './project';
import { REGION_BOUNDARIES } from '../data/regionBoundaries';

export type LngLat = [number, number];
export const REGION_DEFAULTS = {
  fillColor: '#3689e6',
  fillOpacity: 0.35,
  strokeColor: '#66b5ff',
  strokeOpacity: 0.9,
  strokeWidth: 2,
  effectDuration: 1,
  effectDelay: 0,
  drawSpeed: 1,
  drawingDelay: 0,
  drawingDuration: 1.5,
  fillingDelay: 0,
  fillingDuration: 1.5,
  pulseSpeed: 1,
  pulseIntensity: 0.5,
} as const;

const samePoint = (a: LngLat, b: LngLat) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
export const closeRing = (points: readonly LngLat[]): LngLat[] => {
  const result = points.map(([x, y]) => [x, y] as LngLat);
  if (result.length && !samePoint(result[0], result[result.length - 1]))
    result.push([...result[0]] as LngLat);
  return result;
};
export const signedRingArea = (points: readonly LngLat[]) => {
  const ring = closeRing(points);
  let area = 0;
  for (let i = 0; i + 1 < ring.length; i += 1)
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return area / 2;
};
export const validCustomRegionRing = (points: readonly LngLat[]) => {
  const unique = new Set(points.map(([x, y]) => `${x.toFixed(8)}:${y.toFixed(8)}`));
  return unique.size >= 3 && Math.abs(signedRingArea(points)) > 1e-8;
};
export const customRegionGeometry = (points: readonly LngLat[]): RegionGeometry | null =>
  validCustomRegionRing(points) ? { type: 'Polygon', coordinates: [closeRing(points)] } : null;

export const createRegionLayer = (
  name: string,
  geometry: RegionGeometry,
  patch: Partial<Layer> = {},
): Layer => ({
  id: `region-${crypto.randomUUID()}`,
  type: 'region',
  name,
  visible: true,
  locked: false,
  opacity: 1,
  color: REGION_DEFAULTS.fillColor,
  x: 500,
  y: 250,
  regionSource: 'custom',
  regionGeometryEditable: true,
  regionGeometry: geometry,
  regionFillMode: 'solid',
  regionFillColor: REGION_DEFAULTS.fillColor,
  regionFillOpacity: REGION_DEFAULTS.fillOpacity,
  regionImageMode: 'cover',
  regionTileCount: 4,
  regionStrokeExists: true,
  regionStrokeColor: REGION_DEFAULTS.strokeColor,
  regionStrokeOpacity: REGION_DEFAULTS.strokeOpacity,
  regionStrokeWidth: REGION_DEFAULTS.strokeWidth,
  regionAnimationEnabled: false,
  regionEffect: 'fade',
  regionEffectDuration: REGION_DEFAULTS.effectDuration,
  regionEffectDelay: REGION_DEFAULTS.effectDelay,
  regionDrawSpeed: REGION_DEFAULTS.drawSpeed,
  regionDrawingDelay: REGION_DEFAULTS.drawingDelay,
  regionDrawingDuration: REGION_DEFAULTS.drawingDuration,
  regionFillingDelay: REGION_DEFAULTS.fillingDelay,
  regionFillingDuration: REGION_DEFAULTS.fillingDuration,
  regionHighlightColor: '#ffffff',
  regionPulseSpeed: REGION_DEFAULTS.pulseSpeed,
  regionPulseIntensity: REGION_DEFAULTS.pulseIntensity,
  ...patch,
});

export const regionFeatureKey = (layer: Pick<Layer, 'regionSource' | 'regionKind' | 'regionFeatureId'>) =>
  layer.regionSource === 'administrative' && layer.regionFeatureId
    ? `${layer.regionKind}:${layer.regionFeatureId}`
    : null;
export const findAdministrativeRegion = (layers: readonly Layer[], key: string) =>
  layers.find((layer) => layer.type === 'region' && regionFeatureKey(layer) === key);

export interface AdministrativeRegionRecord {
  id: string;
  kind: 'country' | 'admin1';
  name: string;
  localName: string;
  countryCode: string;
  countryCode2: string;
  continent: string;
  adminCode?: string;
  wikidataId?: string;
  geometry: RegionGeometry;
}
const FLAG_CODE_OVERRIDES: Readonly<Record<string, string>> = { FRA: 'fr', NOR: 'no', KOS: 'xk' };
export const resolveFlagCode = (countryCode3?: string, countryCode2?: string) => {
  const override = countryCode3 ? FLAG_CODE_OVERRIDES[countryCode3.toUpperCase()] : undefined;
  const candidate = override ?? countryCode2?.toLowerCase();
  return candidate && /^[a-z]{2}$/.test(candidate) ? candidate : undefined;
};
export const ADMINISTRATIVE_REGIONS: readonly AdministrativeRegionRecord[] = REGION_BOUNDARIES.features.map(
  (feature) => ({
    ...feature.properties,
    countryCode2: resolveFlagCode(feature.properties.countryCode, feature.properties.countryCode2) ?? '',
    geometry: feature.geometry as unknown as RegionGeometry,
  }),
);
const polygonsOf = (geometry: RegionGeometry): number[][][][] =>
  geometry.type === 'Polygon'
    ? [geometry.coordinates as number[][][]]
    : (geometry.coordinates as number[][][][]);
const countryRecords = () => ADMINISTRATIVE_REGIONS.filter((region) => region.kind === 'country');
const createGroupRecord = (
  id: string,
  name: string,
  members: readonly string[],
  kind: 'continent' | 'macro-region',
) => {
  const countries = countryRecords().filter((country) => members.includes(country.countryCode));
  return {
    id,
    kind,
    name,
    localName: name,
    countryCode: '',
    countryCode2: '',
    continent: '',
    geometry: {
      type: 'MultiPolygon' as const,
      coordinates: countries.flatMap((country) => polygonsOf(country.geometry)),
    },
    members: countries.map((country) => country.countryCode),
  };
};
const CONTINENT_NAMES = ['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania'] as const;
export const CONTINENT_REGIONS = CONTINENT_NAMES.map((name) =>
  createGroupRecord(
    `continent-${name.toLowerCase().replaceAll(' ', '-')}`,
    name,
    countryRecords()
      .filter((country) => country.continent === name)
      .map((country) => country.countryCode),
    'continent',
  ),
);
export const MACRO_REGION_DEFINITIONS = [
  {
    id: 'mena',
    name: 'MENA',
    members: [
      'DZA',
      'BHR',
      'EGY',
      'IRN',
      'IRQ',
      'ISR',
      'JOR',
      'KWT',
      'LBN',
      'LBY',
      'MAR',
      'OMN',
      'PSE',
      'QAT',
      'SAU',
      'SYR',
      'TUN',
      'ARE',
      'YEM',
    ],
  },
  { id: 'gcc', name: 'GCC', members: ['BHR', 'KWT', 'OMN', 'QAT', 'SAU', 'ARE'] },
  { id: 'scandinavia', name: 'Scandinavia', members: ['DNK', 'NOR', 'SWE'] },
  {
    id: 'balkans',
    name: 'Balkans',
    members: ['ALB', 'BIH', 'BGR', 'HRV', 'GRC', 'MNE', 'MKD', 'ROU', 'SRB', 'SVN'],
  },
] as const;
export const MACRO_REGIONS = MACRO_REGION_DEFINITIONS.map((group) =>
  createGroupRecord(group.id, group.name, group.members, 'macro-region'),
);
export const GEOGRAPHIC_REGIONS = [...CONTINENT_REGIONS, ...MACRO_REGIONS, ...ADMINISTRATIVE_REGIONS];
export const searchAdministrativeRegions = (query: string, limit = 40) => {
  const needle = query.trim().toLocaleLowerCase();
  return GEOGRAPHIC_REGIONS.filter(
    (region) =>
      !needle ||
      [
        region.name,
        region.localName,
        region.id,
        region.countryCode,
        'adminCode' in region ? region.adminCode : undefined,
      ].some((value) => value?.toLocaleLowerCase().includes(needle)),
  ).slice(0, limit);
};
export const createAdministrativeRegionLayer = (region: AdministrativeRegionRecord): Layer =>
  createRegionLayer(region.name, region.geometry, {
    regionSource: 'administrative',
    regionKind: region.kind,
    regionFeatureId: region.id,
    regionCountryCode: region.countryCode,
    regionCountryCode2: region.countryCode2,
    regionAdminCode: region.adminCode,
    regionWikidataId: region.wikidataId,
    regionGeometryEditable: false,
  });
export const createGeographicRegionLayer = (region: (typeof GEOGRAPHIC_REGIONS)[number]): Layer => {
  const layer = createRegionLayer(region.name, region.geometry, {
    regionSource: 'administrative',
    regionKind: region.kind,
    regionFeatureId: region.id,
    regionCountryCode: region.countryCode,
    regionCountryCode2: region.countryCode2,
    regionGeometryEditable: false,
  });
  if ('members' in region) {
    layer.regionGroupId = region.id;
    layer.regionGroupMembers = [...region.members];
  }
  return layer;
};

export const regionEffectTiming = (layer: Layer) => {
  const drawingDelay = Math.max(0, layer.regionDrawingDelay ?? 0);
  const drawingDuration = Math.max(0, layer.regionDrawingDuration ?? 1.5);
  const fillingDelay = Math.max(0, layer.regionFillingDelay ?? 0);
  const fillingDuration = Math.max(0, layer.regionFillingDuration ?? 1.5);
  const order = layer.regionDrawOrder ?? 'before-fill';
  const drawStart = order === 'before-fill' ? drawingDelay : fillingDelay + fillingDuration + drawingDelay;
  const fillStart = order === 'before-fill' ? drawingDelay + drawingDuration + fillingDelay : fillingDelay;
  return {
    drawStart,
    drawEnd: drawStart + drawingDuration,
    fillStart,
    fillEnd: fillStart + fillingDuration,
    appearanceCompleteTime: drawingDelay + drawingDuration + fillingDelay + fillingDuration,
  };
};

export const regionPresentation = (layer: Layer, timeSeconds = 0) => {
  const enabled = layer.regionAnimationEnabled === true;
  const delay = Math.max(0, layer.regionEffectDelay ?? 0);
  const duration = Math.max(0.01, layer.regionEffectDuration ?? 1);
  const effectTime = layer.regionEffectTime ?? timeSeconds;
  const progress = layer.regionEffectProgress ?? Math.max(0, Math.min(1, (effectTime - delay) / duration));
  const effect = layer.regionEffect ?? 'fade';
  const drawingDuration = Math.max(0, layer.regionDrawingDuration ?? 1.5);
  const fillingDuration = Math.max(0, layer.regionFillingDuration ?? 1.5);
  const phaseProgress = (elapsed: number, start: number, phaseDuration: number) =>
    elapsed < start
      ? 0
      : phaseDuration === 0
        ? 1
        : Math.max(0, Math.min(1, (elapsed - start) / phaseDuration));
  const timing = regionEffectTiming(layer);
  const elapsed = layer.regionEffectTime ?? progress * timing.appearanceCompleteTime;
  const orderedDrawProgress = phaseProgress(elapsed, timing.drawStart, drawingDuration);
  const orderedFillProgress = phaseProgress(elapsed, timing.fillStart, fillingDuration);
  const pulse =
    enabled && effect === 'pulse'
      ? 1 -
        (layer.regionPulseIntensity ?? 0.5) *
          0.5 *
          (1 + Math.cos(Math.max(0, effectTime - delay) * (layer.regionPulseSpeed ?? 1) * Math.PI * 2))
      : 1;
  return {
    progress: enabled ? progress : 1,
    fillFactor:
      enabled && effect === 'fade' ? progress : enabled && effect === 'draw-border' ? orderedFillProgress : 1,
    strokeFactor: enabled && effect === 'fade' ? progress : pulse,
    drawProgress: enabled && effect === 'draw-border' ? orderedDrawProgress : 1,
  };
};

const geographicDistance = (a: LngLat, b: LngLat) =>
  Math.hypot((b[0] - a[0]) * Math.cos(((a[1] + b[1]) * Math.PI) / 360), b[1] - a[1]);
export const revealRing = (ring: readonly LngLat[], progress: number): LngLat[] => {
  if (ring.length < 2 || progress <= 0) return [];
  if (progress >= 1) return ring.map((point) => [...point] as LngLat);
  const lengths = ring.slice(1).map((point, index) => geographicDistance(ring[index], point));
  const target = lengths.reduce((sum, value) => sum + value, 0) * progress;
  const result: LngLat[] = [[...ring[0]] as LngLat];
  let consumed = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (consumed + length <= target) result.push([...ring[index + 1]] as LngLat);
    else {
      const t = length > 0 ? (target - consumed) / length : 0;
      const a = ring[index];
      const b = ring[index + 1];
      result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      break;
    }
    consumed += length;
  }
  return result;
};
export const revealRegionGeometry = (geometry: RegionGeometry, progress: number) => {
  const polygons =
    geometry.type === 'Polygon'
      ? [geometry.coordinates as number[][][]]
      : (geometry.coordinates as number[][][][]);
  return {
    type: 'MultiLineString' as const,
    coordinates: polygons.flatMap((polygon) =>
      polygon.map((ring) => revealRing(ring as LngLat[], progress)).filter((ring) => ring.length >= 2),
    ),
  };
};
