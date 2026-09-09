import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (path) => readFileSync(join(root, path), 'utf8');
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-basemaps-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from '${join(root, 'src/core/basemaps').replaceAll('\\', '/')}';`,
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

assert.deepEqual(core.BASEMAP_IDS, [
  '3d',
  'liberty',
  'dark',
  'bright',
  'minimal-navy',
  'minimal-light',
  'satellite',
]);
for (const id of ['3d', 'liberty', 'dark', 'bright']) {
  const definition = core.basemapById(id);
  assert.equal(definition.id, id);
  assert.equal(definition.providerId, 'openfreemap');
  assert.equal(definition.styleSource.kind, 'vector-style-url');
  assert.equal(definition.capabilities.labelLanguageSwitching, true);
  assert.equal(core.basemapAvailability(definition, { maptilerApiKey: '' }).status, 'available');
}
assert.equal(core.basemapById('liberty').styleSource.url, 'https://tiles.openfreemap.org/styles/liberty');
for (const id of ['minimal-navy', 'minimal-light']) {
  const definition = core.basemapById(id);
  assert.equal(definition.providerId, 'openfreemap');
  assert.equal(definition.styleSource.kind, 'vector-style-json');
  assert.equal(definition.capabilities.labelLanguageSwitching, true);
  assert.equal(definition.boundaryAdapter, 'openmaptiles-land-only');
}
assert.equal(core.basemapById('dark').boundaryAdapter, 'openmaptiles-land-only');
assert.equal(core.basemapById('liberty').boundaryAdapter, undefined);
const satellite = core.basemapById('satellite');
assert.equal(satellite.providerId, 'maptiler');
assert.equal(satellite.styleSource.kind, 'credentialed-raster-style');
assert.equal(satellite.capabilities.raster, true);
assert.equal(satellite.capabilities.vector, true);
assert.equal(satellite.capabilities.labels, true);
assert.equal(satellite.capabilities.labelLanguageSwitching, true);
assert.equal(satellite.labelAdapter, 'openfreemap');
assert.equal(satellite.referenceOverlay.providerId, 'openfreemap');
assert.equal(satellite.boundaryAdapter, 'openmaptiles-land-only');
assert.equal(core.basemapAvailability(satellite, { maptilerApiKey: '' }).status, 'missing-credential');

const vector = core.BASEMAP_CONTRACT_FIXTURES.find(({ id }) => id === 'fixture-minimal-vector');
const raster = core.BASEMAP_CONTRACT_FIXTURES.find(({ id }) => id === 'fixture-satellite-raster');
const credentialed = core.BASEMAP_CONTRACT_FIXTURES.find(({ id }) => id === 'fixture-credentialed');
assert.equal(vector.styleSource.kind, 'vector-style-json');
assert.equal(vector.capabilities.vector, true);
assert.equal(raster.styleSource.kind, 'raster-style-json');
assert.equal(raster.capabilities.satellite, true);
assert.equal(core.basemapAvailability(credentialed, { maptilerApiKey: '' }).status, 'missing-credential');
assert.equal(core.basemapAvailability(credentialed, { maptilerApiKey: 'external-key' }).status, 'available');

const generation = new core.BasemapSwitchGeneration();
const oldRequest = generation.begin();
const currentRequest = generation.begin();
assert.equal(generation.isCurrent(oldRequest), false);
assert.equal(generation.isCurrent(currentRequest), true);

const project = core.createProject('Basemap invariance');
const views = project.views;
const transitions = project.transitions;
const layers = project.layers;
const switched = core.setProjectBasemap(project, 'dark');
assert.equal(switched.mapSettings.onlineStyleId, 'dark');
assert.equal(switched.views, views, 'style switching must not mutate or recreate Views');
assert.equal(switched.transitions, transitions, 'style switching must not mutate or recreate Transitions');
assert.equal(switched.layers, layers, 'style switching must not mutate or recreate overlays');
assert.equal(project.mapSettings.onlineStyleId, 'liberty', 'the source Project is immutable');
const reopened = core.validateAndMigrateProject(structuredClone(switched));
assert.equal(reopened.mapSettings.onlineStyleId, 'dark');
const legacy = structuredClone(project);
delete legacy.mapSettings.onlineStyleId;
assert.equal(core.validateAndMigrateProject(legacy).mapSettings.onlineStyleId, 'liberty');

const app = source('src/app/App.tsx');
const interactive = source('src/components/OnlineOpenFreeMap.tsx');
const frame = source('src/core/onlineMapFrameRenderer.ts');
const labels = source('src/core/onlineMapLabels.ts');
const overlays = source('src/core/onlineProjectOverlays.ts');
const settings = source('src/core/mapServiceSettings.ts');
assert.match(app, /BASEMAPS\.map/, 'UI consumes the canonical registry');
assert.match(app, /setProjectBasemap/, 'UI uses presentation-only mutation');
assert.doesNotMatch(app, /onlineStyle === '3d'\) setCamera/, 'styles never apply default cameras');
assert.match(interactive, /resolveBasemapStyle\(definition/, 'Editor resolves the canonical definition');
assert.match(interactive, /BasemapSwitchGeneration/, 'rapid switches are generation guarded');
assert.match(frame, /resolveBasemapStyle\(basemap/, 'Export resolves the same canonical definition');
assert.match(labels, /applyBasemapLabelLanguage/, 'labels use a basemap adapter boundary');
assert.match(overlays, /onlineOverlayRepresentativeForLayer/, 'overlay ordering is provider neutral');
assert.doesNotMatch(overlays, /road-label|place-label|water-label/, 'overlays do not use basemap layer IDs');
assert.match(settings, /read_map_service_settings/);
assert.doesNotMatch(settings, /console\.(?:log|info|debug).*ApiKey/, 'credentials are never logged');

console.log('Basemap registry, switching, capabilities, credentials, and parity contract passed.');
