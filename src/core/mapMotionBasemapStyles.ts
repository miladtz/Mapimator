import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';

export const OPENFREEMAP_VECTOR_SOURCE = 'https://tiles.openfreemap.org/planet';
export const OPENFREEMAP_GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
export const OPENFREEMAP_REFERENCE_ATTRIBUTION =
  'OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors';

export interface MinimalBasemapPalette {
  background: string;
  land: string;
  residential: string;
  park: string;
  water: string;
  waterway: string;
  building: string;
  boundary: string;
  roadMajor: string;
  roadMinor: string;
  roadCasing: string;
  label: string;
  labelHalo: string;
  waterLabel: string;
}

export const MINIMAL_NAVY_PALETTE: MinimalBasemapPalette = {
  background: '#0b1d33',
  land: '#18324a',
  residential: '#1d3951',
  park: '#173f43',
  water: '#071a30',
  waterway: '#24506c',
  building: '#29465d',
  boundary: '#68839a',
  roadMajor: '#718ba0',
  roadMinor: '#405d73',
  roadCasing: '#10283e',
  label: '#dbe6ed',
  labelHalo: '#10283e',
  waterLabel: '#8fb4ca',
};

export const MINIMAL_LIGHT_PALETTE: MinimalBasemapPalette = {
  background: '#eeeae1',
  land: '#f3f0e8',
  residential: '#ebe7de',
  park: '#dfe9dc',
  water: '#d7e6eb',
  waterway: '#b8d3dc',
  building: '#ddd9d0',
  boundary: '#a9a59d',
  roadMajor: '#c2bdb3',
  roadMinor: '#d7d2c8',
  roadCasing: '#f7f4ed',
  label: '#394652',
  labelHalo: '#f3f0e8',
  waterLabel: '#607f91',
};

const nameExpression: any = ['coalesce', ['get', 'name:latin'], ['get', 'name_en'], ['get', 'name']];

const roadFilter: any = ['==', ['geometry-type'], 'LineString'];

const minimalLayers = (palette: MinimalBasemapPalette): LayerSpecification[] => [
  { id: 'background', type: 'background', paint: { 'background-color': palette.land } },
  {
    id: 'land',
    type: 'fill',
    source: 'openmaptiles',
    'source-layer': 'landcover',
    paint: { 'fill-color': palette.land },
  },
  {
    id: 'landuse-residential',
    type: 'fill',
    source: 'openmaptiles',
    'source-layer': 'landuse',
    filter: ['==', ['get', 'class'], 'residential'],
    paint: { 'fill-color': palette.residential, 'fill-opacity': 0.68 },
  },
  {
    id: 'parks',
    type: 'fill',
    source: 'openmaptiles',
    'source-layer': 'park',
    paint: { 'fill-color': palette.park, 'fill-opacity': 0.76 },
  },
  {
    id: 'water',
    type: 'fill',
    source: 'openmaptiles',
    'source-layer': 'water',
    paint: { 'fill-color': palette.water },
  },
  {
    id: 'waterways',
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'waterway',
    paint: {
      'line-color': palette.waterway,
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.35, 13, 1.5],
      'line-opacity': 0.78,
    },
  },
  {
    id: 'buildings',
    type: 'fill',
    source: 'openmaptiles',
    'source-layer': 'building',
    minzoom: 13,
    paint: { 'fill-color': palette.building, 'fill-opacity': 0.66 },
  },
  {
    id: 'boundaries',
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'boundary',
    filter: ['<=', ['coalesce', ['get', 'admin_level'], 99], 4],
    paint: {
      'line-color': palette.boundary,
      'line-opacity': 0.62,
      'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.45, 8, 1.05],
      'line-dasharray': [3, 2],
    },
  },
  {
    id: 'roads-casing',
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'transportation',
    minzoom: 5,
    filter: roadFilter,
    paint: {
      'line-color': palette.roadCasing,
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 16, 7],
      'line-opacity': 0.68,
    },
  },
  {
    id: 'roads',
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'transportation',
    minzoom: 5,
    filter: roadFilter,
    paint: {
      'line-color': [
        'match',
        ['get', 'class'],
        ['motorway', 'trunk', 'primary'],
        palette.roadMajor,
        palette.roadMinor,
      ],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.35, 16, 4.5],
      'line-opacity': 0.82,
    },
  },
  {
    id: 'country-labels',
    type: 'symbol',
    source: 'openmaptiles',
    'source-layer': 'place',
    filter: ['==', ['get', 'class'], 'country'],
    layout: {
      'text-field': nameExpression,
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 1, 10, 6, 15],
      'text-letter-spacing': 0.08,
      'text-max-width': 8,
    },
    paint: {
      'text-color': palette.label,
      'text-halo-color': palette.labelHalo,
      'text-halo-width': 1.2,
      'text-halo-blur': 0.4,
    },
  },
  {
    id: 'place-labels',
    type: 'symbol',
    source: 'openmaptiles',
    'source-layer': 'place',
    minzoom: 3,
    filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village']]],
    layout: {
      'text-field': nameExpression,
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 12, 15],
      'text-max-width': 9,
    },
    paint: {
      'text-color': palette.label,
      'text-halo-color': palette.labelHalo,
      'text-halo-width': 1.1,
      'text-halo-blur': 0.35,
    },
  },
  {
    id: 'water-labels',
    type: 'symbol',
    source: 'openmaptiles',
    'source-layer': 'water_name',
    layout: {
      'text-field': nameExpression,
      'text-font': ['Noto Sans Italic'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 10, 14],
      'text-max-width': 8,
    },
    paint: {
      'text-color': palette.waterLabel,
      'text-halo-color': palette.labelHalo,
      'text-halo-width': 1,
    },
  },
];

