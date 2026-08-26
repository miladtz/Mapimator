import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-transitions-'));
const entryFile = join(outDir, 'entry.ts');
writeFileSync(
  entryFile,
  [
    "export * from '" + join(root, 'src', 'core', 'viewCompiler').replaceAll('\\', '/') + "';",
    "export * from '" + join(root, 'src', 'core', 'camera').replaceAll('\\', '/') + "';",
    "export * from '" + join(root, 'src', 'core', 'project').replaceAll('\\', '/') + "';",
    "export * from '" + join(root, 'src', 'core', 'projectPersistence').replaceAll('\\', '/') + "';",
    '',
  ].join('\n'),
  'utf8',
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
      lib: {
        entry: entryFile,
        formats: ['es'],
        fileName: () => 'core.mjs',
      },
    },
  });
  mod = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const {
  easeCameraProgress,
  interpolateCamera,
  flyToCamera,
  CAMERA_SETTINGS,
  compileViews,
  evaluateProjectAtTime,
  createProject,
  createView,
  validateAndMigrateProject,
} = mod;

const PRESETS = ['smooth', 'cinematic', 'linear', 'ease-in', 'ease-out', 'ease-in-out', 'bezier'];
const TYPES = ['smooth', 'pan', 'zoom', 'fly-to'];

// 1. Easing curves: exact endpoints and monotonic non-decreasing behavior.
for (const preset of PRESETS) {
  assert.equal(easeCameraProgress(0, preset), 0, `${preset} must start at 0`);
  assert.equal(easeCameraProgress(1, preset), 1, `${preset} must end at 1`);
  let previous = -Infinity;
  for (let step = 0; step <= 100; step += 1) {
    const value = easeCameraProgress(step / 100, preset);
    assert.ok(value >= previous - 1e-9, `${preset} must be non-decreasing`);
    previous = value;
  }
}

const from = { x: 0, y: 0, zoom: 1 };
const to = { x: -360, y: -180, zoom: 6 };

// 2. All transition types hit both endpoints exactly.
for (const type of TYPES) {
  for (const preset of PRESETS) {
    assert.deepEqual(interpolateCamera(from, to, 0, preset, type), from, `${type}/${preset} start`);
    assert.deepEqual(interpolateCamera(from, to, 1, preset, type), to, `${type}/${preset} end`);
  }
}

// 3. Pan de-emphasizes zoom: mid-flight zoom stays closer to the source.
const midpoint = 0.5;
const smoothZoom = interpolateCamera(from, to, midpoint, 'smooth', 'smooth').zoom;
const panZoom = interpolateCamera(from, to, midpoint, 'smooth', 'pan').zoom;
assert.ok(panZoom < smoothZoom, 'pan zoom should lag behind smooth zoom');
assert.ok(panZoom > 1, 'pan zoom must remain within constraints');

// 4. Zoom type emphasizes zoom: mid-flight zoom leads smooth.
const zoomZoom = interpolateCamera(from, to, midpoint, 'smooth', 'zoom').zoom;
assert.ok(zoomZoom > smoothZoom, 'zoom type should lead smooth zoom');

// 5. Fly To dips below both endpoints mid-flight, stays constrained, no NaN.
const flyFrom = { x: 0, y: 0, zoom: 3 };
const flyDest = { x: -360, y: -180, zoom: 6 };
const flyMid = flyToCamera(flyFrom, flyDest, midpoint, 'smooth');
assert.ok(Number.isFinite(flyMid.zoom) && Number.isFinite(flyMid.x) && Number.isFinite(flyMid.y));
assert.ok(
  flyMid.zoom < Math.min(flyFrom.zoom, flyDest.zoom),
  'fly-to must zoom out below both endpoints mid-flight',
);
assert.ok(flyMid.zoom >= CAMERA_SETTINGS.minZoom - 1e-9, 'fly-to must not go below min zoom');
assert.ok(flyMid.zoom <= CAMERA_SETTINGS.maxZoom + 1e-9, 'fly-to must not exceed max zoom');
assert.ok(
  flyMid.x >= Math.min(flyFrom.x, flyDest.x) && flyMid.x <= Math.max(flyFrom.x, flyDest.x),
  'fly-to x path',
);
assert.ok(
  flyMid.y >= Math.min(flyFrom.y, flyDest.y) && flyMid.y <= Math.max(flyFrom.y, flyDest.y),
  'fly-to y path',
);
for (let step = 0; step <= 100; step += 1) {
  const t = step / 100;
  const value = flyToCamera(flyFrom, flyDest, t, 'smooth').zoom;
  assert.ok(Number.isFinite(value), 'fly-to zoom must stay finite');
  assert.ok(value >= CAMERA_SETTINGS.minZoom - 1e-9 && value <= CAMERA_SETTINGS.maxZoom + 1e-9);
}
// World-to-world fly-to must not dip below world zoom.
const worldToWorld = flyToCamera({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0, zoom: 1 }, midpoint, 'smooth');
assert.equal(worldToWorld.zoom, 1, 'world-to-world fly-to must hold world zoom');

