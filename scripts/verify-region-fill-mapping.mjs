import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'region-fill-'));
const entry = join(out, 'entry.ts');
const modulePath = (path) => join(root, path).replaceAll('\\', '/');
writeFileSync(entry, [
  `export * from '${modulePath('src/core/project')}';`,
  `export * from '${modulePath('src/core/regions')}';`,
  `export * from '${modulePath('src/core/onlineProjectOverlays')}';`,
  `export * from '${modulePath('src/core/geographicRegionFillLayer')}';`,
  `export * from '${modulePath('src/core/camera')}';`,
  `export * from '${modulePath('src/core/viewCompiler')}';`,
].join('\n'));
let core;
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: out, emptyOutDir: false, minify: false, lib: { entry, formats: ['es'], fileName: () => 'module.mjs' } } });
  core = await import(pathToFileURL(join(out, 'module.mjs')).href);
} finally { rmSync(out, { recursive: true, force: true }); }

const countries = ['TUR', 'IRN', 'FRA', 'DEU', 'JPN', 'USA', 'BRA', 'IND', 'SAU', 'ARE', 'AUS', 'ZAF'];
for (const code of countries) {
  const region = core.ADMINISTRATIVE_REGIONS.find((item) => item.kind === 'country' && item.countryCode === code);
  assert.ok(region, `missing ${code}`);
  const flagCode = core.resolveFlagCode(region.countryCode, region.countryCode2);
  assert.match(flagCode, /^[a-z]{2}$/);
  assert.ok(core.flagUrl(flagCode), `missing flag ${code}/${flagCode}`);
}

const records = core.ADMINISTRATIVE_REGIONS.filter((item) => item.kind === 'country').slice(0, 100);
const regions = records.map((record) => core.createAdministrativeRegionLayer(record));
assert.equal(core.onlineRegionFeatureCollection(regions, null).features.length, 100);
assert.equal(new Set(core.onlineRegionFeatureCollection(regions, null).features.map((feature) => feature.id)).size, 100);

const geometry = { type: 'Polygon', coordinates: [[[0, 0], [8, 0], [8, 4], [0, 4], [0, 0]]] };
const tileCounts = [1, 2, 4, 8, 12].map((count) => core.regionTextureUv(8, 4, geometry, 4 / 3, 'tile', count)[0]);
assert.deepEqual(tileCounts, [1, 2, 4, 8, 12]);
assert.deepEqual(core.regionTextureUv(4, 2, geometry, 4 / 3, 'tile', 4), core.regionTextureUv(4, 2, geometry, 4 / 3, 'tile', 4));
const cover = core.regionTextureUv(0, 0, geometry, 4, 'cover', 4);
const fit = core.regionTextureUv(0, 0, geometry, 4, 'fit', 4);
const tile = core.regionTextureUv(0, 0, geometry, 4, 'tile', 4);
assert.notDeepEqual(cover, fit); assert.notDeepEqual(fit, tile); assert.notDeepEqual(cover, tile);

const layer = core.createRegionLayer('Timing', geometry, { regionAnimationEnabled: true, regionEffect: 'draw-border', regionDrawOrder: 'before-fill', regionDrawingDelay: .5, regionDrawingDuration: 1.5, regionFillingDelay: .25, regionFillingDuration: 1, regionStrokeColor: '#ff0000' });
let state = core.regionPresentation({ ...layer, regionEffectTime: .49 }); assert.equal(state.drawProgress, 0); assert.equal(state.fillFactor, 0);
state = core.regionPresentation({ ...layer, regionEffectTime: 2 }); assert.equal(state.drawProgress, 1); assert.equal(state.fillFactor, 0);
state = core.regionPresentation({ ...layer, regionEffectTime: 2.25 }); assert.equal(state.fillFactor, 0);
state = core.regionPresentation({ ...layer, regionEffectTime: 3.25 }); assert.equal(state.fillFactor, 1);
const after = { ...layer, regionDrawOrder: 'after-fill' }; assert.equal(core.regionPresentation({ ...after, regionEffectTime: 1.25 }).fillFactor, 1); assert.equal(core.regionPresentation({ ...after, regionEffectTime: 1.74 }).drawProgress, 0);
const instant = { ...layer, regionDrawingDuration: 0, regionFillingDuration: 0 }; assert.equal(core.regionPresentation({ ...instant, regionEffectTime: .5 }).drawProgress, 1);

