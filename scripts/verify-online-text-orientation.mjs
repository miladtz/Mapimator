import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = process.cwd();
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapmotion-text-orientation-'));
const entry = path.join(outDir, 'entry.ts');
fs.writeFileSync(
  entry,
  [
    `export * from '${path.join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${path.join(root, 'src/core/projectPersistence').replaceAll('\\', '/')}';`,
    `export * from '${path.join(root, 'src/core/viewCompiler').replaceAll('\\', '/')}';`,
    `export * from '${path.join(root, 'src/core/onlineProjectOverlays').replaceAll('\\', '/')}';`,
  ].join('\n'),
);
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
const core = await import(pathToFileURL(path.join(outDir, 'core.mjs')).href);

const text = {
  ...core.createLayer('text'),
  id: 'text-orientation-proof',
  text: 'ایران / IRAN ۱۴۰۵',
  x: 620,
  y: 245,
};
const project = {
  ...core.createProject('Text orientation'),
  layers: [text],
  views: [],
  transitions: [],
};
const faceView = core.createView(
  'Face',
  [text],
  { x: 500, y: 250, zoom: 1, pitch: 72, bearing: 43 },
  [text],
);
const flatView = core.createView(
  'Flat',
  [text],
  { x: 500, y: 250, zoom: 4, pitch: 72, bearing: 43 },
  [text],
);
faceView.holdDuration = 1;
flatView.holdDuration = 1;
faceView.layerConfigs[text.id].animation = {
  textOrientation: 'face-camera',
  textScaleWithMapZoom: false,
  textReferenceZoom: 1,
};
flatView.layerConfigs[text.id].animation = {
  textOrientation: 'flat-on-map',
  textScaleWithMapZoom: true,
  textReferenceZoom: 1,
};
project.views = [faceView, flatView];
const transition = core.createTransition(faceView.id, flatView.id, [text]);
transition.duration = 1;
transition.layerConfigs[text.id] = {
  included: true,
  animation: { textOrientation: 'flat-on-map', textScaleWithMapZoom: false },
};
project.transitions = [transition];

const face = core.evaluateProjectAtTime(project, 0.5).layers[0];
const transitionText = core.evaluateProjectAtTime(project, 1.5).layers[0];
const flat = core.evaluateProjectAtTime(project, 2.5).layers[0];
assert.equal(face.textOrientation, 'face-camera');
assert.equal(face.textScaleWithMapZoom, false);
assert.equal(face.textRenderScale, 1);
assert.equal(flat.textOrientation, 'flat-on-map');
assert.equal(flat.textScaleWithMapZoom, true);
assert.equal(flat.textRenderScale, 2);
assert.equal(transitionText.textOrientation, 'flat-on-map', 'Transition owns one deterministic orientation');
assert.equal(project.layers[0].textOrientation, undefined, 'timeline orientation never mutates canonical Text');
const reopened = core.validateAndMigrateProject(JSON.parse(JSON.stringify(project)));
assert.equal(reopened.views[0].layerConfigs[text.id].animation.textOrientation, 'face-camera');
assert.equal(reopened.views[1].layerConfigs[text.id].animation.textOrientation, 'flat-on-map');
assert.equal(reopened.transitions[0].layerConfigs[text.id].animation.textOrientation, 'flat-on-map');
delete reopened.views[0].layerConfigs[text.id].animation.textOrientation;
assert.equal(
  core.evaluateProjectAtTime(reopened, 0.5).layers[0].textOrientation,
  'face-camera',
  'old Text usage receives the compatible billboard default',
);

const faceCollections = core.onlineTextFeatureCollections([face]);
const flatCollections = core.onlineTextFeatureCollections([flat]);
assert.deepEqual(faceCollections.faceCamera.features.map((feature) => feature.id), [text.id]);
assert.deepEqual(faceCollections.flatOnMap.features, []);
assert.deepEqual(flatCollections.faceCamera.features, []);
assert.deepEqual(flatCollections.flatOnMap.features.map((feature) => feature.id), [text.id]);
const secondText = { ...face, id: 'second-text', textOrientation: 'face-camera' };
const mixed = core.onlineTextFeatureCollections([flat, secondText]);
const faceIds = new Set(mixed.faceCamera.features.map((feature) => feature.properties.layerId));
const flatIds = new Set(mixed.flatOnMap.features.map((feature) => feature.properties.layerId));
assert.deepEqual([...faceIds].filter((id) => flatIds.has(id)), [], 'Face and Flat IDs never intersect');
assert.equal(core.onlineTextFeatureCollections([]).faceCamera.features.length, 0);
assert.equal(core.onlineTextFeatureCollections([]).flatOnMap.features.length, 0);

let layoutWrites = 0;
const missingLayerMap = {
  getLayer: () => undefined,
  setLayoutProperty: () => {
    layoutWrites += 1;
  },
};
assert.equal(core.setTextIconOffsetIfLayerExists(missingLayerMap, 'missing', flatCollections.flatOnMap), false);
assert.equal(layoutWrites, 0, 'style-reload gap never mutates a missing layer');
const existingLayerMap = {
  getLayer: () => ({}),
  setLayoutProperty: () => {
    layoutWrites += 1;
  },
};
assert.equal(
  core.setTextIconOffsetIfLayerExists(existingLayerMap, 'present', flatCollections.flatOnMap),
  true,
);
assert.equal(layoutWrites, 1);

const overlays = fs.readFileSync(path.join(root, 'src/core/onlineProjectOverlays.ts'), 'utf8');
assert.match(overlays, /orientation: layer\.textOrientation \?\? 'face-camera'/);
assert.match(overlays, /ONLINE_PROJECT_TEXT_FLAT_SOURCE_ID = 'mapmotion-project-text-flat'/);
assert.match(overlays, /source: ONLINE_PROJECT_TEXT_FLAT_SOURCE_ID/);
assert.match(overlays, /'icon-rotation-alignment': 'viewport'[\s\S]*'icon-pitch-alignment': 'viewport'/);
assert.match(overlays, /'icon-rotation-alignment': 'map'[\s\S]*'icon-pitch-alignment': 'map'/);

const offline = fs.readFileSync(path.join(root, 'src/components/OfflineMap.tsx'), 'utf8');
assert.match(offline, /layer\.textOrientation === 'flat-on-map'/);
assert.match(offline, /mapPlaneLocalTransform\(flatCamera, layer\.x, layer\.y\)/);
assert.match(offline, /rotate\(\$\{screenRotation\}\) scale\(\$\{screenScale\}\)/);
assert.match(offline, /flatCamera \? 1 \/ flatCamera\.zoom : screenScale/);

const app = fs.readFileSync(path.join(root, 'src/app/App.tsx'), 'utf8');
assert.match(app, /value=\{anim\?\.textOrientation \?\? 'face-camera'\}/);
assert.match(app, /<option value="face-camera">Face Camera<\/option>/);
assert.match(app, /<option value="flat-on-map">Flat on Map<\/option>/);

console.log('Online Text Orientation: per-segment billboard/map-plane state and shared render parity passed.');
