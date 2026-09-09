import type { StyleSpecification } from 'maplibre-gl';
import {
  createMapTilerSatelliteStyle,
  MINIMAL_LIGHT_STYLE,
  MINIMAL_NAVY_STYLE,
} from './mapMotionBasemapStyles';

export type BasemapId = '3d' | 'liberty' | 'dark' | 'bright' | 'minimal-navy' | 'minimal-light' | 'satellite';
export type BasemapProviderId = 'openfreemap' | 'maptiler' | 'mock';
export type BasemapFamily = 'general' | 'minimal' | 'satellite' | 'physical';
export type BasemapLabelAdapterId = 'openfreemap' | 'none';
export type BasemapBoundaryAdapterId = 'openmaptiles-land-only' | 'none';

export interface BasemapCapabilities {
  vector: boolean;
  raster: boolean;
  satellite: boolean;
  labels: boolean;
  labelLanguageSwitching: boolean;
  terrain: boolean;
  flat: boolean;
  globe: boolean;
  offlinePossible: boolean;
  requiresCredentials: boolean;
}

export interface BasemapAttribution {
  text: string;
  requiredInApplication: boolean;
  requiredInExport: boolean;
  logoRequired?: boolean;
}

export type BasemapStyleSource =
  | { kind: 'vector-style-url'; url: string }
  | { kind: 'vector-style-json'; style: StyleSpecification }
  | { kind: 'raster-style-json'; style: StyleSpecification }
  | {
      kind: 'credentialed-raster-style';
      createStyle: (credentials: MapServiceCredentials) => StyleSpecification;
    };

export interface BasemapDefinition<Id extends string = BasemapId> {
  id: Id;
  displayName: string;
  family: BasemapFamily;
  providerId: BasemapProviderId;
  styleSource: BasemapStyleSource;
  capabilities: BasemapCapabilities;
  labelAdapter: BasemapLabelAdapterId;
  boundaryAdapter?: BasemapBoundaryAdapterId;
  attribution: BasemapAttribution;
  credentialKey?: 'maptilerApiKey';
  referenceOverlay?: {
    providerId: BasemapProviderId;
    labelAdapter: BasemapLabelAdapterId;
  };
}

export interface BasemapProviderDefinition {
  id: BasemapProviderId;
  displayName: string;
  requiresApiKey: boolean;
  credentialKey?: 'maptilerApiKey';
  testConnectionSupported: boolean;
  licensingReviewRequired: boolean;
  officialTermsUrl?: string;
  officialPricingUrl?: string;
}

const openFreeMapCapabilities: BasemapCapabilities = {
  vector: true,
  raster: false,
  satellite: false,
  labels: true,
  labelLanguageSwitching: true,
  terrain: false,
  flat: true,
  globe: false,
  offlinePossible: true,
  requiresCredentials: false,
};

const openFreeMapAttribution: BasemapAttribution = {
  text: 'OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors',
  requiredInApplication: true,
  requiredInExport: true,
};

const minimalOpenFreeMapCapabilities: BasemapCapabilities = {
  ...openFreeMapCapabilities,
  globe: false,
};

const mapTilerSatelliteCapabilities: BasemapCapabilities = {
  vector: true,
  raster: true,
  satellite: true,
  labels: true,
  labelLanguageSwitching: true,
  terrain: false,
  flat: true,
  globe: false,
  offlinePossible: false,
  requiresCredentials: true,
};

export const BASEMAP_PROVIDERS: readonly BasemapProviderDefinition[] = [
  {
    id: 'openfreemap',
    displayName: 'OpenFreeMap',
    requiresApiKey: false,
    testConnectionSupported: false,
    licensingReviewRequired: true,
    officialTermsUrl: 'https://openfreemap.org/',
  },
  {
    id: 'maptiler',
    displayName: 'MapTiler',
    requiresApiKey: true,
    credentialKey: 'maptilerApiKey',
    testConnectionSupported: true,
    licensingReviewRequired: true,
    officialTermsUrl: 'https://www.maptiler.com/terms/cloud/',
    officialPricingUrl: 'https://www.maptiler.com/cloud/pricing/',
  },
] as const;

