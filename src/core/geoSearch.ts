import { invoke } from '@tauri-apps/api/core';
import {
  normalizePhotonResults,
  type PhotonFeature,
  type SearchProvider,
  type SearchResult,
} from './locationSearch';

export type GeoEntity = SearchResult;
export type GeoSearchProvider = SearchProvider;

export const PHOTON_GEO_SEARCH_LIMIT = 10;

interface PhotonResponse {
  features?: PhotonFeature[];
}

/** Native Photon adapter. Consumers see only normalized GeoEntity values. */
export class PhotonGeoSearchProvider implements GeoSearchProvider {
  readonly id = 'photon';
  readonly attribution = 'Photon · © OpenStreetMap contributors';

  async search(query: string, signal: AbortSignal): Promise<GeoEntity[]> {
    if (signal.aborted) throw new DOMException('Search cancelled.', 'AbortError');
    const response = await invoke<PhotonResponse>('search_photon', {
      query: query.trim(),
      limit: PHOTON_GEO_SEARCH_LIMIT,
    });
    if (signal.aborted) throw new DOMException('Search cancelled.', 'AbortError');
    return normalizePhotonResults(response.features ?? []);
  }
}
