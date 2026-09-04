import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'custom-route-'));
const entry = join(out, 'entry.ts');
const source = (path) => join(root, path).replaceAll('\\', '/');
writeFileSync(
  entry,
  `export * from '${source('src/core/customRoutePath')}'; export * from '${source('src/core/routePlanner')}';`,
);
let route;
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
  route = await import(pathToFileURL(join(out, 'module.mjs')).href);
} finally {
  rmSync(out, { recursive: true, force: true });
}

const point = (id, longitude, latitude) => ({ id, longitude, latitude, name: id });
const start = point('a', 56.27, 27.18);
const end = point('b', 55.27, 25.2);
const controls = [
  route.createCustomRouteControlPoint(56.1, 26.7, 'c1'),
  route.createCustomRouteControlPoint(55.6, 26.1, 'c2'),
];
const exactSettings = route.customRouteSettings('exact', controls);
const smoothSettings = route.customRouteSettings('smooth', controls);
const exact = route.generateCustomRouteGeometry(start, end, exactSettings);
const smooth = route.generateCustomRouteGeometry(start, end, smoothSettings);
const closeCoordinate = (actual, expected) =>
  assert.ok(Math.abs(actual[0] - expected[0]) < 1e-10 && Math.abs(actual[1] - expected[1]) < 1e-10);
closeCoordinate(exact[0], [start.longitude, start.latitude]);
closeCoordinate(exact.at(-1), [end.longitude, end.latitude]);
for (const control of controls)
  assert.ok(exact.some((candidate) => Math.abs(candidate[0] - control.longitude) < 1e-10 && Math.abs(candidate[1] - control.latitude) < 1e-10));
closeCoordinate(smooth[0], [start.longitude, start.latitude]);
closeCoordinate(smooth.at(-1), [end.longitude, end.latitude]);
for (const control of controls)
  assert.ok(smooth.some((candidate) => Math.abs(candidate[0] - control.longitude) < 1e-10 && Math.abs(candidate[1] - control.latitude) < 1e-10));
assert.notDeepEqual(smooth, exact);
assert.deepEqual(route.generateCustomRouteGeometry(start, end, smoothSettings), smooth);
assert.ok(smooth.length > controls.length + 2 && smooth.length < 200);
assert.ok(smooth.flat().every(Number.isFinite));
assert.ok(smooth.every(([, latitude]) => Math.abs(latitude) <= 85.051129));
const longitudeRange = smooth.map(([longitude]) => longitude);
const latitudeRange = smooth.map(([, latitude]) => latitude);
assert.ok(Math.min(...longitudeRange) >= Math.min(start.longitude, end.longitude, ...controls.map((point) => point.longitude)) - 1);
assert.ok(Math.max(...longitudeRange) <= Math.max(start.longitude, end.longitude, ...controls.map((point) => point.longitude)) + 1);
assert.ok(Math.min(...latitudeRange) >= Math.min(start.latitude, end.latitude, ...controls.map((point) => point.latitude)) - 1);
assert.ok(Math.max(...latitudeRange) <= Math.max(start.latitude, end.latitude, ...controls.map((point) => point.latitude)) + 1);

const zero = route.generateCustomRouteGeometry(start, end, route.customRouteSettings('exact'));
closeCoordinate(zero[0], [start.longitude, start.latitude]);
closeCoordinate(zero.at(-1), [end.longitude, end.latitude]);
const moved = route.moveCustomRouteControlPoint(smoothSettings, 'c1', 56.3, 26.5);
assert.equal(moved.controlPoints[0].id, 'c1');
assert.notDeepEqual(route.generateCustomRouteGeometry(start, end, moved), smooth);
const inserted = route.insertCustomRouteControlPoint(moved, 1, route.createCustomRouteControlPoint(55.9, 26.3, 'inside'));
assert.deepEqual(inserted.controlPoints.map(({ id }) => id), ['c1', 'inside', 'c2']);
assert.deepEqual(route.removeCustomRouteControlPoint(inserted, 'inside').controlPoints.map(({ id }) => id), ['c1', 'c2']);
assert.deepEqual(route.customRouteSettings('exact', inserted.controlPoints).controlPoints, inserted.controlPoints);

