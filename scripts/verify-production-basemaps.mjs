import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (path) => readFileSync(join(root, path), 'utf8');
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-production-basemaps-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from '${join(root, 'src/core/basemaps').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/mapMotionBasemapStyles').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/basemapBoundaryPolicy').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/openFreeMapAdapter').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectPersistence').replaceAll('\\', '/')}';`,
  ].join('\n'),
);
let core;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'core.mjs' },
    },
  });
  core = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

for (const id of ['minimal-navy', 'minimal-light']) {
  const definition = core.basemapById(id);
  const resolved = core.resolveBasemapStyle(definition, { maptilerApiKey: '' });
  assert.equal(resolved.status, 'available');
  assert.equal(validateStyleMin(resolved.style).length, 0, `${id} must be a valid MapLibre style`);
  assert.equal(definition.capabilities.labelLanguageSwitching, true);
  assert.equal(definition.attribution.requiredInExport, true);
}
assert.equal(core.MINIMAL_NAVY_PALETTE.water, '#071a30');
assert.equal(core.MINIMAL_NAVY_PALETTE.land, '#18324a');
assert.equal(core.MINIMAL_LIGHT_PALETTE.background, '#eeeae1');
assert.equal(core.MINIMAL_LIGHT_PALETTE.label, '#394652');

const satellite = core.basemapById('satellite');
assert.equal(core.resolveBasemapStyle(satellite, { maptilerApiKey: '' }).status, 'missing-credential');
const satelliteResolved = core.resolveBasemapStyle(satellite, { maptilerApiKey: 'key with spaces' });
assert.equal(satelliteResolved.status, 'available');
assert.equal(validateStyleMin(satelliteResolved.style).length, 0);
assert.equal(satelliteResolved.style.sources.satellite.type, 'raster');
assert.equal(satelliteResolved.style.sources.satellite.tileSize, 512);
assert.match(
  satelliteResolved.style.sources.satellite.url,
  /\/tiles\/satellite-v2\/tiles\.json\?key=key%20with%20spaces$/,
);
assert.equal(satellite.capabilities.vector, true);
assert.equal(satellite.capabilities.labels, true);
assert.equal(satellite.capabilities.labelLanguageSwitching, true);
assert.equal(satellite.labelAdapter, 'openfreemap');
assert.deepEqual(satellite.referenceOverlay, {
  providerId: 'openfreemap',
  labelAdapter: 'openfreemap',
});
assert.equal(satellite.capabilities.globe, false);
assert.equal(
  satellite.attribution.text,
  '© MapTiler · OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors',
);
assert.match(satelliteResolved.style.sources.satellite.attribution, /maptiler\.com\/copyright/);
assert.equal(satelliteResolved.style.sources['satellite-reference'].type, 'vector');
assert.equal(satelliteResolved.style.sources['satellite-reference'].url, core.OPENFREEMAP_VECTOR_SOURCE);
assert.match(satelliteResolved.style.sources['satellite-reference'].attribution, /openfreemap\.org/);
assert.match(satelliteResolved.style.sources['satellite-reference'].attribution, /openmaptiles\.org/);
assert.match(
  satelliteResolved.style.sources['satellite-reference'].attribution,
  /openstreetmap\.org\/copyright/,
);

const satelliteLayerIds = satelliteResolved.style.layers.map(({ id }) => id);
assert.deepEqual(satelliteLayerIds, [
  'satellite-background',
  'satellite-imagery',
  'satellite-reference-country-boundaries',
  'satellite-reference-admin-boundaries',
  'satellite-reference-country-labels',
  'satellite-reference-major-place-labels',
]);
for (const id of ['satellite-reference-country-labels', 'satellite-reference-major-place-labels']) {
  const layer = satelliteResolved.style.layers.find((candidate) => candidate.id === id);
  assert.equal(layer.type, 'symbol');
  assert.equal(layer.source, 'satellite-reference');
  assert.match(JSON.stringify(layer.layout['text-field']), /name:latin|name_en|name/);
  assert.ok(layer.paint['text-halo-width'], `${id} must remain legible over imagery`);
}
for (const id of ['satellite-reference-country-boundaries', 'satellite-reference-admin-boundaries']) {
  const layer = satelliteResolved.style.layers.find((candidate) => candidate.id === id);
  assert.equal(layer.type, 'line');
  assert.equal(layer.source, 'satellite-reference');
  assert.equal(core.excludesMaritimeBoundaries(core.landBoundaryFilter(layer.filter)), true);
}
assert.equal(
  satelliteResolved.style.layers.some(({ id }) => /road/i.test(id)),
  false,
  'Satellite reference overlay intentionally omits roads to keep imagery dominant',
);

const satelliteLayer = satelliteResolved.style.layers.find((layer) => layer.id === 'satellite-imagery');
assert.equal(satelliteLayer.type, 'raster');
assert.equal(satelliteLayer.minzoom, undefined);
assert.equal(satelliteLayer.maxzoom, undefined);
assert.deepEqual(satelliteLayer.paint, { 'raster-opacity': 1 });

// MapLibre rounds raster cover zoom after applying the 512px renderer/source tile-size ratio.
// A wrong 256px source declaration requests one level too deep and previously crossed the
// legacy Satellite v1 z6 -> empty z7 boundary near MapMotion zoom 42.85 at 960x540.
const rasterRequestZoom = (mapLibreZoom, sourceTileSize, nativeMaxZoom = 22) =>
  Math.min(nativeMaxZoom, Math.max(0, Math.round(mapLibreZoom + Math.log2(512 / sourceTileSize))));
const canonicalWorldFitZoom = Math.log2(540 / 512);
for (const mapMotionZoom of [20, 30, 35, 40, 42, 46, 50, 75, 100, 500]) {
  const mapLibreZoom = Math.log2(mapMotionZoom) + canonicalWorldFitZoom;
  assert.equal(
    rasterRequestZoom(mapLibreZoom, satelliteResolved.style.sources.satellite.tileSize),
    Math.round(mapLibreZoom),
    `Satellite must not request an unintended extra raster level at MapMotion zoom ${mapMotionZoom}`,
  );
}
assert.equal(rasterRequestZoom(Math.log2(500) + canonicalWorldFitZoom, 512), 9);
assert.equal(rasterRequestZoom(Math.log2(500) + canonicalWorldFitZoom, 256), 10);

const existingLandFilter = ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]];
assert.equal(core.excludesMaritimeBoundaries(existingLandFilter), true);
assert.equal(core.landBoundaryFilter(existingLandFilter), existingLandFilter);
assert.deepEqual(core.landBoundaryFilter(['==', ['get', 'admin_level'], 4]), [
  'all',
  ['==', ['get', 'admin_level'], 4],
  ['!=', ['get', 'maritime'], 1],
]);
assert.deepEqual(core.landBoundaryFilter(), ['!=', ['get', 'maritime'], 1]);
assert.deepEqual(core.landBoundaryFilter(null), ['!=', ['get', 'maritime'], 1]);
assert.equal(
  core.isOpenMapTilesBoundaryLine({ id: 'coastline', type: 'line', 'source-layer': 'water' }),
  false,
  'coastline/water layers must not be filtered',
);

const runtimeFilters = new Map([
  ['boundary_state', ['==', ['get', 'admin_level'], 4]],
  ['boundary_country_z0-4', ['==', ['get', 'admin_level'], 2]],
  ['boundary_country_z5-', ['==', ['get', 'admin_level'], 2]],
  ['coastline', undefined],
]);
const runtimeChanges = [];
const boundaryPolicyMap = {
  getStyle: () => ({
    layers: [
      ...['boundary_state', 'boundary_country_z0-4', 'boundary_country_z5-'].map((id) => ({
        id,
        type: 'line',
        'source-layer': 'boundary',
      })),
      { id: 'coastline', type: 'line', 'source-layer': 'water' },
    ],
  }),
  getFilter: (id) => runtimeFilters.get(id),
  setFilter: (id, filter) => {
    runtimeFilters.set(id, filter);
    runtimeChanges.push(id);
  },
};
assert.equal(core.applyLandOnlyBoundaryPolicy(boundaryPolicyMap), 3);
assert.deepEqual(runtimeChanges, ['boundary_state', 'boundary_country_z0-4', 'boundary_country_z5-']);
assert.equal(runtimeFilters.get('coastline'), undefined, 'coastline remains untouched at runtime');
for (const id of runtimeChanges) assert.equal(core.excludesMaritimeBoundaries(runtimeFilters.get(id)), true);

for (const id of ['minimal-navy', 'minimal-light', 'satellite'])
  assert.equal(core.basemapById(id).boundaryAdapter, 'openmaptiles-land-only');
assert.equal(core.basemapById('dark').boundaryAdapter, 'openmaptiles-land-only');
assert.equal(core.basemapById('liberty').boundaryAdapter, undefined, 'accepted Liberty remains unchanged');

for (const id of ['minimal-navy', 'minimal-light', 'satellite']) {
  const project = core.createProject(`Persist ${id}`);
  const camera = project.views[0]?.camera;
  const layers = project.layers;
  const views = project.views;
  const transitions = project.transitions;
  const switched = core.setProjectBasemap(project, id);
  assert.equal(switched.layers, layers);
  assert.equal(switched.views, views);
  assert.equal(switched.transitions, transitions);
  assert.equal(switched.views[0]?.camera, camera);
  assert.equal(core.validateAndMigrateProject(structuredClone(switched)).mapSettings.onlineStyleId, id);
}

const interactive = source('src/components/OnlineOpenFreeMap.tsx');
const exportRenderer = source('src/core/onlineMapFrameRenderer.ts');
const overlays = source('src/core/onlineProjectOverlays.ts');
const settings = source('src/core/mapServiceSettings.ts');
const app = source('src/app/App.tsx');
assert.match(interactive, /resolveBasemapStyle\(definition, mapServiceSettings/);
assert.match(interactive, /BasemapSwitchGeneration/);
assert.match(interactive, /applyBasemapBoundaryPolicy\(map!, activeDefinition\)/);
assert.match(interactive, /maptiler-attribution-logo/);
assert.match(exportRenderer, /loadMapServiceSettings/);
assert.match(exportRenderer, /resolveBasemapStyle\(basemap, mapServiceSettings\)/);
assert.match(exportRenderer, /applyBasemapBoundaryPolicy\(map, basemap\)/);
assert.match(exportRenderer, /areTilesLoaded\(\)/);
assert.match(exportRenderer, /refreshExpiredTiles: false/);
assert.doesNotMatch(overlays, /minimal-navy|minimal-light|satellite/);
assert.match(settings, /VITE_MAPMOTION_MAPTILER_API_KEY/);
assert.doesNotMatch(settings, /console\./);
assert.match(app, /MapTiler key required/);
assert.match(app, /MapServicesPanel/);

console.log('Production Satellite, Minimal Navy, and Minimal Light basemap contracts passed.');
