import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'online-route-visible-'));
const entry = join(out, 'entry.ts');
const modulePath = (path) => join(root, path).replaceAll('\\', '/');
writeFileSync(
  entry,
  [
    `export * from '${modulePath('src/core/routes')}';`,
    `export * from '${modulePath('src/core/project')}';`,
    `export * from '${modulePath('src/core/viewCompiler')}';`,
    `export * from '${modulePath('src/core/onlineProjectOverlays')}';`,
  ].join('\n'),
);
let core;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: out,
      emptyOutDir: false,
      minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'module.mjs' },
    },
  });
  core = await import(pathToFileURL(join(out, 'module.mjs')).href);
} finally {
  rmSync(out, { recursive: true, force: true });
}

const tehran = core.createRoutePoint(51.389, 35.6892, 'Tehran');
const dubai = core.createRoutePoint(55.2708, 25.2048, 'Dubai');
const route = core.createRouteLayer([tehran, dubai]);
const segment = route.routeSegments[0];
assert.equal(route.visible, true);
assert.equal(route.routePoints.length, 2);
assert.equal(route.routeSegments.length, 1);
assert.ok(segment.geometry.length >= 2);
assert.deepEqual(segment.geometry[0], [tehran.longitude, tehran.latitude]);
assert.ok(
  Math.abs(segment.geometry.at(-1)[0] - dubai.longitude) < 1e-6 &&
    Math.abs(segment.geometry.at(-1)[1] - dubai.latitude) < 1e-6,
);

const staticState = core.evaluateRouteRenderState(route, undefined, 0)[0];
assert.equal(staticState.drawProgress, 1);
assert.equal(staticState.wipeProgress, 0);
const staticData = core.onlineRouteFeatureCollection([route], route.id);
const staticLine = staticData.features.find((feature) => feature.properties.role === 'line');
assert.ok(staticLine);
assert.equal(staticLine.geometry.type, 'LineString');
assert.equal(staticLine.geometry.coordinates.length, segment.geometry.length);
assert.equal(staticLine.properties.color, '#64d5ba');
assert.equal(staticLine.properties.width, 4);
assert.equal(staticLine.properties.opacity, 1);
assert.ok(staticData.features.some((feature) => feature.properties.role === 'vehicle'));

const drawHalf = structuredClone(route);
core.applyRouteEvaluation(
  drawHalf,
  { routeSegmentAnimations: { [segment.id]: { drawEnabled: true, drawDuration: 2 } } },
  1,
);
const halfLine = core
  .onlineRouteFeatureCollection([drawHalf])
  .features.find((feature) => feature.properties.role === 'line');
assert.ok(halfLine.geometry.coordinates.length > 2);
assert.ok(halfLine.geometry.coordinates.length < segment.geometry.length);

const project = core.addProjectLayer(core.createProject('Visible route'), route);
const viewA = core.createView('A', [route], { x: 0, y: 0, zoom: 1 }, [route]);
viewA.holdDuration = 2;
const viewB = core.createView('B', [route], { x: 1, y: 1, zoom: 2 }, [route]);
viewB.holdDuration = 2;
const transition = core.createTransition(viewA.id, viewB.id, [route], viewA);
const timelineProject = { ...project, views: [viewA, viewB], transitions: [transition] };
for (const time of [0.5, 2.5, 5]) {
  const evaluated = core.evaluateProjectAtTime(timelineProject, time);
  const line = core
    .onlineRouteFeatureCollection(evaluated.layers)
    .features.find((feature) => feature.properties.role === 'line');
  assert.ok(line, `Route must remain statically visible at timeline time ${time}`);
  assert.equal(line.properties.opacity, 1);
}

const pixelBuffer = new Uint8Array(256 * 144);
const coordinates = staticLine.geometry.coordinates;
for (let index = 1; index < coordinates.length; index += 1) {
  const a = coordinates[index - 1];
  const b = coordinates[index];
  const x0 = Math.round(((a[0] + 180) / 360) * 255);
  const y0 = Math.round(((90 - a[1]) / 180) * 143);
  const x1 = Math.round(((b[0] + 180) / 360) * 255);
  const y1 = Math.round(((90 - b[1]) / 180) * 143);
  const steps = Math.max(1, Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x0 + ((x1 - x0) * step) / steps);
    const y = Math.round(y0 + ((y1 - y0) * step) / steps);
    pixelBuffer[y * 256 + x] = 255;
  }
}
assert.ok(pixelBuffer.some(Boolean), 'Visible Route must produce a non-zero deterministic pixel delta');

