import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-transition-speed-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/transitionTiming').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectFile').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/viewCompiler').replaceAll('\\', '/')}';`,
  ].join('\n'),
);
let m;
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
  m = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const project = m.createProject('Transition Speed');
const from = m.createView('From', [], { x: 0, y: 0, zoom: 1, bearing: 0, pitch: 0 }, []);
const to = m.createView('To', [], { x: -500, y: -220, zoom: 4, bearing: 120, pitch: 60 }, []);
from.holdDuration = 0;
to.holdDuration = 1;
project.views = [from, to];
const baseline = m.createTransition(from.id, to.id, [], from);
project.transitions = [baseline];
assert.deepEqual(
  {
    duration: baseline.duration,
    reference: baseline.referenceDuration,
    speed: baseline.speed,
    source: baseline.timingSource,
  },
  { duration: 2.5, reference: 2.5, speed: 1, source: 'duration' },
);

for (const [speed, duration] of [
  [0.5, 5],
  [1, 2.5],
  [1.25, 2],
  [2, 1.25],
]) {
  const changed = m.setTransitionSpeed(baseline, speed);
  assert.equal(changed.speed, speed);
  assert.equal(changed.duration, duration);
  assert.equal(changed.referenceDuration, 2.5);
  assert.equal(changed.timingSource, 'speed');
}
const awkwardSpeed = m.setTransitionSpeed(baseline, 1.237);
assert.equal(awkwardSpeed.speed, 1.237);
assert.equal(awkwardSpeed.duration, 2.5 / 1.237);
for (const [duration, speed] of [
  [5, 0.5],
  [2.5, 1],
  [2, 1.25],
  [1.25, 2],
  [1.876, 1.333],
]) {
  const changed = m.setTransitionDuration(baseline, duration);
  assert.equal(changed.duration, duration);
  assert.equal(changed.speed, speed);
  assert.equal(changed.referenceDuration, 2.5);
  assert.equal(changed.timingSource, 'duration');
}

let alternating = m.setTransitionSpeed(baseline, 1.25);
alternating = m.setTransitionDuration(alternating, 5);
alternating = m.setTransitionSpeed(alternating, 2);
assert.deepEqual(
  { reference: alternating.referenceDuration, duration: alternating.duration, speed: alternating.speed },
  { reference: 2.5, duration: 1.25, speed: 2 },
  'Bidirectional edits never redefine the reference or accumulate drift.',
);

const speedSamples = [0.001, 0.125, 0.537, 0.999, 1, 1.001, 1.237, 2.347, 3.999, 4];
for (const input of speedSamples) {
  const changed = m.setTransitionSpeed(baseline, input);
  assert.ok(
    Math.abs(Math.round(changed.speed * 1000) - changed.speed * 1000) < 1e-9,
    'Speed is authored to 0.001 precision.',
  );
  assert.ok(changed.duration >= 0 && changed.duration <= 30, 'Dynamic range always produces valid duration.');
}
const range = m.transitionSpeedRange(2.5);
assert.deepEqual(range, { min: 0.084, max: 4 });
assert.deepEqual(
  {
    speed: m.setTransitionSpeed(baseline, 0.001).speed,
    duration: m.setTransitionSpeed(baseline, 0.001).duration,
  },
  { speed: 0.084, duration: 2.5 / 0.084 },
);
const zero = m.setTransitionDuration(baseline, 0);
assert.equal(m.transitionDisplaySpeed(zero), null);
assert.equal(
  m.setTransitionSpeed(zero, 2).duration,
  0,
  'Zero-duration cuts cannot create Infinity or implied timing.',
);

const speedAuthoredProject = structuredClone(project);
speedAuthoredProject.transitions[0] = awkwardSpeed;
const speedReopened = m.parseProjectFile(m.serializeCanonicalProject(speedAuthoredProject).json);
assert.equal(speedReopened.transitions[0].speed, 1.237);
assert.equal(speedReopened.transitions[0].duration, 2.5 / 1.237);
assert.equal(speedReopened.transitions[0].timingSource, 'speed');
const durationAuthoredProject = structuredClone(project);
durationAuthoredProject.transitions[0] = m.setTransitionDuration(baseline, 1.876);
const durationReopened = m.parseProjectFile(m.serializeCanonicalProject(durationAuthoredProject).json);
assert.equal(durationReopened.transitions[0].duration, 1.876);
assert.equal(durationReopened.transitions[0].speed, 1.333);
assert.equal(durationReopened.transitions[0].timingSource, 'duration');

const oldProject = structuredClone(project);
delete oldProject.transitions[0].referenceDuration;
delete oldProject.transitions[0].speed;
delete oldProject.transitions[0].timingSource;
const migrated = m.parseProjectFile(JSON.stringify(oldProject));
assert.deepEqual(
  {
    duration: migrated.transitions[0].duration,
    reference: migrated.transitions[0].referenceDuration,
    speed: migrated.transitions[0].speed,
    source: migrated.transitions[0].timingSource,
  },
  { duration: 2.5, reference: 2.5, speed: 1, source: 'duration' },
  'Old transitions migrate without timing changes.',
);

const normalizedSamples = [0, 0.25, 0.5, 0.75, 1];
const cameraSamples = [];
for (const speed of [0.5, 1, 2]) {
  const timed = structuredClone(project);
  timed.transitions[0] = m.setTransitionSpeed(baseline, speed);
  const sequence = m.compileTimeline(timed);
  assert.equal(sequence.duration, timed.transitions[0].duration + to.holdDuration);
  cameraSamples.push(
    normalizedSamples.map(
      (progress) => m.evaluateProjectAtTime(timed, timed.transitions[0].duration * progress).camera,
    ),
  );
}
assert.deepEqual(cameraSamples[0], cameraSamples[1]);
assert.deepEqual(cameraSamples[1], cameraSamples[2]);

const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
assert.match(app, /className="transition-speed-input"/);
assert.match(app, /step=\{TRANSITION_SPEED_STEP\}/);
assert.match(app, /onWheel=\{\(event\) => event\.stopPropagation\(\)\}/);
assert.match(app, /onBlur=\{\(\) => commit\(\)\}/);
assert.match(app, /event\.key === 'Enter'/);
assert.match(app, /nativeEvent as InputEvent\)\.inputType/);
assert.match(app, /value=\{draft\}/);
assert.match(app, /setTransitionSpeed\(transition, patch\.speed\)/);
assert.match(app, /setTransitionDuration\(transition, patch\.duration\)/);

console.log(
  'Transition Speed: bidirectional timing, 0.001 precision, dynamic limits, zero cuts, migration, persistence, timeline, and normalized camera invariance passed.',
);
