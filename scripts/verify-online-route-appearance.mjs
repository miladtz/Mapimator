import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'route-appearance-'));
const entry = join(out, 'entry.ts');
const source = (value) => join(root, value).replaceAll('\\', '/');
writeFileSync(
  entry,
  `export { createRouteLayer, routeSegmentAppearancePatch, applyRouteSectionAppearanceToAll } from '${source('src/core/routes')}'; export { onlineRouteFeatureCollection, ONLINE_PROJECT_ROUTE_RAILWAY_RAILS_LAYER_ID, ONLINE_PROJECT_ROUTE_RAILWAY_SLEEPERS_LAYER_ID } from '${source('src/core/onlineProjectOverlays')}'; export { createProject } from '${source('src/core/project')}'; export { serializeCanonicalProject, parseProjectFile } from '${source('src/core/projectFile')}';`,
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

const points = [
  { id: 'a', name: 'A', longitude: 0, latitude: 0 },
  { id: 'b', name: 'B', longitude: 10, latitude: 8 },
  { id: 'c', name: 'C', longitude: 22, latitude: 4 },
  { id: 'd', name: 'D', longitude: 35, latitude: 12 },
];
let layer = route.createRouteLayer(points);
const [first, middle, last] = layer.routeSegments;
layer = route.routeSegmentAppearancePatch(layer, first.id, {
  lineColor: '#ef4444',
  lineWidth: 3,
  lineOpacity: 0.45,
  lineStyle: 'solid',
  arrow: 'none',
});
layer = route.routeSegmentAppearancePatch(layer, middle.id, {
  lineColor: '#22c55e',
  lineWidth: 7,
  lineOpacity: 0.8,
  lineStyle: 'railway',
  arrow: 'end',
});
layer = route.routeSegmentAppearancePatch(layer, last.id, {
  lineColor: '#3b82f6',
  lineWidth: 5,
  lineOpacity: 1,
  lineStyle: 'dotted',
  arrow: 'end',
});
const features = route.onlineRouteFeatureCollection([layer]);
const lines = features.features.filter((feature) => feature.properties.role === 'line');
assert.deepEqual(
  lines.map((feature) => feature.properties.segmentId),
  [first.id, middle.id, last.id],
);
assert.deepEqual(
  lines.map((feature) => feature.properties.lineStyle),
  ['solid', 'railway', 'dotted'],
);
assert.deepEqual(
  lines.map((feature) => feature.properties.color),
  ['#ef4444', '#22c55e', '#3b82f6'],
);
assert.equal(features.features.filter((feature) => feature.properties.role === 'arrow').length, 2);

for (const sourceSection of [first.id, middle.id, last.id]) {
  const sourceAppearance = layer.routeSegments.find((segment) => segment.id === sourceSection).appearance;
  const protectedState = layer.routeSegments.map(({ appearance: _appearance, ...segment }) => segment);
  const applied = route.applyRouteSectionAppearanceToAll(layer, sourceSection);
  assert.ok(
    applied.routeSegments.every(
      (segment) => JSON.stringify(segment.appearance) === JSON.stringify(sourceAppearance),
    ),
  );
  assert.deepEqual(
    applied.routeSegments.map(({ appearance: _appearance, ...segment }) => segment),
    protectedState,
    'Apply-to-All must not alter geometry, PathType, points, IDs, or generator metadata',
  );
}
assert.match(route.ONLINE_PROJECT_ROUTE_RAILWAY_RAILS_LAYER_ID, /railway-rails$/);
assert.match(route.ONLINE_PROJECT_ROUTE_RAILWAY_SLEEPERS_LAYER_ID, /railway-sleepers$/);
const project = route.createProject('Mixed Route styles');
project.layers = [layer];
const reopened = route.parseProjectFile(route.serializeCanonicalProject(project).json);
assert.deepEqual(
  reopened.layers[0].routeSegments.map((segment) => segment.appearance),
  layer.routeSegments.map((segment) => segment.appearance),
);

console.log(
  'Online Route Section Appearance: mixed styles, stable IDs, Railway, arrows, appearance-only Apply-to-All, and JSON persistence passed.',
);
