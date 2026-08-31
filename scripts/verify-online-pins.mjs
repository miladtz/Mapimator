import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (path) => readFileSync(join(root, path), 'utf8');
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-online-pins-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectPersistence').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectFile').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/viewCompiler').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/openFreeMapAdapter').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/onlineProjectOverlays').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/onlineMapLabelPolicy').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/color').replaceAll('\\', '/')}';`,
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

const qeshm = core.lngLatToMapMotionWorld(56.27, 26.95);
const qeshmRoundTrip = core.mapMotionWorldToLngLat(qeshm.x, qeshm.y);
assert.ok(Math.abs(qeshmRoundTrip[0] - 56.27) < 1e-9);
assert.ok(Math.abs(qeshmRoundTrip[1] - 26.95) < 1e-9);

const pin = core.createLayer('pin');
pin.id = 'pin-qeshm';
pin.x = qeshm.x;
pin.y = qeshm.y;
pin.text = 'Qeshm';
pin.pinSize = 18;
pin.pinBorderColor = '#123456';
pin.pinBorderWidth = 5;
pin.opacity = 0.35;
pin.pinLabelOpacity = 0.9;
pin.pinLabelBorderColor = '#2468AC';
pin.pinLabelBorderWidth = 3;
pin.pinLabelAngle = 0;
pin.pinLabelGap = -3.5;
const collection = core.onlinePinFeatureCollection([pin], pin.id);
assert.equal(collection.features.length, 1);
assert.equal(collection.features[0].id, pin.id);
assert.deepEqual(collection.features[0].geometry.coordinates, qeshmRoundTrip);
assert.equal(collection.features[0].properties.layerId, pin.id);
assert.equal(collection.features[0].properties.label, 'Qeshm');
assert.equal(collection.features[0].properties.iconScale, 18 / 15);
assert.equal(collection.features[0].properties.iconAnchor, 'bottom');
assert.equal(collection.features[0].properties.selected, true);
assert.equal(collection.features[0].properties.opacity, 0.35);
assert.equal(collection.features[0].properties.labelOpacity, 0.9);
assert.equal(collection.features[0].properties.labelHaloColor, '#2468AC');
assert.equal(collection.features[0].properties.labelHaloWidth, 1.2000000000000002);

const animatedFeature = core.onlinePinFeatureCollection(
  [{ ...pin, opacity: 0.07, pinSceneOpacity: 0.35 }],
  null,
).features[0];
assert.equal(animatedFeature.properties.opacity, 0.07, 'marker carries evaluated layer opacity');
assert.equal(animatedFeature.properties.labelOpacity, 0.315, 'label opacity composes with scene animation');

const lowScale = core.getPinVisualScaleForZoom(0);
const mediumScale = core.getPinVisualScaleForZoom(8);
const localScale = core.getPinVisualScaleForZoom(15);
const deepScale = core.getPinVisualScaleForZoom(30);
assert.equal(lowScale, 0.45);
assert.ok(lowScale < mediumScale && mediumScale < localScale);
assert.equal(localScale, 1);
assert.equal(deepScale, 1.08);
assert.ok(deepScale <= 1.1, 'deep Zoom Pin growth stays bounded');
assert.equal(pin.pinSize, 18, 'renderer-only Zoom scaling does not mutate authored Size');
assert.equal(core.getPinLabelSizeForZoom(12, 0), 8, 'label uses its readable minimum at low Zoom');
assert.equal(core.getPinLabelSizeForZoom(12, 15), 12, 'label approaches authored size locally');
assert.equal(core.getPinLabelSizeForZoom(12, 30), 12.96, 'deep label growth stays bounded');
assert.equal(core.pinLabelHaloWidth(5), 2);
assert.equal(core.pinLabelHaloWidth(20), 2.5, 'label halo conversion is capped');
assert.equal(core.normalizeHexColor('#ff3366'), '#FF3366');
assert.equal(core.normalizeHexColor('#0af'), '#00AAFF');
assert.equal(core.normalizeHexColor('#12zz90'), null, 'malformed HEX never enters project state');

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} ~= ${expected}`);
const radius = 30;
for (const [angle, expectedX, expectedY] of [
  [0, radius, 0],
  [45, radius / Math.sqrt(2), -radius / Math.sqrt(2)],
  [90, 0, -radius],
  [135, -radius / Math.sqrt(2), -radius / Math.sqrt(2)],
  [180, -radius, 0],
  [225, -radius / Math.sqrt(2), radius / Math.sqrt(2)],
  [270, 0, radius],
  [315, radius / Math.sqrt(2), radius / Math.sqrt(2)],
  [360, radius, 0],
]) {
  const offset = core.pinLabelOffsetOf({ ...pin, pinLabelAngle: angle, pinLabelGap: radius });
  near(offset.x, expectedX);
  near(offset.y, expectedY);
}
assert.equal(core.normalizePinLabelAngle(450), 90);
assert.equal(core.normalizePinLabelAngle(-90), 270);
for (const [angle, positive, negative] of [
  [0, [30, 0], [-30, 0]],
  [90, [0, -30], [0, 30]],
  [180, [-30, 0], [30, 0]],
  [270, [0, 30], [0, -30]],
  [45, [30 / Math.sqrt(2), -30 / Math.sqrt(2)], [-30 / Math.sqrt(2), 30 / Math.sqrt(2)]],
]) {
  const positiveOffset = core.pinLabelOffsetOf({ ...pin, pinLabelAngle: angle, pinLabelGap: 30 });
  const negativeOffset = core.pinLabelOffsetOf({ ...pin, pinLabelAngle: angle, pinLabelGap: -30 });
  near(positiveOffset.x, positive[0]);
  near(positiveOffset.y, positive[1]);
  near(negativeOffset.x, negative[0]);
  near(negativeOffset.y, negative[1]);
}
const inset = core.pinLabelOffsetOf({ ...pin, pinLabelAngle: 0, pinLabelGap: -50 });
assert.equal(inset.x, -50, 'negative Gap crosses the center and reverses along the authored ray');
const negativeOffsets = [-10, -20, -30, -40, -50].map(
  (gap) => core.pinLabelOffsetOf({ ...pin, pinLabelAngle: 0, pinLabelGap: gap }).x,
);
assert.deepEqual(negativeOffsets, [-10, -20, -30, -40, -50], 'full negative range has no saturation');
const fullRange = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40].map((gap) =>
  core.pinLabelOffsetOf({ ...pin, pinLabelAngle: 0, pinLabelGap: gap }),
);
assert.deepEqual(
  fullRange.map((offset) => offset.x),
  [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40],
);
for (const zoom of [0, 8, 15, 22]) {
  for (const labelSize of [9, 12, 26]) {
    const candidate = { ...pin, pinLabelAngle: 45, pinLabelGap: 30, pinLabelSize: labelSize };
    const emOffset = core.pinLabelOffsetForLayerAtZoom(candidate, zoom);
    const renderedSize = core.getPinLabelSizeForZoom(labelSize, zoom);
    const center = core.getRenderedPinVisualCenterOffset(candidate, zoom);
    near(emOffset[0] * renderedSize - center[0], 30 / Math.sqrt(2));
    near(emOffset[1] * renderedSize - center[1], -30 / Math.sqrt(2));
  }
}