const antiStart = point('anti-a', 179, 10);
const antiEnd = point('anti-b', -179, 12);
for (const shape of ['exact', 'smooth']) {
  const geometry = route.generateCustomRouteGeometry(antiStart, antiEnd, route.customRouteSettings(shape, [
    route.createCustomRouteControlPoint(-179.5, 11, 'anti-control'),
  ]));
  assert.ok(geometry.flat().every(Number.isFinite));
  assert.ok(Math.max(...geometry.map(([longitude]) => longitude)) - Math.min(...geometry.map(([longitude]) => longitude)) < 5);
  assert.ok(geometry.every(([longitude]) => Math.abs(longitude) <= 540));
}

let draft = route.createRoutePlannerDraft();
draft = route.setRoutePlannerPoint(draft, 'source', start);
draft = route.setRoutePlannerPoint(draft, 'destination', end);
const sectionId = draft.sections[0].id;
draft = route.setRoutePlannerSectionPathType(draft, sectionId, 'custom');
assert.equal(draft.sections[0].status, 'custom');
draft = route.setCustomRouteSection(draft, sectionId, smoothSettings);
assert.equal(draft.sections[0].status, 'ready');
assert.equal(draft.sections[0].id, sectionId);
const layer = route.routeLayerFromSections(draft);
assert.equal(layer.routeSegments.length, 1);
assert.deepEqual(layer.routeSegments[0].geometry, smooth);
assert.deepEqual(layer.routeDefinition.sectionDefinitions[0].generatorSettings.controlPoints, controls);
assert.equal(layer.routeDefinition.sectionDefinitions[0].generatorSettings.pathShape, 'smooth');
const stored = JSON.stringify(layer);
assert.deepEqual(JSON.parse(stored).routeSegments[0].geometry, smooth, 'reload retains accepted geometry');

const middle = point('middle', 55.7, 26);
let mixed = route.createRoutePlannerDraft();
mixed = route.setRoutePlannerPoint(mixed, 'source', start);
mixed = route.setRoutePlannerPoint(mixed, 'destination', end);
mixed = route.reconcileRouteSections({ ...mixed, stops: [middle] });
mixed = route.setRoutePlannerSectionPathType(mixed, mixed.sections[0].id, 'custom');
mixed = route.setCustomRouteSection(mixed, mixed.sections[0].id, exactSettings);
const roadGeometry = [[middle.longitude, middle.latitude], [end.longitude, end.latitude]];
mixed = {
  ...mixed,
  sections: mixed.sections.map((section, index) => index === 1 ? {
    ...section,
    plans: [{ id: 'road-plan', provider: 'test-road', providerVersion: '1', pathType: 'road', geometry: roadGeometry, distanceMeters: 1, estimatedDurationSeconds: 1, routeSummary: 'Road', legs: [], alternativeRank: 0 }],
    selectedPlanId: 'road-plan',
    status: 'ready',
  } : section),
};
assert.equal(route.routeLayerFromSections(mixed).routeSegments.length, 2, 'Custom and Road accept into one layer');
let twoCustom = route.setRoutePlannerSectionPathType(mixed, mixed.sections[1].id, 'custom');
twoCustom = route.setCustomRouteSection(twoCustom, twoCustom.sections[1].id, route.customRouteSettings('smooth'));
assert.equal(route.routeLayerFromSections(twoCustom).routeSegments.filter((segment) => segment.pathType === 'custom').length, 2);

const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
const map = readFileSync(join(root, 'src/components/OnlineOpenFreeMap.tsx'), 'utf8');
for (const token of ['CUSTOM PATH', 'Draw Path', 'Edit Path', 'Clear Path', 'Custom path required', 'Editing custom path...', 'Finish'])
  assert.ok(app.includes(token), `missing Custom UI token: ${token}`);
for (const token of ['Backspace', 'Escape', "event.key === 'Enter'", 'insertCustomRouteControlPoint', 'moveCustomRouteControlPoint', 'removeCustomRouteControlPoint'])
  assert.ok(app.includes(token), `missing authoring behavior: ${token}`);
assert.ok(map.includes('mapmotion:editor-only'));
assert.ok(map.includes('controlPointId'));
assert.ok(!readFileSync(join(root, 'src/core/onlineProjectOverlays.ts'), 'utf8').includes('generateCustomRouteGeometry'), 'accepted renderer must not regenerate Custom geometry');
assert.ok(!readFileSync(join(root, 'src/core/export.ts'), 'utf8').includes('generateCustomRouteGeometry'), 'export must not regenerate Custom geometry');

console.log('Online Custom Route: exact/smooth generation, antimeridian safety, draft editing, persistence, and accepted-geometry isolation passed.');
