import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-online-regions-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(entry, [
  `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
  `export * from '${join(root, 'src/core/regions').replaceAll('\\', '/')}';`,
  `export * from '${join(root, 'src/core/projectFile').replaceAll('\\', '/')}';`,
  `export * from '${join(root, 'src/core/onlineProjectOverlays').replaceAll('\\', '/')}';`,
].join('\n'));
let core;
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir, emptyOutDir: false, minify: false,
    lib: { entry, formats: ['es'], fileName: () => 'core.mjs' } } });
  core = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally { rmSync(outDir, { recursive: true, force: true }); }

assert.equal(core.ADMINISTRATIVE_REGIONS.length, 536);
const countries = core.ADMINISTRATIVE_REGIONS.filter((r) => r.kind === 'country');
const admin1 = core.ADMINISTRATIVE_REGIONS.filter((r) => r.kind === 'admin1');
assert.ok(countries.length > 200); assert.ok(admin1.length > 250);
const iran = countries.find((r) => r.countryCode === 'IRN');
assert.ok(iran); assert.ok(['Polygon', 'MultiPolygon'].includes(iran.geometry.type));
const iranLayer = core.createAdministrativeRegionLayer(iran);
assert.equal(iranLayer.regionSource, 'administrative'); assert.equal(iranLayer.regionGeometryEditable, false);
assert.equal(core.regionFeatureKey(iranLayer), `country:${iran.id}`);
assert.equal(core.findAdministrativeRegion([iranLayer], `country:${iran.id}`), iranLayer);
assert.ok(core.searchAdministrativeRegions('Iran').some((r) => r.countryCode === 'IRN'));
assert.ok(core.searchAdministrativeRegions('California').some((r) => r.kind === 'admin1'));

const triangle = [[51, 35], [52, 35], [51.5, 36]];
assert.equal(core.validCustomRegionRing(triangle), true);
assert.equal(core.validCustomRegionRing([[0, 0], [1, 1]]), false);
assert.equal(core.validCustomRegionRing([[0, 0], [1, 1], [2, 2]]), false);
const geometry = core.customRegionGeometry(triangle); assert.ok(geometry);
assert.deepEqual(geometry.coordinates[0][0], geometry.coordinates[0].at(-1));
const custom = core.createRegionLayer('Custom Region 1', geometry);
assert.equal(custom.regionSource, 'custom'); assert.equal(custom.regionGeometryEditable, true);
const collection = core.onlineRegionFeatureCollection([iranLayer, custom], custom.id);
assert.equal(collection.features.length, 2); assert.equal(collection.features[1].properties.selected, true);
assert.equal(collection.features[1].properties.fillOpacity, 0.35);
const serialized = core.serializeCanonicalProject({ ...core.createProject('Regions'), layers: [iranLayer, custom] });
assert.deepEqual(serialized.project.layers[0].regionGeometry, iran.geometry);
assert.deepEqual(serialized.project.layers[1].regionGeometry, geometry);
const fade = core.regionPresentation({ ...custom, regionAnimationEnabled: true, regionEffect: 'fade', regionEffectDuration: 2 }, 1);
assert.equal(fade.fillFactor, 0.5);
const draw = core.regionPresentation({ ...custom, regionAnimationEnabled: true, regionEffect: 'draw-border', regionEffectDuration: 2 }, 1);
assert.equal(draw.drawProgress, 1, 'Before Fill completes the border during the first phase');
assert.equal(draw.fillFactor, 0, 'Before Fill delays fill until the trace completes');
const after = core.regionPresentation({ ...custom, regionAnimationEnabled: true, regionEffect: 'draw-border', regionEffectDuration: 2, regionDrawOrder: 'after-fill' }, 1);
assert.equal(after.fillFactor, 1); assert.equal(after.drawProgress, 0);
const pulseA = core.regionPresentation({ ...custom, regionAnimationEnabled: true, regionEffect: 'pulse' }, 0.25);
const pulseB = core.regionPresentation({ ...custom, regionAnimationEnabled: true, regionEffect: 'pulse' }, 0.25);
assert.deepEqual(pulseA, pulseB);
console.log(`Online Regions: ${countries.length} countries, ${admin1.length} admin1 boundaries; identity, custom validation, persistence, batched overlays, and deterministic effects passed.`);
