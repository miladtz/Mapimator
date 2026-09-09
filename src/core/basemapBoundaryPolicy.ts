import type { FilterSpecification, Map as MapLibreMap } from 'maplibre-gl';

type BoundaryStyleLayer = {
  id: string;
  type: string;
  'source-layer'?: string;
  filter?: FilterSpecification;
};

const MARITIME_EXCLUSION: FilterSpecification = ['!=', ['get', 'maritime'], 1];

export const isOpenMapTilesBoundaryLine = (layer: BoundaryStyleLayer) =>
  layer.type === 'line' && layer['source-layer'] === 'boundary';

export const excludesMaritimeBoundaries = (filter: unknown): boolean =>
  Array.isArray(filter) &&
  ((filter[0] === '!=' &&
    Array.isArray(filter[1]) &&
    filter[1][0] === 'get' &&
    filter[1][1] === 'maritime' &&
    filter[2] === 1) ||
    filter.some(excludesMaritimeBoundaries));

export const landBoundaryFilter = (filter?: FilterSpecification | null): FilterSpecification => {
  if (excludesMaritimeBoundaries(filter)) return filter!;
  return filter ? (['all', filter, MARITIME_EXCLUSION] as FilterSpecification) : MARITIME_EXCLUSION;
};

export const applyLandOnlyBoundaryPolicy = (map: MapLibreMap) => {
  let changed = 0;
  for (const layer of map.getStyle().layers ?? []) {
    if (!isOpenMapTilesBoundaryLine(layer as BoundaryStyleLayer)) continue;
    const current = map.getFilter(layer.id) as FilterSpecification | null | undefined;
    if (excludesMaritimeBoundaries(current)) continue;
    map.setFilter(layer.id, landBoundaryFilter(current));
    changed += 1;
  }
  return changed;
};