for (const zoom of [0, 8, 15, 22]) {
  const zeroGap = { ...pin, pinLabelGap: 0 };
  const center = core.getRenderedPinVisualCenterOffset(zeroGap, zoom);
  const emOffset = core.pinLabelOffsetForLayerAtZoom(zeroGap, zoom);
  const renderedSize = core.getPinLabelSizeForZoom(zeroGap.pinLabelSize, zoom);
  near(emOffset[0] * renderedSize, center[0]);
  near(emOffset[1] * renderedSize, center[1]);
  assert.ok(center[1] < 0, 'bottom-anchored built-in Pin center is above its geographic tip');
}

const smallPinCenter = core.getRenderedPinVisualCenterOffset({ ...pin, pinSize: 10 }, 15);
const largePinCenter = core.getRenderedPinVisualCenterOffset({ ...pin, pinSize: 80 }, 15);
assert.ok(largePinCenter[1] < smallPinCenter[1], 'visual center follows authored Pin Size');
const centerCustom = {
  ...pin,
  pinStyle: 'custom',
  pinCustomAssetId: 'asset-custom',
  pinCustomAnchor: 'center',
};
assert.deepEqual(core.getRenderedPinVisualCenterOffset(centerCustom, 15, true), [0, 0]);
const bottomCustom = { ...centerCustom, pinCustomAnchor: 'bottom-center' };
assert.deepEqual(core.getRenderedPinVisualCenterOffset(bottomCustom, 15, true), [0, -18]);