export const createMinimalBasemapStyle = (
  name: string,
  palette: MinimalBasemapPalette,
): StyleSpecification => ({
  version: 8,
  name,
  glyphs: OPENFREEMAP_GLYPHS,
  sources: {
    openmaptiles: { type: 'vector', url: OPENFREEMAP_VECTOR_SOURCE },
  },
  layers: minimalLayers(palette),
});

export const MINIMAL_NAVY_STYLE = createMinimalBasemapStyle('MapMotion Minimal Navy', MINIMAL_NAVY_PALETTE);
export const MINIMAL_LIGHT_STYLE = createMinimalBasemapStyle(
  'MapMotion Minimal Light',
  MINIMAL_LIGHT_PALETTE,
);

export const createMapTilerSatelliteStyle = (apiKey: string): StyleSpecification => ({
  version: 8,
  name: 'MapMotion Satellite Hybrid',
  glyphs: OPENFREEMAP_GLYPHS,
  sources: {
    satellite: {
      type: 'raster',
      url: `https://api.maptiler.com/tiles/satellite-v2/tiles.json?key=${encodeURIComponent(apiKey)}`,
      tileSize: 512,
      attribution: '<a href="https://www.maptiler.com/copyright/" target="_blank">© MapTiler</a>',
    },
    'satellite-reference': {
      type: 'vector',
      url: OPENFREEMAP_VECTOR_SOURCE,
      attribution:
        '<a href="https://openfreemap.org/" target="_blank">OpenFreeMap</a> ' +
        '<a href="https://openmaptiles.org/" target="_blank">© OpenMapTiles</a> · ' +
        '<a href="https://www.openstreetmap.org/copyright" target="_blank">Data © OpenStreetMap contributors</a>',
    },
  },
  layers: [
    { id: 'satellite-background', type: 'background', paint: { 'background-color': '#102235' } },
    { id: 'satellite-imagery', type: 'raster', source: 'satellite', paint: { 'raster-opacity': 1 } },
    {
      id: 'satellite-reference-country-boundaries',
      type: 'line',
      source: 'satellite-reference',
      'source-layer': 'boundary',
      filter: ['<=', ['to-number', ['coalesce', ['get', 'admin_level'], 99]], 2],
      paint: {
        'line-color': 'rgba(238, 244, 250, 0.82)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.55, 7, 1.15, 13, 1.5],
        'line-opacity': 0.74,
      },
    },
    {
      id: 'satellite-reference-admin-boundaries',
      type: 'line',
      source: 'satellite-reference',
      'source-layer': 'boundary',
      minzoom: 4,
      filter: [
        'all',
        ['>', ['to-number', ['coalesce', ['get', 'admin_level'], 99]], 2],
        ['<=', ['to-number', ['coalesce', ['get', 'admin_level'], 99]], 4],
      ],
      paint: {
        'line-color': 'rgba(225, 234, 241, 0.62)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.35, 12, 0.9],
        'line-opacity': 0.52,
        'line-dasharray': [3, 2],
      },
    },
    {
      id: 'satellite-reference-country-labels',
      type: 'symbol',
      source: 'satellite-reference',
      'source-layer': 'place',
      maxzoom: 8,
      filter: ['==', ['get', 'class'], 'country'],
      layout: {
        'text-field': nameExpression,
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 1, 11, 5, 15, 8, 17],
        'text-letter-spacing': 0.08,
        'text-max-width': 8,
        'text-allow-overlap': false,
        'text-padding': 4,
      },
      paint: {
        'text-color': '#f5f7f8',
        'text-halo-color': 'rgba(17, 25, 32, 0.92)',
        'text-halo-width': 1.6,
        'text-halo-blur': 0.5,
      },
    },
    {
      id: 'satellite-reference-major-place-labels',
      type: 'symbol',
      source: 'satellite-reference',
      'source-layer': 'place',
      minzoom: 2,
      filter: [
        'all',
        ['in', ['get', 'class'], ['literal', ['city', 'town']]],
        ['<=', ['to-number', ['coalesce', ['get', 'rank'], 99]], 7],
      ],
      layout: {
        'text-field': nameExpression,
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 7, 13, 13, 15],
        'text-max-width': 8,
        'text-allow-overlap': false,
        'text-padding': 5,
      },
      paint: {
        'text-color': '#f5f7f8',
        'text-halo-color': 'rgba(15, 23, 30, 0.94)',
        'text-halo-width': 1.5,
        'text-halo-blur': 0.45,
      },
    },
  ],
});
