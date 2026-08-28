import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-camera-continuity-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/camera').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/globeMath').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/cameraContinuity').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/viewCompiler').replaceAll('\\', '/')}';`,
  ].join('\n'),
);
let m;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: { outDir, emptyOutDir: false, minify: false, lib: { entry, formats: ['es'], fileName: () => 'core.mjs' } },
  });
  m = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const close = (a, b, tolerance, label) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} ~= ${b}`);
const unwrapNear = (value, reference) => reference + m.normalizeBearing((value ?? 0) - reference);
const scalarState = (camera, referenceBearing) => [
  camera.x,
  camera.y,
  Math.log(camera.zoom),
  unwrapNear(camera.bearing, referenceBearing),
  camera.pitch ?? 0,
];
const derivative = (left, right, dt) => left.map((value, index) => (right[index] - value) / dt);

function makeProject(mode, cameras, durations, holds) {
  const project = m.createProject(`${mode} continuity`);
  project.views = cameras.map((camera, index) => {
    const view = m.createView(`V${index + 1}`, [], camera, [], mode);
    view.holdDuration = holds[index] ?? 0;
    return view;
  });
  project.transitions = project.views.slice(0, -1).map((view, index) => {
    const transition = m.createTransition(view.id, project.views[index + 1].id, [], view);
    transition.duration = durations[index];
    transition.preset = index % 2 ? 'ease-in-out' : 'cinematic';
    transition.type = index % 2 ? 'fly-to' : 'smooth';
    return transition;
  });
  return project;
}

const flatCameras = [
  { x: -80, y: 25, zoom: 1.2, bearing: 170, pitch: -25 },
  { x: -260, y: -75, zoom: 2.8, bearing: -170, pitch: 18 },
  { x: -520, y: 45, zoom: 1.7, bearing: -145, pitch: 42 },
  { x: -690, y: -130, zoom: 4.3, bearing: -80, pitch: -12 },
];
const durations = [0.5, 5, 1];
const flat = makeProject('flat', flatCameras, durations, [0, 0, 0, 1]);
const epsilon = 0.0001;
for (const boundary of [durations[0], durations[0] + durations[1]]) {
  const index = boundary === durations[0] ? 1 : 2;
  const exact = m.evaluateProjectAtTime(flat, boundary).camera;
  assert.deepEqual(exact, flat.views[index].camera, 'zero-Hold boundary hits exact Flat waypoint');
  const reference = flat.views[index].camera.bearing ?? 0;
  const before = scalarState(m.evaluateProjectAtTime(flat, boundary - epsilon).camera, reference);
  const at = scalarState(exact, reference);
  const after = scalarState(m.evaluateProjectAtTime(flat, boundary + epsilon).camera, reference);
  const leftVelocity = derivative(before, at, epsilon);
  const rightVelocity = derivative(at, after, epsilon);
  leftVelocity.forEach((value, component) =>
    close(
      value,
      rightVelocity[component],
      component < 2 ? 3 : component === 3 ? 0.25 : 0.12,
      `Flat velocity component ${component}`,
    ),
  );
}

// Positive Hold is a deliberate stop and remains temporally stationary.
const stopped = makeProject('flat', flatCameras.slice(0, 3), [1, 1], [0, 1, 1]);
assert.deepEqual(m.evaluateProjectAtTime(stopped, 1.25).camera, stopped.views[1].camera);
assert.deepEqual(m.evaluateProjectAtTime(stopped, 1.75).camera, stopped.views[1].camera);

const orientation = (axis, degrees) => m.quaternionFromAxisAngle(axis, (degrees * Math.PI) / 180);
const globeCameras = [
  { x: 0, y: 0, zoom: 1.3, pitch: -35, globeOrientation: orientation([0, 1, 0], 12) },
  { x: 0, y: 0, zoom: 3.1, pitch: 10, globeOrientation: orientation([1, 1, 0], 95) },
  { x: 0, y: 0, zoom: 2.2, pitch: 48, globeOrientation: orientation([0, 1, 1], -130) },
  { x: 0, y: 0, zoom: 5.2, pitch: -8, globeOrientation: orientation([1, 0, 1], 172) },
];
const globe = makeProject('globe', globeCameras, durations, [0, 0, 0, 1]);
const angularVelocity = (from, to, dt) =>
  m.quaternionRotationVector(
    m.multiplyQuaternions(m.globeOrientationOf(to), m.conjugateQuaternion(m.globeOrientationOf(from))),
  ).map((value) => value / dt);
for (const boundary of [durations[0], durations[0] + durations[1]]) {
  const index = boundary === durations[0] ? 1 : 2;
  const before = m.evaluateProjectAtTime(globe, boundary - epsilon).camera;
  const exact = m.evaluateProjectAtTime(globe, boundary).camera;
  const after = m.evaluateProjectAtTime(globe, boundary + epsilon).camera;
  assert.deepEqual(exact, globe.views[index].camera, 'zero-Hold boundary hits exact Globe waypoint');
  const left = angularVelocity(before, exact, epsilon);
  const right = angularVelocity(exact, after, epsilon);
  left.forEach((value, component) => close(value, right[component], 0.08, `Globe angular velocity ${component}`));
  const scalarBefore = scalarState(before, 0), scalarAt = scalarState(exact, 0), scalarAfter = scalarState(after, 0);
  const leftScalar = derivative(scalarBefore, scalarAt, epsilon);
  const rightScalar = derivative(scalarAt, scalarAfter, epsilon);
  for (const component of [2, 4]) close(leftScalar[component], rightScalar[component], 0.12, `Globe scalar velocity ${component}`);
}

// Absolute seeking is deterministic and finite over mixed deterministic chains.
let seed = 0x7a11ce;
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
for (let count = 3; count <= 10; count += 1) {
  const cameras = Array.from({ length: count }, () => ({
    x: -800 * random(), y: -300 + 600 * random(), zoom: 1 + 5 * random(),
    bearing: -180 + 360 * random(), pitch: -60 + 120 * random(),
  }));
  const chainDurations = Array.from({ length: count - 1 }, () => 0.4 + 4.6 * random());
  const holds = Array.from({ length: count }, (_, index) => index > 0 && index < count - 1 && random() > 0.65 ? 0.5 : 0);
  const project = makeProject('flat', cameras, chainDurations, holds);
  const sequence = m.compileTimeline(project);
  for (let sample = 0; sample <= 30; sample += 1) {
    const time = (sequence.duration * sample) / 30;
    const first = m.evaluateProjectAtTime(project, time).camera;
    assert.deepEqual(m.evaluateProjectAtTime(project, time).camera, first);
    assert.ok(Object.values(first).every((value) => typeof value !== 'number' || Number.isFinite(value)));
  }
}

console.log('Zero-Hold camera continuity verification passed for Flat and Globe.');
