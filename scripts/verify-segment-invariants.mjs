import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'mapmotion-segment-invariants-'));
const entry = join(out, 'entry.ts');
const source = (name) => join(root, 'src/core', name).replaceAll('\\', '/');
writeFileSync(
  entry,
  [
    `export * from '${source('project')}';`,
    `export * from '${source('viewCompiler')}';`,
    `export * from '${source('editorPreviewModes')}';`,
  ].join('\n'),
);
let m;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: out,
      emptyOutDir: false,
      minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'core.mjs' },
    },
  });
  m = await import(pathToFileURL(join(out, 'core.mjs')).href);
} finally {
  rmSync(out, { recursive: true, force: true });
}

const layer = (id) => {
  const value = m.createLayer('pin');
  value.id = id;
  value.name = id.toUpperCase();
  return value;
};

const makeThreeSegmentProject = () => {
  const project = m.createProject('Segment invariants');
  const layers = ['a', 'b', 'c'].map(layer);
  project.layers = layers;
  project.views = [0, 1, 2].map((index) => {
    const view = m.createView(`V${index + 1}`, layers, { x: index * 50, y: index * 10, zoom: index + 1 }, layers);
    view.id = `v${index + 1}`;
    view.holdDuration = 0;
    return view;
  });
  const t1 = m.createTransition('v1', 'v2', layers);
  const t2 = m.createTransition('v2', 'v3', layers);
  t1.id = 't1';
  t2.id = 't2';
  t1.duration = 2;
  t2.duration = 2;
  project.transitions = [t1, t2];
  return project;
};

// Stable-ID immutable membership update changes exactly one usage and no editor state.
{
  const before = makeThreeSegmentProject();
  before.views[0].layerConfigs.a.included = true;
  before.views[0].layerConfigs.b.included = false;
  before.views[1].layerConfigs.a.included = true;
  before.views[1].layerConfigs.b.included = true;
  before.transitions[0].layerConfigs.a.included = false;
  before.transitions[0].layerConfigs.b.included = true;
  before.transitions[0].layerConfigs.c.included = true;
  before.transitions[1].layerConfigs.a.included = false;
  before.transitions[1].layerConfigs.b.included = true;
  before.transitions[1].layerConfigs.c.included = false;
  const selection = {
    selectedTimelineEntity: { kind: 'transition', id: 't1' },
    selectedLayerId: 'a',
    playbackState: 'stopped',
    eyeHiddenLayerIds: new Set(['c']),
  };
  const viewsRef = before.views;
  const t2Ref = before.transitions[1];
  const aUsageRef = before.transitions[0].layerConfigs.a;
  const bUsageRef = before.transitions[0].layerConfigs.b;
  const after = m.setTransitionLayerIncluded(before, 't1', 'a', true);
  assert.notEqual(after, before);
  assert.equal(after.views, viewsRef);
  assert.equal(after.transitions[1], t2Ref);
  assert.notEqual(after.transitions[0].layerConfigs.a, aUsageRef);
  assert.equal(after.transitions[0].layerConfigs.b, bUsageRef);
  assert.equal(after.transitions[0].layerConfigs.b.included, true);
  assert.equal(after.transitions[0].layerConfigs.a.included, true);
  assert.equal(after.transitions[0].layerConfigs.c.included, true);
  assert.deepEqual(selection, {
    selectedTimelineEntity: { kind: 'transition', id: 't1' },
    selectedLayerId: 'a',
    playbackState: 'stopped',
    eyeHiddenLayerIds: new Set(['c']),
  });
  assert.equal(
    m.allocationCheckboxDisabled('stopped', selection.selectedTimelineEntity),
    false,
  );
  assert.equal(after.transitions.find((transition) => transition.id === 't1').id, 't1');

  let allOff = after;
  for (const id of ['a', 'b', 'c']) allOff = m.setTransitionLayerIncluded(allOff, 't1', id, false);
  assert.ok(Object.values(allOff.transitions[0].layerConfigs).every((usage) => !usage.included));
  assert.equal(m.allocationCheckboxDisabled('stopped', selection.selectedTimelineEntity), false);
  assert.equal(allOff.transitions[1], t2Ref);
  assert.equal(allOff.views, viewsRef);

  const changedView = m.setViewLayerIncluded(before, 'v1', 'b', true);
  assert.equal(changedView.transitions, before.transitions);
  assert.notEqual(changedView.views[0], before.views[0]);
  assert.equal(changedView.views[1], before.views[1]);
  assert.equal(changedView.views[2], before.views[2]);

  before.views[0].layerConfigs.a.animation = { appearEnabled: true, appearType: 'fade' };
  before.transitions[0].layerConfigs.a.animation = { appearEnabled: true, appearType: 'pop' };
  before.transitions[1].layerConfigs.a.animation = { appearEnabled: true, appearType: 'drop' };
  assert.notEqual(before.views[0].layerConfigs, before.transitions[0].layerConfigs);
  assert.notEqual(before.transitions[0].layerConfigs, before.transitions[1].layerConfigs);
  assert.notEqual(
    before.views[0].layerConfigs.a.animation,
    before.transitions[0].layerConfigs.a.animation,
  );
  assert.notEqual(
    before.transitions[0].layerConfigs.a.animation,
    before.transitions[1].layerConfigs.a.animation,
  );
}

