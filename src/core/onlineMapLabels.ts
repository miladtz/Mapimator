import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import { createMapLibreRtlInitializer, mapLibreRtlPluginUrl } from './mapLibreRtlAsset';
import {
  blockedEnglishNameProperties,
  isOnlineProjectOverlayLayer,
  mapLabelTextField,
  shouldHideOnlineMapLayer,
  type MapLibreTextField,
  type OnlineMapStyleLayer,
} from './onlineMapLabelPolicy';
import type { MapLabelLanguageMode } from './project';
import type { BasemapDefinition } from './basemaps';
import { applyLandOnlyBoundaryPolicy } from './basemapBoundaryPolicy';

type OriginalLayerPresentation = {
  textField?: MapLibreTextField;
  visibility: 'visible' | 'none';
};

const originalsByMap = new WeakMap<MapLibreMap, Map<string, OriginalLayerPresentation>>();
export const ensureMapLibreRtlSupport = createMapLibreRtlInitializer(
  () => maplibregl.getRTLTextPluginStatus(),
  (url, lazy) => maplibregl.setRTLTextPlugin(url, lazy),
  () => {
    const rtlTextPluginUrl = mapLibreRtlPluginUrl();
    if (import.meta.env.DEV)
      console.info('[OpenFreeMap RTL] initializing worker plugin', { url: rtlTextPluginUrl });
    return rtlTextPluginUrl;
  },
);

/**
 * Applies the project label policy to every current text-bearing symbol layer.
 * `styleReloaded` captures a fresh immutable baseline after setStyle(), so
 * switching language never compounds expressions or loses style-owned refs.
 */
export const applyOnlineMapLabelLanguage = (
  map: MapLibreMap,
  mode: MapLabelLanguageMode,
  styleReloaded = false,
) => {
  let originals = originalsByMap.get(map);
  if (!originals || styleReloaded) {
    originals = new Map();
    originalsByMap.set(map, originals);
  }
  let changed = 0;
  const unsafeEnglishLayers: Array<{ id: string; sourceLayer?: string; properties: string[] }> = [];
  for (const layer of map.getStyle().layers ?? []) {
    if (isOnlineProjectOverlayLayer(layer as OnlineMapStyleLayer)) continue;
    const currentTextField =
      layer.type === 'symbol'
        ? (map.getLayoutProperty(layer.id, 'text-field') as MapLibreTextField | undefined)
        : undefined;
    if (!originals.has(layer.id)) {
      originals.set(layer.id, {
        textField: currentTextField,
        visibility:
          (map.getLayoutProperty(layer.id, 'visibility') as 'visible' | 'none' | undefined) ?? 'visible',
      });
    }
    const original = originals.get(layer.id)!;
    const policyLayer = layer as OnlineMapStyleLayer;
    map.setLayoutProperty(
      layer.id,
      'visibility',
      shouldHideOnlineMapLayer(policyLayer, mode) ? 'none' : original.visibility,
    );
    if (original.textField !== undefined) {
      map.setLayoutProperty(layer.id, 'text-field', mapLabelTextField(original.textField, mode));
      if (import.meta.env.DEV && mode === 'en') {
        const applied = map.getLayoutProperty(layer.id, 'text-field');
        const properties = blockedEnglishNameProperties(applied);
        if (properties.length)
          unsafeEnglishLayers.push({
            id: layer.id,
            sourceLayer: 'source-layer' in layer ? layer['source-layer'] : undefined,
            properties,
          });
      }
    }
    changed += 1;
  }
  if (import.meta.env.DEV && unsafeEnglishLayers.length)
    console.warn('[OpenFreeMap Labels] unsafe English expressions', unsafeEnglishLayers);
  return changed;
};

export const applyBasemapLabelLanguage = (
  map: MapLibreMap,
  basemap: BasemapDefinition,
  mode: MapLabelLanguageMode,
  styleReloaded = false,
) => {
  if (!basemap.capabilities.labels || basemap.labelAdapter === 'none')
    return { applied: false, changed: 0, reason: 'unsupported' as const };
  if (basemap.labelAdapter === 'openfreemap')
    return {
      applied: true,
      changed: applyOnlineMapLabelLanguage(map, mode, styleReloaded),
    } as const;
  return { applied: false, changed: 0, reason: 'unsupported' as const };
};

export const applyBasemapBoundaryPolicy = (map: MapLibreMap, basemap: BasemapDefinition) =>
  basemap.boundaryAdapter === 'openmaptiles-land-only'
    ? { applied: true, changed: applyLandOnlyBoundaryPolicy(map) }
    : { applied: false, changed: 0 };