export const BASEMAPS: readonly BasemapDefinition[] = [
  {
    id: '3d',
    displayName: 'OpenFreeMap 3D',
    family: 'general',
    providerId: 'openfreemap',
    styleSource: { kind: 'vector-style-url', url: 'https://tiles.openfreemap.org/styles/liberty' },
    capabilities: openFreeMapCapabilities,
    labelAdapter: 'openfreemap',
    attribution: openFreeMapAttribution,
  },
  {
    id: 'liberty',
    displayName: 'Liberty',
    family: 'general',
    providerId: 'openfreemap',
    styleSource: { kind: 'vector-style-url', url: 'https://tiles.openfreemap.org/styles/liberty' },
    capabilities: openFreeMapCapabilities,
    labelAdapter: 'openfreemap',
    attribution: openFreeMapAttribution,
  },
  {
    id: 'dark',
    displayName: 'Dark',
    family: 'general',
    providerId: 'openfreemap',
    styleSource: { kind: 'vector-style-url', url: 'https://tiles.openfreemap.org/styles/dark' },
    capabilities: openFreeMapCapabilities,
    labelAdapter: 'openfreemap',
    boundaryAdapter: 'openmaptiles-land-only',
    attribution: openFreeMapAttribution,
  },
  {
    id: 'bright',
    displayName: 'Bright',
    family: 'general',
    providerId: 'openfreemap',
    styleSource: { kind: 'vector-style-url', url: 'https://tiles.openfreemap.org/styles/bright' },
    capabilities: openFreeMapCapabilities,
    labelAdapter: 'openfreemap',
    attribution: openFreeMapAttribution,
  },
  {
    id: 'minimal-navy',
    displayName: 'Minimal Navy',
    family: 'minimal',
    providerId: 'openfreemap',
    styleSource: { kind: 'vector-style-json', style: MINIMAL_NAVY_STYLE },
    capabilities: minimalOpenFreeMapCapabilities,
    labelAdapter: 'openfreemap',
    boundaryAdapter: 'openmaptiles-land-only',
    attribution: openFreeMapAttribution,
  },
  {
    id: 'minimal-light',
    displayName: 'Minimal Light',
    family: 'minimal',
    providerId: 'openfreemap',
    styleSource: { kind: 'vector-style-json', style: MINIMAL_LIGHT_STYLE },
    capabilities: minimalOpenFreeMapCapabilities,
    labelAdapter: 'openfreemap',
    boundaryAdapter: 'openmaptiles-land-only',
    attribution: openFreeMapAttribution,
  },
  {
    id: 'satellite',
    displayName: 'Satellite',
    family: 'satellite',
    providerId: 'maptiler',
    styleSource: {
      kind: 'credentialed-raster-style',
      createStyle: ({ maptilerApiKey }) => createMapTilerSatelliteStyle(maptilerApiKey),
    },
    capabilities: mapTilerSatelliteCapabilities,
    labelAdapter: 'openfreemap',
    boundaryAdapter: 'openmaptiles-land-only',
    attribution: {
      text: '© MapTiler · OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors',
      requiredInApplication: true,
      requiredInExport: true,
      logoRequired: true,
    },
    credentialKey: 'maptilerApiKey',
    referenceOverlay: { providerId: 'openfreemap', labelAdapter: 'openfreemap' },
  },
] as const;

export const BASEMAP_IDS = BASEMAPS.map(({ id }) => id) as BasemapId[];
export const isBasemapId = (value: unknown): value is BasemapId =>
  typeof value === 'string' && BASEMAP_IDS.includes(value as BasemapId);

export const basemapById = (id: BasemapId): BasemapDefinition =>
  BASEMAPS.find((definition) => definition.id === id) ?? BASEMAPS.find(({ id }) => id === 'liberty')!;

export interface MapServiceCredentials {
  maptilerApiKey: string;
}

export type BasemapAvailability =
  | { status: 'available' }
  | { status: 'missing-credential'; providerId: BasemapProviderId; credentialKey: string }
  | { status: 'unsupported'; reason: string };