for (const text of ['A', 'A very long city label']) {
  const candidate = { ...pin, text, pinLabelAngle: 90, pinLabelGap: 30 };
  const renderedSize = core.getPinLabelSizeForZoom(candidate.pinLabelSize, 15);
  const target = core.pinLabelOffsetForLayerAtZoom(candidate, 15).map((value) => value * renderedSize);
  const center = core.getRenderedPinVisualCenterOffset(candidate, 15);
  near(target[0], center[0]);
  near(target[1], center[1] - 30);
}

const overlayLayer = {
  id: core.ONLINE_PROJECT_PIN_LABEL_LAYER_ID,
  type: 'symbol',
  metadata: { 'mapmotion:overlay': true },
  layout: { 'text-field': ['get', 'label'] },
};
assert.equal(core.isOnlineProjectOverlayLayer(overlayLayer), true);
assert.equal(core.shouldHideOnlineMapLayer(overlayLayer, 'none'), false, 'Labels=None preserves Pins');

const project = core.createProject('Online Pin');
project.layers = [pin];
const viewA = core.createView('Pin visible', [pin], { x: 0, y: 0, zoom: 1 }, project.layers);
const viewB = core.createView('Pin hidden', [], { x: -200, y: 40, zoom: 8 }, project.layers);
viewA.holdDuration = 1;
viewB.holdDuration = 1;
project.views = [viewA, viewB];
project.transitions = [core.createTransition(viewA.id, viewB.id, project.layers)];
project.transitions[0].duration = 1;
project.transitions[0].layerConfigs[pin.id].included = false;
assert.equal(core.evaluateProjectAtTime(project, 0.5).layers.some((layer) => layer.id === pin.id), true);
assert.equal(core.evaluateProjectAtTime(project, 1.5).layers.some((layer) => layer.id === pin.id), false);
assert.equal(core.evaluateProjectAtTime(project, 2.5).layers.some((layer) => layer.id === pin.id), false);

const reopened = core.parseProjectFile(core.serializeCanonicalProject(project).json);
const reopenedPin = reopened.layers.find((layer) => layer.id === pin.id);
assert.ok(reopenedPin);
assert.equal(reopenedPin.x, pin.x);
assert.equal(reopenedPin.y, pin.y);
assert.equal(reopenedPin.pinSize, pin.pinSize);
assert.equal(reopenedPin.opacity, 0.35);
assert.equal(reopenedPin.pinBorderColor, '#123456');
assert.equal(reopenedPin.pinBorderWidth, 5);
assert.equal(reopenedPin.pinLabelGap, -3.5);
assert.equal(reopenedPin.pinLabelOpacity, 0.9);
assert.equal(reopenedPin.pinLabelBorderColor, '#2468AC');
assert.equal(reopenedPin.pinLabelBorderWidth, 3);
assert.equal(reopenedPin.pinLabelAngle, 0);
assert.deepEqual(core.onlinePinFeatureCollection([reopenedPin], null).features[0].geometry, collection.features[0].geometry);

const manyPins = Array.from({ length: 100 }, (_, index) => {
  const candidate = { ...core.createLayer('pin'), id: `pin-${index}`, x: index * 9, y: index * 4 };
  return candidate;
});
assert.equal(core.onlinePinFeatureCollection(manyPins, null).features.length, 100);
assert.equal(core.onlinePinFeatureCollection(manyPins.filter((layer) => layer.id !== 'pin-50'), null).features.length, 99);

