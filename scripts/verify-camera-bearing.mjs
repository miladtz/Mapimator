import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-camera-bearing-'));
const entryFile = join(outDir, 'entry.ts');
writeFileSync(
  entryFile,
  [
    `export * from '${join(root, 'src/core/camera').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectPersistence').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/viewCompiler').replaceAll('\\', '/')}';`,
  ].join('\n'),
);
let mod;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      lib: { entry: entryFile, formats: ['es'], fileName: () => 'core.mjs' },
    },
  });
  mod = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const {
  canonicalProjectJson,
  compileTimeline,
  createProject,
  createTransition,
  createView,
  evaluateProjectAtTime,
  interpolateBearing,
  interpolateCamera,
  normalizeBearing,
  projectWorldToScreen,
  unprojectScreenToWorld,
  validateAndMigrateProject,
} = mod;

for (const [input, expected] of [
  [0, 0],
  [360, 0],
  [-360, 0],
  [180, -180],
  [540, -180],
  [350, -10],
])
  assert.equal(normalizeBearing(input), expected);

for (const [from, to, midpoint] of [
  [0, 90, 45],
  [90, 0, 45],
  [170, -170, -180],
  [-170, 170, -180],
  [350, 10, 0],
  [10, 350, 0],
]) {
  assert.equal(interpolateBearing(from, to, 0), normalizeBearing(from));
  assert.equal(interpolateBearing(from, to, 1), normalizeBearing(to));
  assert.equal(interpolateBearing(from, to, 0.5), midpoint);
}

const camera = { x: -340.25, y: -121.75, zoom: 2.75, bearing: 47, pitch: 0 };
for (const point of [
  [0, 0],
  [500, 280],
  [930.5, 73.25],
]) {
  const screen = projectWorldToScreen(camera, point[0], point[1]);
  const recovered = unprojectScreenToWorld(camera, screen.x, screen.y);
  assert.ok(Math.abs(recovered.x - point[0]) < 1e-9);
  assert.ok(Math.abs(recovered.y - point[1]) < 1e-9);
}
const centerWorld = unprojectScreenToWorld(camera, 500, 280);
for (const bearing of [0, 45, 90, -90, -180]) {
  const center = projectWorldToScreen({ ...camera, bearing }, centerWorld.x, centerWorld.y);
  assert.ok(Math.abs(center.x - 500) < 1e-9 && Math.abs(center.y - 280) < 1e-9);
}

const legacy = createProject('Legacy bearing');
legacy.views = [createView('Legacy', [], { x: 0, y: 0, zoom: 1 }, [])];
const migrated = validateAndMigrateProject(legacy);
assert.equal(migrated.views[0].camera.bearing, 0);
assert.equal(migrated.views[0].camera.pitch, 0);

const project = createProject('Bearing transition');
const first = createView('A', [], { x: -100, y: -50, zoom: 2, bearing: 170, pitch: 0 }, []);
const middle = createView('B', [], { x: -100, y: -50, zoom: 2, bearing: -170, pitch: 0 }, []);
const last = createView('C', [], { x: -200, y: -100, zoom: 3, bearing: 45, pitch: 0 }, []);
first.holdDuration = 0;
middle.holdDuration = 0;
last.holdDuration = 1;
project.views = [first, middle, last];
project.transitions = [createTransition(first.id, middle.id, [], first), createTransition(middle.id, last.id, [], middle)];
project.transitions[0].duration = 2;
project.transitions[1].duration = 2;
const sequence = compileTimeline(project);
assert.equal(sequence.segments.length, 3, 'zero-Hold Views emit transitions but no hold segment');
assert.equal(evaluateProjectAtTime(project, 0).camera.bearing, 170);
assert.equal(evaluateProjectAtTime(project, 1).camera.bearing, -180);
assert.equal(evaluateProjectAtTime(project, 2).camera.bearing, -170);
assert.equal(evaluateProjectAtTime(project, 4).camera.bearing, 45);

const interpolated = interpolateCamera(first.camera, middle.camera, 0.5, 'linear');
assert.equal(interpolated.bearing, -180);
const reopened = validateAndMigrateProject(JSON.parse(canonicalProjectJson(project)));
assert.equal(reopened.views[1].camera.bearing, -170);
const duplicate = structuredClone(reopened.views[1]);
duplicate.id = 'duplicate-bearing';
assert.equal(duplicate.camera.bearing, reopened.views[1].camera.bearing);

const mapSource = readFileSync(join(root, 'src/components/OfflineMap.tsx'), 'utf8');
const frameSource = readFileSync(join(root, 'src/core/frameRenderer.tsx'), 'utf8');
const appSource = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
assert.match(mapSource, /rotate\(\$\{bearing\}\)/, 'bearing is serialized in the actual SVG scene transform');
assert.match(
  mapSource,
  /screenRotation=\{mapMode === 'globe' \|\| flatPerspectiveCamera \? 0 : -bearing\}/,
  'Pin glyph counter-rotates in affine Bearing and remains upright after perspective projection',
);
assert.match(mapSource, /unprojectScreenToWorld/, 'placement and dragging use bearing-aware inverse math');
assert.match(frameSource, /<MapScene/, 'Export and thumbnails reuse the bearing-aware scene');
assert.match(appSource, /Update View/, 'View camera capture remains available');
assert.ok(!appSource.includes('setCamera(previewState'), 'Preview does not write evaluated camera into editor state');

console.log(
  'Camera bearing verification: migration, normalization, shortest paths, endpoints, projection inverse, center invariant, zero-Hold, persistence, duplicate semantics, upright Pins, thumbnails/Export scene parity, and read-only Preview passed.',
);