export const basemapAvailability = (
  definition: BasemapDefinition<string>,
  credentials: MapServiceCredentials,
): BasemapAvailability => {
  if (definition.capabilities.requiresCredentials && definition.credentialKey) {
    if (!credentials[definition.credentialKey].trim())
      return {
        status: 'missing-credential',
        providerId: definition.providerId,
        credentialKey: definition.credentialKey,
      };
  }
  return { status: 'available' };
};

export type ResolvedBasemapStyle =
  | { status: 'available'; style: string | StyleSpecification }
  | Exclude<BasemapAvailability, { status: 'available' }>;

export const resolveBasemapStyle = (
  definition: BasemapDefinition<string>,
  credentials: MapServiceCredentials,
): ResolvedBasemapStyle => {
  const availability = basemapAvailability(definition, credentials);
  if (availability.status !== 'available') return availability;
  if (definition.styleSource.kind === 'vector-style-url')
    return { status: 'available', style: definition.styleSource.url };
  if (definition.styleSource.kind === 'credentialed-raster-style')
    return { status: 'available', style: definition.styleSource.createStyle(credentials) };
  return { status: 'available', style: definition.styleSource.style };
};

/** Compatibility helper for non-credentialed styles. Credentialed callers must use resolveBasemapStyle. */
export const basemapStyle = (definition: BasemapDefinition): string | StyleSpecification => {
  const resolved = resolveBasemapStyle(definition, { maptilerApiKey: '' });
  if (resolved.status !== 'available')
    throw new Error(`${definition.displayName} requires provider credentials.`);
  return resolved.style;
};

export const basemapUnavailableMessage = (definition: BasemapDefinition, status: BasemapAvailability) =>
  status.status === 'missing-credential'
    ? `${definition.displayName} requires a MapTiler API key. Configure it in Map Services.`
    : status.status === 'unsupported'
      ? `${definition.displayName} is unavailable: ${status.reason}`
      : '';

export const sanitizeBasemapError = (message: string) =>
  message.replace(/([?&]key=)[^&\s]+/gi, '$1[redacted]').replace(/https?:\/\/\S+/gi, '[provider resource]');

/** Non-production fixtures lock the Phase-12 vector/raster/credential contract. */
export const BASEMAP_CONTRACT_FIXTURES: readonly BasemapDefinition<string>[] = [
  {
    id: 'fixture-minimal-vector',
    displayName: 'Fixture Minimal Vector',
    family: 'minimal',
    providerId: 'mock',
    styleSource: { kind: 'vector-style-json', style: { version: 8, sources: {}, layers: [] } },
    capabilities: { ...openFreeMapCapabilities, labelLanguageSwitching: false },
    labelAdapter: 'none',
    attribution: { text: 'Fixture', requiredInApplication: true, requiredInExport: true },
  },
  {
    id: 'fixture-satellite-raster',
    displayName: 'Fixture Satellite Raster',
    family: 'satellite',
    providerId: 'mock',
    styleSource: { kind: 'raster-style-json', style: { version: 8, sources: {}, layers: [] } },
    capabilities: {
      ...openFreeMapCapabilities,
      vector: false,
      raster: true,
      satellite: true,
      labels: false,
      labelLanguageSwitching: false,
    },
    labelAdapter: 'none',
    attribution: { text: 'Fixture', requiredInApplication: true, requiredInExport: true },
  },
  {
    id: 'fixture-credentialed',
    displayName: 'Fixture Credentialed',
    family: 'satellite',
    providerId: 'maptiler',
    styleSource: { kind: 'raster-style-json', style: { version: 8, sources: {}, layers: [] } },
    capabilities: {
      ...openFreeMapCapabilities,
      vector: false,
      raster: true,
      satellite: true,
      requiresCredentials: true,
    },
    labelAdapter: 'none',
    attribution: {
      text: 'MapTiler · data providers',
      requiredInApplication: true,
      requiredInExport: true,
      logoRequired: true,
    },
    credentialKey: 'maptilerApiKey',
  },
] as const;

export class BasemapSwitchGeneration {
  private generation = 0;
  begin() {
    this.generation += 1;
    return this.generation;
  }
  isCurrent(generation: number) {
    return generation === this.generation;
  }
}