const interactive = source('src/components/OnlineOpenFreeMap.tsx');
const overlays = source('src/core/onlineProjectOverlays.ts');
const frameRenderer = source('src/core/frameRenderer.tsx');
const hiddenRenderer = source('src/core/onlineMapFrameRenderer.ts');
const app = source('src/app/App.tsx');
assert.match(interactive, /event\.lngLat/);
assert.match(interactive, /lngLatToMapMotionWorld/);
assert.match(interactive, /queryRenderedFeatures/);
assert.match(interactive, /dragPan\.disable/);
assert.match(interactive, /dragPan\.enable/);
assert.match(interactive, /style\.load/);
assert.match(interactive, /ensureOnlineProjectOverlays/);
assert.match(overlays, /if \(!map\.getLayer\(ONLINE_PROJECT_PIN_LAYER_ID\)\)/);
assert.match(overlays, /if \(!map\.getLayer\(ONLINE_PROJECT_PIN_SELECTION_LAYER_ID\)\)/);
assert.match(overlays, /if \(!map\.getLayer\(ONLINE_PROJECT_PIN_LABEL_LAYER_ID\)\)/);
assert.match(overlays, /existing\.setData\(data\)/);
assert.match(overlays, /'icon-anchor': \['get', 'iconAnchor'\]/);
assert.match(overlays, /'icon-rotation-alignment': 'viewport'/);
assert.match(overlays, /'icon-pitch-alignment': 'viewport'/);
assert.match(overlays, /'icon-size': zoomScaledPropertyExpression\('iconScale'\)/);
assert.match(overlays, /\['zoom'\]/);
assert.match(overlays, /ONLINE_PIN_LABEL_MIN_SIZE/);
assert.match(overlays, /'text-halo-color': \['get', 'labelHaloColor'\]/);
assert.match(overlays, /'text-halo-width': \['get', 'labelHaloWidth'\]/);
assert.match(overlays, /'text-opacity': \['get', 'labelOpacity'\]/);
assert.match(hiddenRenderer, /updateOnlineProjectOverlays\(this\.map, layers/);
assert.match(frameRenderer, /onlineRenderer\.render\(state\.camera, state\.layers/);
assert.match(app, /previewState\?\.layers \?\? editingLayers/);
assert.match(app, /if \(placing === 'pin'\) placeLayerAt\('pin', point\)/);
assert.match(app, /Project Layer — \{layer\.name\}/);
assert.doesNotMatch(app, /Project Layer â€”/);
assert.match(app, /aria-label="Pin size value"/);
assert.match(app, /aria-label="Pin opacity percentage"/);
assert.match(app, /aria-label="Pin label size value"/);
assert.match(app, /aria-label="Pin label opacity percentage"/);
assert.match(app, /aria-label="Pin label border width"/);
assert.match(app, /aria-label="Pin label angle"/);
assert.match(app, /min="-50"[\s\S]*max="40"[\s\S]*pinLabelGap/);
assert.doesNotMatch(app, /Label position[\s\S]{0,300}<select/);
assert.doesNotMatch(app, /aria-label="Pin (?:size value|opacity percentage|label size value|label opacity percentage|label border width)"[\s\S]{0,80}type="range"/);
assert.match(app, /function HexColorField/);
assert.match(app, /normalizeHexColor/);
assert.match(app, /className="layer-delete"/);
assert.match(app, /void removeLayerById\(layer\.id\)/);
assert.match(app, /event\.stopPropagation\(\)/);
assert.match(app, /await confirmDialog\(/);
const projectLayerDeleteSource = app.slice(
  app.indexOf('const removeLayerById'),
  app.indexOf('const move =', app.indexOf('const removeLayerById')),
);
assert.doesNotMatch(projectLayerDeleteSource, /window\.confirm\(/);

console.log(
  'Online Pins: geographic placement, shared model, persistence, View/Transition evaluation, Labels=None isolation, 100-Pin batching, style restoration, selection/drag ownership, Playback, thumbnail, and Export layer flow passed.',
);
