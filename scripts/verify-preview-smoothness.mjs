import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-preview-smoothness-'));
const entryFile = join(outDir, 'entry.ts');
writeFileSync(
  entryFile,
  [
    "export * from '" + join(root, 'src', 'core', 'previewClock').replaceAll('\\', '/') + "';",
    "export * from '" + join(root, 'src', 'core', 'camera').replaceAll('\\', '/') + "';",
    "export * from '" + join(root, 'src', 'core', 'project').replaceAll('\\', '/') + "';",
    "export * from '" + join(root, 'src', 'core', 'viewCompiler').replaceAll('\\', '/') + "';",
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
      lib: { entry: entryFile, formats: ['es'], fileName: () => 'core.mjs' },
    },
  });
  mod = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const { PreviewClock, interpolateCamera, createProject, createView, createTransition, evaluateProjectAtTime } = mod;

class FakeScheduler {
  time = 0;
  nextId = 1;
  callbacks = new Map();
  maxPending = 0;
  now = () => this.time;
  request = (callback) => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    this.maxPending = Math.max(this.maxPending, this.callbacks.size);
    return id;
  };
  cancel = (id) => this.callbacks.delete(id);
  advance(milliseconds) {
    this.time += milliseconds;
    const pending = [...this.callbacks.values()];
    this.callbacks.clear();
    pending.forEach((callback) => callback(this.time));
  }
}

// The runtime owns exactly one rAF and derives time from elapsed timestamps.
const scheduler = new FakeScheduler();
const clock = new PreviewClock(scheduler);
const samples = [];
let completions = 0;
clock.subscribe(() => samples.push(clock.getSnapshot()));
clock.play(3, () => completions++);
for (const step of [7, 19, 5, 41, 16, 33]) scheduler.advance(step);
assert.equal(scheduler.maxPending, 1, 'Preview must never schedule overlapping animation frames');
assert.ok(samples.every((time, index) => index === 0 || time >= samples[index - 1]), 'clock must be monotonic');
assert.equal(clock.getSnapshot(), 0.121, 'clock must use elapsed wall time, not a fixed frame delta');

clock.pause();
const pausedAt = clock.getSnapshot();
scheduler.advance(500);
assert.equal(clock.getSnapshot(), pausedAt, 'Pause must freeze the exact project time');
clock.play(3, () => completions++);
scheduler.advance(250);
assert.equal(clock.getSnapshot(), pausedAt + 0.25, 'Resume must continue from the exact paused time');
scheduler.advance(3000);
assert.equal(completions, 1, 'natural completion must fire once');

// Camera evaluation is independent of display refresh cadence.
const from = { x: 0, y: 0, zoom: 1 };
const to = { x: -640, y: -250, zoom: 4.75 };
for (const type of ['smooth', 'pan', 'zoom', 'fly-to']) {
  const at = (seconds) => interpolateCamera(from, to, seconds / 2, 'cinematic', type);
  for (const refreshRate of [60, 120, 240]) {
    const sample = at((refreshRate / 2) / refreshRate);
    assert.deepEqual(sample, at(0.5), `${type} must evaluate identically at ${refreshRate} Hz`);
  }
  assert.deepEqual(at(0), from, `${type} must preserve its exact source endpoint`);
  assert.deepEqual(at(2), to, `${type} must preserve its exact destination endpoint`);
  for (let step = 0; step <= 1000; step++) {
    const camera = at((step / 1000) * 2);
    assert.ok(Object.values(camera).every(Number.isFinite), `${type} must never emit non-finite camera values`);
  }
}

// Linear subpixel pan and zoom remain monotonic at dense sampling cadence.
let previous = interpolateCamera(from, to, 0, 'linear', 'smooth');
for (let step = 1; step <= 10000; step++) {
  const camera = interpolateCamera(from, to, step / 10000, 'linear', 'smooth');
  assert.ok(camera.x <= previous.x && camera.y <= previous.y, 'linear pan must not move backward');
  assert.ok(camera.zoom >= previous.zoom, 'linear zoom must not pulse backward');
  previous = camera;
}

// Zero-Hold boundary uses the anchor camera exactly and Preview evaluation is read-only.
const project = createProject('Smoothness boundary');
const first = createView('First', [], from, []);
const anchor = createView('Anchor', [], { x: -300, y: -120, zoom: 2.5 }, []);
const last = createView('Last', [], to, []);
first.holdDuration = 0;
anchor.holdDuration = 0;
last.holdDuration = 1;
const incoming = createTransition(first.id, anchor.id, [], first);
const outgoing = createTransition(anchor.id, last.id, [], anchor);
incoming.duration = 2;
outgoing.duration = 2;
incoming.preset = outgoing.preset = 'linear';
project.views = [first, anchor, last];
project.transitions = [incoming, outgoing];
const beforeEvaluation = JSON.stringify(project);
assert.deepEqual(evaluateProjectAtTime(project, 2).camera, anchor.camera, 'zero-Hold boundary camera must be exact');
assert.deepEqual(evaluateProjectAtTime(project, 4).camera, last.camera, 'final transition endpoint must be exact');
for (const time of [0, 1, 2, 2 + 1 / 240, 3, 4]) evaluateProjectAtTime(project, time);
assert.equal(JSON.stringify(project), beforeEvaluation, 'Preview evaluation must not write camera or layer state back');

const appSource = readFileSync(join(root, 'src', 'app', 'App.tsx'), 'utf8');
assert.ok(!appSource.includes('setPreviewTime('), 'root App must not own display-rate Preview time state');
assert.ok(
  appSource.includes('scroller.scrollLeft = position - scroller.clientWidth + edgePadding'),
  'display-rate timeline following must use direct scrolling',
);
assert.ok(appSource.includes('useSyncExternalStore'), 'Preview consumers must subscribe without re-rendering the editor shell');

console.log('Preview smoothness verification passed');
