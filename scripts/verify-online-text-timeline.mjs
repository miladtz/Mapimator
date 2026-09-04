import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (path) => readFileSync(join(root, path), 'utf8');
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-text-timeline-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectFile').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/viewCompiler').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/textLayers').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/onlineProjectOverlays').replaceAll('\\', '/')}';`,
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

const english = core.createLayer('text');
english.id = 'text-english';
english.text = 'Iraq\n2026';
const persian = {
  ...core.createLayer('text'),
  id: 'text-persian',
  text: 'ایران\n۱۴۰۵',
  fontFamily: 'vazirmatn',
};
const project = core.createProject('Text timeline');
project.layers = [english, persian];
const cameraA = { x: 0, y: 0, zoom: 1, bearing: 0, pitch: 0 };
const cameraB = { x: 100, y: -50, zoom: 9, bearing: 25, pitch: 35 };
const viewA = core.createView('A', [english, persian], cameraA, project.layers);
const viewB = core.createView('B', [persian], cameraB, project.layers);
viewA.holdDuration = 2;
viewB.holdDuration = 2;
project.views = [viewA, viewB];
const transition = core.createTransition(viewA.id, viewB.id, project.layers);
transition.duration = 2;
transition.layerConfigs[english.id] = {
  included: true,
  animation: { textScaleWithMapZoom: true, textReferenceZoom: 1 },
};
transition.layerConfigs[persian.id] = { included: true };
project.transitions = [transition];

assert.ok(core.evaluateProjectAtTime(project, 0.5).layers.some((layer) => layer.id === english.id));
assert.ok(!core.evaluateProjectAtTime(project, 4.5).layers.some((layer) => layer.id === english.id));
assert.ok(
  core.evaluateProjectAtTime(project, 2.5).layers.some((layer) => layer.id === english.id),
  'Transition membership is independent from destination View membership',
);

for (const appearType of ['fade', 'pop', 'drop']) {
  viewA.layerConfigs[english.id].animation = {
    appearEnabled: true,
    appearType,
    appearDelay: 0,
    appearDuration: 1,
  };
  const layer = core
    .evaluateProjectAtTime(project, 0.5)
    .layers.find((candidate) => candidate.id === english.id);
  assert.ok(layer);
  assert.ok(layer.opacity > 0 && layer.opacity < 1);
  if (appearType === 'pop') assert.ok(layer.textAnimationScale > 0.85 && layer.textAnimationScale < 1);
  if (appearType === 'drop') assert.ok(layer.textDropOffsetY < 0);
}

viewA.layerConfigs[english.id].animation = {
  appearEnabled: false,
  wipeEnabled: true,
  wipeDelay: 0,
  wipeDuration: 1,
};
const wiped = core.evaluateProjectAtTime(project, 0.5).layers.find((layer) => layer.id === english.id);
assert.ok(wiped.opacity > 0 && wiped.opacity < 1, 'Wipe evaluates independently from Appear');

viewA.layerConfigs[english.id].animation = { textScaleWithMapZoom: false, textReferenceZoom: 1 };
assert.equal(core.evaluateProjectAtTime(project, 0.5).layers[0].textRenderScale, 1);
const transitionState = core.evaluateProjectAtTime(project, 3);
const scaledText = transitionState.layers.find((layer) => layer.id === english.id);
assert.ok(scaledText.textRenderScale > 1);
assert.equal(
  scaledText.textRenderScale,
  core.textMapZoomScale(transition.layerConfigs[english.id].animation, transitionState.camera.zoom),
);
assert.equal(core.textMapZoomScale({ textScaleWithMapZoom: true, textReferenceZoom: 1 }, 1e9), 3);
assert.equal(core.textMapZoomScale({ textScaleWithMapZoom: true, textReferenceZoom: 1 }, 1e-9), 0.5);

viewA.layerConfigs[english.id].animation = {
  textScaleWithMapZoom: true,
  textReferenceZoom: 1,
  appearEnabled: true,
  appearType: 'pop',
  appearDuration: 1,
};
viewA.layerConfigs[persian.id].animation = structuredClone(viewA.layerConfigs[english.id].animation);
const bilingual = core.evaluateProjectAtTime(project, 0.5).layers;
assert.equal(
  bilingual.find((layer) => layer.id === english.id).textAnimationScale,
  bilingual.find((layer) => layer.id === persian.id).textAnimationScale,
  'Persian and English share deterministic timeline evaluation',
);
assert.equal(project.layers[0].fontSize, 32, 'timeline evaluation never mutates project typography');
assert.equal(project.layers[0].textRenderScale, undefined, 'render-only scale never enters canonical layer');

const reopened = core.parseProjectFile(core.serializeCanonicalProject(project).json);
assert.deepEqual(
  reopened.views[0].layerConfigs[english.id].animation,
  viewA.layerConfigs[english.id].animation,
  'Text usage persists by stable Text ID',
);
const deleted = core.deleteProjectLayer(reopened, english.id);
assert.equal(deleted.views[0].layerConfigs[english.id], undefined);
assert.equal(deleted.transitions[0].layerConfigs[english.id], undefined);

const app = source('src/app/App.tsx');
assert.match(app, /Scale with Map Zoom/);
assert.match(app, /data-text-timeline-settings/);
assert.match(app, /textReferenceZoom: context\.cameraZoom/);
assert.ok(
  app.indexOf('Content') < app.indexOf('data-text-timeline-settings'),
  'canonical Text properties are declared before Text timeline settings',
);
const overlays = source('src/core/onlineProjectOverlays.ts');
assert.match(overlays, /'icon-size': \['get', 'iconScale'\]/);
const offsetExpression = core.textIconOffsetExpression(
  core.onlineTextFeatureCollection([{ ...english, textDropOffsetY: -8 }], null),
);
assert.equal(offsetExpression[0], 'match');
for (let index = 3; index < offsetExpression.length - 1; index += 2) {
  const output = offsetExpression[index];
  assert.equal(output[0], 'literal', 'every icon-offset array output is a literal MapLibre value');
  assert.ok(Array.isArray(output[1]));
}
assert.equal(offsetExpression.at(-1)[0], 'literal', 'the fallback icon-offset is also literal');
const emptyOffsetExpression = core.textIconOffsetExpression(core.onlineTextFeatureCollection([], null));
assert.deepEqual(
  emptyOffsetExpression,
  ['literal', [0, 0]],
  'an empty Text collection uses a direct literal instead of an invalid branchless match',
);
const validateOffsetExpression = (expression) =>
  validateStyleMin({
    version: 8,
    sources: {
      text: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      {
        id: 'text',
        type: 'symbol',
        source: 'text',
        layout: { 'icon-image': 'text-image', 'icon-offset': expression },
      },
    ],
  }).filter((error) => error.message.includes('icon-offset'));
assert.deepEqual(validateOffsetExpression(emptyOffsetExpression), []);
assert.deepEqual(validateOffsetExpression(offsetExpression), []);

console.log('Text timeline existence, lifecycle, Zoom scaling, RTL parity, and persistence checks passed.');