const temporalStates = (project) => {
  const duration = m.compileTimeline(project).duration;
  const times = [];
  for (let frame = 0; frame <= Math.round(duration * 30); frame += 1) times.push(frame / 30);
  return times.map((time) => m.evaluateProjectAtTime(project, time));
};

// A zero-Hold View's membership and animations have no temporal effect.
{
  const base = makeThreeSegmentProject();
  base.transitions[0].layerConfigs.a = { included: true };
  base.transitions[1].layerConfigs.a = { included: false };
  base.views[1].layerConfigs.a = { included: false };
  const baseline = temporalStates(base);

  const membershipChanged = structuredClone(base);
  membershipChanged.views[1].layerConfigs.a.included = true;
  assert.deepEqual(temporalStates(membershipChanged), baseline);

  const animationChanged = structuredClone(membershipChanged);
  animationChanged.views[1].layerConfigs.a.animation = {
    appearEnabled: true,
    appearType: 'drop',
    appearDelay: 10,
    appearDuration: 5,
    wipeEnabled: true,
    wipeDuration: 4,
  };
  assert.deepEqual(temporalStates(animationChanged), baseline);
  assert.ok(!m.compileTimeline(base).segments.some((segment) => segment.id === 'v2'));

  const positiveHoldOff = structuredClone(base);
  positiveHoldOff.views[1].holdDuration = 2;
  const positiveHoldOn = structuredClone(positiveHoldOff);
  positiveHoldOn.views[1].layerConfigs.a.included = true;
  assert.notDeepEqual(
    m.evaluateProjectAtTime(positiveHoldOff, 2.5).layers,
    m.evaluateProjectAtTime(positiveHoldOn, 2.5).layers,
  );
}

// The next active Transition owns a zero-Hold boundary; the anchor View cannot flash or cut layers.
{
  const project = makeThreeSegmentProject();
  project.transitions[0].layerConfigs.a = { included: true };
  project.transitions[1].layerConfigs.a = {
    included: true,
    animation: { appearEnabled: true, appearType: 'fade', appearDuration: 1 },
  };
  project.views[1].layerConfigs.a.included = false;
  const atBoundary = m.evaluateProjectAtTime(project, 2);
  assert.equal(atBoundary.layers.find((candidate) => candidate.id === 'a').opacity, 1);

  project.transitions[0].layerConfigs.b.included = false;
  project.transitions[1].layerConfigs.b.included = false;
  project.views[1].layerConfigs.b.included = true;
  assert.ok(temporalStates(project).every((state) => !state.layers.some((candidate) => candidate.id === 'b')));

  const zeroDuration = m.createTransition('v1', 'v2', project.layers);
  zeroDuration.id = 'zero';
  zeroDuration.duration = 0;
  project.transitions = [zeroDuration, project.transitions[1]];
  assert.ok(!m.compileTimeline(project).segments.some((segment) => segment.id === 'zero'));
}

console.log('Segment invariants: stable-ID mutation isolation, editable all-off Transition, strict zero-Hold differential behavior, active-boundary ownership, and positive-Hold control passed.');