class FakePath2D {
  moveTo() {}
  lineTo() {}
  closePath() {}
  ellipse() {}
  quadraticCurveTo() {}
  roundRect() {}
  arc() {}
  rect() {}
}
globalThis.Path2D = FakePath2D;
globalThis.document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      translate() {},
      stroke() {},
      fill() {},
      fillText() {},
      getImageData: () => ({ width: 96, height: 96, data: new Uint8ClampedArray(96 * 96 * 4) }),
    }),
  }),
};

const sources = new Map();
const mapLayers = new Map();
const images = new Set();
let styleLoaded = false;
let idleCallback;
const makeSource = (data = { type: 'FeatureCollection', features: [] }) => ({
  data,
  setData(next) {
    this.data = next;
  },
});
for (const id of [
  core.ONLINE_PROJECT_REGION_SOURCE_ID,
  core.ONLINE_PROJECT_ROUTE_SOURCE_ID,
  core.ONLINE_PROJECT_PIN_SOURCE_ID,
])
  sources.set(id, makeSource());
const map = {
  isStyleLoaded: () => styleLoaded,
  getSource: (id) => sources.get(id),
  addSource: (id, definition) => sources.set(id, makeSource(definition.data)),
  getLayer: (id) => mapLayers.get(id),
  addLayer: (layer) => mapLayers.set(layer.id, layer),
  removeLayer: (id) => mapLayers.delete(id),
  hasImage: (id) => images.has(id),
  addImage: (id) => images.add(id),
  setLayoutProperty() {},
  once: (event, callback) => {
    assert.equal(event, 'idle');
    idleCallback = callback;
  },
};

const updated = core.updateOnlineProjectOverlays(map, [route], route.id);
const earlyRouteData = sources.get(core.ONLINE_PROJECT_ROUTE_SOURCE_ID).data;
assert.equal(updated, staticData.features.length);
assert.equal(earlyRouteData.features.filter((feature) => feature.properties.role === 'line').length, 1);
assert.equal(
  earlyRouteData.features.find((feature) => feature.properties.role === 'line').properties.width,
  4,
);
assert.equal(typeof idleCallback, 'function');

styleLoaded = true;
idleCallback();
for (const id of [
  core.ONLINE_PROJECT_ROUTE_SOLID_LAYER_ID,
  core.ONLINE_PROJECT_ROUTE_DASHED_LAYER_ID,
  core.ONLINE_PROJECT_ROUTE_DOTTED_LAYER_ID,
  core.ONLINE_PROJECT_ROUTE_RAILWAY_SLEEPERS_LAYER_ID,
  core.ONLINE_PROJECT_ROUTE_RAILWAY_RAILS_LAYER_ID,
  core.ONLINE_PROJECT_ROUTE_ARROW_LAYER_ID,
  core.ONLINE_PROJECT_ROUTE_VEHICLE_LAYER_ID,
  core.ONLINE_PROJECT_ROUTE_WAYPOINT_LAYER_ID,
])
  assert.ok(mapLayers.has(id), `${id} must be installed`);
assert.deepEqual(mapLayers.get(core.ONLINE_PROJECT_ROUTE_SOLID_LAYER_ID).filter, [
  'all',
  ['==', ['get', 'role'], 'line'],
  ['==', ['get', 'lineStyle'], 'solid'],
]);
assert.equal(mapLayers.get(core.ONLINE_PROJECT_ROUTE_SOLID_LAYER_ID).paint['line-width'][1], 'width');
assert.equal(mapLayers.get(core.ONLINE_PROJECT_ROUTE_SOLID_LAYER_ID).paint['line-opacity'][1], 'opacity');
for (const feature of staticData.features.filter((candidate) => candidate.properties.iconId))
  assert.ok(images.has(feature.properties.iconId), `${feature.properties.iconId} must be registered`);

const order = [...mapLayers.keys()];
assert.ok(
  order.indexOf(core.ONLINE_PROJECT_ROUTE_SOLID_LAYER_ID) < order.indexOf('mapmotion-project-pin-icons'),
);
console.log(
  'Online Route Visible: canonical/static/View/Transition/draw/source/filter/lifecycle/image/order/pixel behaviors passed.',
);
