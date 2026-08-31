import type { MapLabelLanguageMode } from './project';

export const MAPLIBRE_RTL_ASSET_PATH = 'assets/mapbox-gl-rtl-text.js';

export const resolveMapLibreRtlPluginUrl = (baseUrl: string, pageUrl: string) => {
  const resolved = new URL(MAPLIBRE_RTL_ASSET_PATH, new URL(baseUrl, pageUrl)).href;
  if (typeof resolved !== 'string' || !resolved || resolved.includes('[object%20Promise]'))
    throw new Error('MapLibre RTL plugin asset did not resolve to a concrete URL string.');
  return resolved;
};

export const mapLibreRtlPluginUrl = () =>
  resolveMapLibreRtlPluginUrl(import.meta.env.BASE_URL, window.location.href);

export const requiresMapLibreRtl = (mode: MapLabelLanguageMode) => mode === 'fa' || mode === 'both';

export const createMapLibreRtlInitializer = (
  getStatus: () => string,
  setPlugin: (url: string, lazy: boolean) => Promise<void>,
  resolveUrl: () => string,
) => {
  let ready: Promise<void> | null = null;
  return () => {
    const status = getStatus();
    if (status === 'loaded') return Promise.resolve();
    if (ready) return ready;
    if (status !== 'unavailable')
      return Promise.reject(new Error(`Unexpected MapLibre RTL plugin state: ${status}.`));
    const url = resolveUrl();
    if (typeof url !== 'string' || !url || String(url) === '[object Promise]')
      return Promise.reject(new Error('MapLibre RTL plugin URL must be a concrete string.'));
    ready = setPlugin(url, false);
    return ready;
  };
};