// 6. Deterministic evaluator: hold state, transition path, sequence timing.
const project = createProject('Transition verification');
const viewA = createView('A', [], { x: 0, y: 0, zoom: 3 });
const viewB = createView('B', [], { x: -360, y: -180, zoom: 6 });
const viewC = createView('C', [], { x: -500, y: -80, zoom: 3 });
viewA.holdDuration = 2;
viewA.transitionDuration = 4;
viewA.transitionPreset = 'smooth';
viewA.transitionType = 'fly-to';
viewB.holdDuration = 1;
viewB.transitionDuration = 0.5;
viewB.transitionPreset = 'linear';
viewB.transitionType = 'pan';
project.views = [viewA, viewB, viewC];
const runtimeProject = validateAndMigrateProject(project);

const sequence = compileViews(project.views);
assert.equal(
  sequence.duration,
  2 + 4 + 1 + 0.5 + 0,
  'sequence duration sums holds and transitions (new Views default to 0s hold)',
);

const atStart = evaluateProjectAtTime(runtimeProject, 0);
assert.deepEqual(atStart.camera, viewA.camera, 't=0 evaluates the exact first View camera');
assert.equal(atStart.activeViewIndex, 0);

const midFlyTo = evaluateProjectAtTime(runtimeProject, 2 + 2);
assert.ok(
  midFlyTo.camera.zoom < Math.min(viewA.camera.zoom, viewB.camera.zoom),
  'evaluator honors fly-to zoom-out mid-transition',
);
assert.equal(midFlyTo.activeViewIndex, 0, 'active View stays on the source during its transition');

const atEnd = evaluateProjectAtTime(runtimeProject, sequence.duration);
assert.deepEqual(atEnd.camera, viewC.camera, 'end evaluates the exact final View camera');
assert.equal(atEnd.activeViewIndex, 2);

// 7. Old projects without transitionType default to 'smooth'.
delete viewA.transitionType;
delete viewB.transitionType;
const legacyProject = createProject('Legacy');
legacyProject.views = [viewA, viewB, viewC];
const legacyMid = evaluateProjectAtTime(validateAndMigrateProject(legacyProject), 2 + 2);
const smoothReference = interpolateCamera(viewA.camera, viewB.camera, 0.5, viewA.transitionPreset, 'smooth');
assert.deepEqual(legacyMid.camera, smoothReference, 'missing transitionType must default to smooth');

// 8. Persistence: all presets and types survive validation; unknown types rejected.
for (const preset of PRESETS) {
  const candidate = createProject('Preset compatibility');
  const view = createView('V', [], { x: 0, y: 0, zoom: 1 });
  view.transitionPreset = preset;
  candidate.views = [view, createView('Destination', [], { x: 0, y: 0, zoom: 1 })];
  assert.equal(validateAndMigrateProject(candidate).transitions[0].preset, preset);
}
for (const type of TYPES) {
  const candidate = createProject('Type compatibility');
  const view = createView('V', [], { x: 0, y: 0, zoom: 1 });
  view.transitionType = type;
  candidate.views = [view, createView('Destination', [], { x: 0, y: 0, zoom: 1 })];
  assert.equal(validateAndMigrateProject(candidate).transitions[0].type, type);
}
const legacy = createProject('Legacy view');
const legacyView = createView('V', [], { x: 0, y: 0, zoom: 1 });
delete legacyView.transitionType;
legacy.views = [legacyView, createView('Destination', [], { x: 0, y: 0, zoom: 1 })];
assert.equal(validateAndMigrateProject(legacy).transitions[0].type, 'smooth', 'legacy defaults to smooth');
const badType = createProject('Bad type');
const badView = createView('V', [], { x: 0, y: 0, zoom: 1 });
badView.transitionType = 'orbit';
badType.views = [badView];
assert.throws(() => validateAndMigrateProject(badType), /transitionType is unsupported/);

console.log(
  `Transition verification: ${PRESETS.length} easing presets, ${TYPES.length} transition types, deterministic evaluator and persistence passed.`,
);