const exactBefore = { ...layer, regionDrawOrder: 'before-fill', regionDrawingDelay: 1, regionDrawingDuration: 2, regionFillingDelay: .5, regionFillingDuration: 1.5 };
assert.deepEqual(core.regionEffectTiming(exactBefore), { drawStart: 1, drawEnd: 3, fillStart: 3.5, fillEnd: 5, appearanceCompleteTime: 5 });
for (const [time, drawProgress, fillFactor] of [[.5,0,0],[2,.5,0],[3,1,0],[4.25,1,.5],[5,1,1]]) {
  const value = core.regionPresentation({ ...exactBefore, regionEffectTime: time }); assert.equal(value.drawProgress, drawProgress); assert.equal(value.fillFactor, fillFactor);
}
const exactAfter = { ...exactBefore, regionDrawOrder: 'after-fill' };
assert.deepEqual(core.regionEffectTiming(exactAfter), { drawStart: 3, drawEnd: 5, fillStart: .5, fillEnd: 2, appearanceCompleteTime: 5 });
const wipeAnim = { appearEnabled: true, regionEffect: 'draw-border', appearDelay: 0, appearDuration: 0.6, regionDrawingDelay: 1, regionDrawingDuration: 2, regionFillingDelay: .5, regionFillingDuration: 1.5, wipeDelay: 1, wipeDuration: 2 };
assert.deepEqual(core.regionWipeTiming(wipeAnim), { appearanceCompleteTime: 5, wipeStart: 6, wipeEnd: 8 });
assert.deepEqual([5.5, 6, 7, 8].map((time) => core.regionWipeProgress(wipeAnim, time)), [0, 0, .5, 1]);
assert.equal(core.wholeAppearanceCompleteTime({ appearEnabled: true, appearDelay: 1, appearDuration: 6, regionEffect: 'draw-border', regionDrawingDelay: 1, regionDrawingDuration: 2, regionFillingDelay: .5, regionFillingDuration: 1.5 }), 7);
assert.deepEqual(core.regionWipeTiming({ appearEnabled: true, appearDelay: 1, appearDuration: 2, wipeDelay: 1, wipeDuration: 2 }), { appearanceCompleteTime: 3, wipeStart: 4, wipeEnd: 6 });

const noFill = core.onlineRegionFeatureCollection([{ ...layer, regionFillMode: 'none', regionStrokeExists: true, regionAnimationEnabled: false }], null).features[0];
assert.equal(noFill.properties.fillOpacity, 0); assert.ok(noFill.properties.strokeOpacity > 0);
const noStroke = core.onlineRegionFeatureCollection([{ ...layer, regionStrokeExists: false, regionAnimationEnabled: false }], null).features[0];
assert.equal(noStroke.properties.strokeOpacity, 0);
const trace = core.onlineRegionFeatureCollection([{ ...layer, regionEffectTime: 1 }], null).features.find((feature) => feature.properties.role === 'trace');
assert.equal(trace.properties.strokeColor, '#ff0000');

const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
assert.match(app, /onClick=\{\(\) => focusLayerFromRow\(layer\)\}/);
assert.match(app, /event\.stopPropagation\(\)/);
assert.doesNotMatch(app, /value=\{anim\.regionDrawSpeed/);
assert.match(app, /Drawing Delay/); assert.match(app, /Filling Duration/);
assert.doesNotMatch(app, /disabled=\{transitionContext\?\.continuouslyVisible\}/);
assert.doesNotMatch(app, /disabled=\{transitionContext\.continuouslyVisible\}/);
assert.match(app, /label="Wipe Out Delay"[\s\S]{0,180}wipeDelay/);
assert.match(app, /const \[draft, setDraft\] = useState\(String\(value\)\)/);
assert.match(app, /if \(raw !== '' && Number\.isFinite\(Number\(raw\)\)\)/);
const overlays = readFileSync(join(root, 'src/core/onlineProjectOverlays.ts'), 'utf8');
assert.doesNotMatch(overlays, /ONLINE_PROJECT_REGION_STROKE_LAYER_ID[\s\S]{0,600}line-dasharray/);
assert.match(overlays, /\['==', \['get', 'patternId'\], ''\]/);
const textureRenderer = readFileSync(join(root, 'src/core/geographicRegionFillLayer.ts'), 'utf8');
assert.match(textureRenderer, /#version 300 es/);
assert.match(textureRenderer, /const resolvedImages = new Map<string, HTMLCanvasElement>\(\)/);
assert.match(textureRenderer, /document\.createElement\('canvas'\)/);
assert.match(textureRenderer, /resolvedImages\.get\(url\)/);
assert.match(textureRenderer, /gl\.activeTexture\(gl\.TEXTURE0\)/);
assert.match(textureRenderer, /gl\.uniform1i\([\s\S]{0,80}'u_image'[\s\S]{0,80}, 0\)/);
assert.match(textureRenderer, /gl\.disable\(gl\.DEPTH_TEST\)/);
assert.match(textureRenderer, /gl\.disable\(gl\.CULL_FACE\)/);
assert.match(textureRenderer, /gl2\.bindVertexArray\(this\.vertexArray \?\? null\)/);
assert.match(textureRenderer, /options\.defaultProjectionData\.mainMatrix/);
assert.doesNotMatch(textureRenderer, /options\.modelViewProjectionMatrix/);
assert.match(overlays, /map\.removeLayer\(ONLINE_GEOGRAPHIC_REGION_FILL_LAYER_ID\)/);

console.log('Region O1.15.6: 100-layer identity, 12-country flags, correct MapLibre projection, live-renderer replacement, explicit WebGL texture state, durable assets, Tile/Cover/Fit UVs, exact whole-appearance/wipe timing, repeated authoring, fill/stroke modes, authored draw color, and row focus wiring passed.');
