import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-pitch-parity-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(entry, [
  'project', 'camera', 'globeMath', 'cameraContinuity', 'viewCompiler', 'projectPersistence', 'previewClock',
].map((name) => `export * from '${join(root, `src/core/${name}`).replaceAll('\\', '/')}';`).join('\n'));
let m;
try {
  await build({ configFile: false, logLevel: 'silent', build: {
    outDir, emptyOutDir: false, minify: false, lib: { entry, formats: ['es'], fileName: () => 'core.mjs' },
  }});
  m = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally { rmSync(outDir, { recursive: true, force: true }); }

const pitches = [85, 80, 60, 0, -60, -80, -85];
for (const mode of ['flat', 'globe']) for (const pitch of pitches) {
  const camera = m.roundCamera({
    x: -120, y: -40, zoom: 2.4, bearing: 47, pitch,
    ...(mode === 'globe' ? {
      globeOrientation: m.quaternionFromAxisAngle([0, 1, 0], 0.8),
      globeFocus: { x: 0.42, y: 0.31, z: -0.852349693 },
    } : {}),
  });
  assert.equal(camera.pitch, pitch, `${mode} round-trip preserves ${pitch}`);
  const constrained = m.constrainCamera(camera);
  assert.equal(constrained.pitch, pitch, `${mode} constrain preserves ${pitch}`);
  if (mode === 'globe') {
    assert.deepEqual(constrained.globeOrientation, camera.globeOrientation);
    assert.deepEqual(constrained.globeFocus, camera.globeFocus);
  } else {
    for (const bearing of [0, 45, 90, 180, -90]) {
      const candidate = { ...camera, bearing };
      for (const point of [[500, 280]]) {
        const world = m.unprojectScreenToWorld(candidate, point[0], point[1]);
        assert.ok(world && Number.isFinite(world.x) && Number.isFinite(world.y));
        const screen = m.projectWorldToScreen(candidate, world.x, world.y);
        assert.ok(screen && Math.abs(screen.x - point[0]) < 1e-6 && Math.abs(screen.y - point[1]) < 1e-6);
      }
    }
  }
  const project = m.createProject(`${mode} ${pitch}`);
  const view = m.createView('Anchor', [], camera, [], mode);
  view.holdDuration = 1;
  project.views = [view];
  const evaluated = m.evaluateProjectAtTime(project, 0).camera;
  assert.deepEqual(evaluated, view.camera, 'exact first Preview frame equals View camera');
  if (mode === 'globe') {
    const editor = m.globeCameraMatrices(camera, 1920, 1080);
    const preview = m.globeCameraMatrices(evaluated, 1920, 1080);
    assert.deepEqual([...preview.viewProjection], [...editor.viewProjection]);
    assert.deepEqual(preview.position, editor.position);
    assert.deepEqual(preview.target, editor.target);
  }
  const reopened = m.validateAndMigrateProject(JSON.parse(m.canonicalProjectJson(project)));
  assert.equal(reopened.views[0].camera.pitch, pitch, `${mode} Save/Open preserves Pitch`);
}

for (const pitch of [85, -85]) {
  const project = m.createProject(`constant ${pitch}`);
  project.views = [0, 1, 2, 3].map((index) => {
    const view = m.createView(`V${index}`, [], {
      x: 0, y: 0, zoom: 1.5 + index,
      pitch,
      globeOrientation: m.quaternionFromAxisAngle([0, 1, 0], index * 0.35),
      globeFocus: { x: 1, y: 0, z: 0 },
    }, [], 'globe');
    view.holdDuration = index === 3 ? 1 : 0;
    return view;
  });
  project.transitions = project.views.slice(0, -1).map((view, index) => {
    const transition = m.createTransition(view.id, project.views[index + 1].id, [], view);
    transition.duration = 1;
    return transition;
  });
  for (let sample = 0; sample <= 300; sample += 1)
    assert.equal(m.evaluateProjectAtTime(project, sample / 100).camera.pitch, pitch, 'constant extreme Pitch chain');
}

const bounded = m.createProject('bounded pitch');
bounded.views = [70, 85, 70].map((pitch, index) => {
  const view = m.createView(`P${index}`, [], { x: 0, y: 0, zoom: 2, pitch }, [], 'flat');
  view.holdDuration = index === 2 ? 1 : 0;
  return view;
});
bounded.transitions = bounded.views.slice(0, -1).map((view, index) => {
  const transition = m.createTransition(view.id, bounded.views[index + 1].id, [], view);
  transition.duration = 1;
  return transition;
});
for (let sample = 0; sample <= 200; sample += 1) {
  const pitch = m.evaluateProjectAtTime(bounded, sample / 100).camera.pitch;
  assert.ok(pitch >= 70 && pitch <= 85, `bounded Hermite Pitch: ${pitch}`);
}

const callbacks = [];
let now = 100;
const clock = new m.PreviewClock({ now: () => now, request: (callback) => (callbacks.push(callback), callbacks.length), cancel: () => {} });
const observed = [];
clock.subscribe(() => observed.push(clock.getSnapshot()));
clock.play(2, () => {});
callbacks.shift()(116);
assert.equal(observed.at(-1), 0, 'first scheduled Preview frame remains exact t=0');
callbacks.shift()(132);
assert.equal(observed.at(-1), 0.016, 'elapsed time begins on the following frame');

console.log('Unified ±85° Pitch, View/evaluator/renderer parity, bounded continuity, and exact first frame passed.');
