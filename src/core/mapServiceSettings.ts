import { invoke } from '@tauri-apps/api/core';
import type { MapServiceCredentials } from './basemaps';

export const EMPTY_MAP_SERVICE_SETTINGS: MapServiceCredentials = { maptilerApiKey: '' };

const environmentSettings = (): MapServiceCredentials => ({
  maptilerApiKey: String(import.meta.env.VITE_MAPMOTION_MAPTILER_API_KEY ?? '').trim(),
});

export const loadMapServiceSettings = async (): Promise<MapServiceCredentials> => {
  let stored = EMPTY_MAP_SERVICE_SETTINGS;
  try {
    stored = await invoke<MapServiceCredentials>('read_map_service_settings');
  } catch {
    // Browser-only development has no native application settings store.
  }
  return {
    maptilerApiKey: stored.maptilerApiKey.trim() || environmentSettings().maptilerApiKey,
  };
};

export const saveMapServiceSettings = (settings: MapServiceCredentials) =>
  invoke('write_map_service_settings', {
    settings: { maptilerApiKey: settings.maptilerApiKey.trim() },
  });

/** Credentials are injected at style-resolution time and never enter Project data. */
export const mapServiceCredential = (settings: MapServiceCredentials, key: keyof MapServiceCredentials) =>
  settings[key].trim();
