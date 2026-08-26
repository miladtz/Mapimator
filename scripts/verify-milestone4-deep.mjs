import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'mapmotion-m4-deep-'));
const entry = join(out, 'entry.ts');
const source = (name) => join(root, 'src/core', name).replaceAll('\\', '/');
writeFileSync(
  entry,
  [
    `export * from '${source('project')}';`,
    `export * from '${source('viewCompiler')}';`,
    `export * from '${source('projectPersistence')}';`,
    `export * from '${source('editingScene')}';`,
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

const makeLayer = (id, type = 'pin') => {
  const layer = m.createLayer(type);
  layer.id = id;
  layer.name = id.toUpperCase();
  return layer;
};
const pattern = (entity, ids, bits) => {
  for (let index = 0; index < ids.length; index += 1)
    entity.layerConfigs[ids[index]] = { included: Boolean(bits[index]) };
};
const fixture = () => {
  const project = m.createProject('Deep invariant fixture');
  project.layers = [makeLayer('a'), makeLayer('b'), makeLayer('c', 'text'), makeLayer('d')];
  const ids = project.layers.map((layer) => layer.id);
  const bits = [
    [1, 0, 1, 0],
    [0, 1, 1, 0],
    [1, 1, 0, 0],
    [0, 0, 1, 1],
  ];
  const holds = [0, 1, 0, 2];
  project.views = bits.map((row, index) => {
    const view = m.createView(`V${index + 1}`, [], { x: index * 75, y: index * -20, zoom: index + 1 }, project.layers);
    view.id = `v${index + 1}`;
    view.holdDuration = holds[index];
    pattern(view, ids, row);
    return view;
  });
  project.transitions = project.views.slice(0, -1).map((view, index) => {
    const transition = m.createTransition(view.id, project.views[index + 1].id, project.layers);
    transition.id = `t${index + 1}`;
    transition.duration = index + 1;
    pattern(transition, ids, bits[(index + 1) % bits.length]);
    return transition;
  });
  return project;
};
const usageSnapshot = (project) => ({
  views: project.views.map((view) => structuredClone(view.layerConfigs)),
  transitions: project.transitions.map((transition) => structuredClone(transition.layerConfigs)),
});
const editor = () => ({
  selectedTimelineEntity: null,
  selectedProjectLayerId: 'b',
  playbackState: 'stopped',
  previewTime: null,
  eyeHiddenLayerIds: new Set(['d']),
  transitionPopoverId: null,
});
const assertUnique = (values, label) =>
  assert.equal(new Set(values).size, values.length, `${label} ids are unique`);
const assertNoSharedUsage = (project) => {
  const entities = [...project.views, ...project.transitions];
  for (let left = 0; left < entities.length; left += 1) {
    for (let right = left + 1; right < entities.length; right += 1) {
      assert.notEqual(entities[left].layerConfigs, entities[right].layerConfigs, 'usage maps are independent');
      for (const layer of project.layers) {
        assert.notEqual(
          entities[left].layerConfigs[layer.id],
          entities[right].layerConfigs[layer.id],
          'usage records are independent',
        );
        const a = entities[left].layerConfigs[layer.id]?.animation;
        const b = entities[right].layerConfigs[layer.id]?.animation;
        if (a && b) assert.notEqual(a, b, 'animation records are independent');
      }
    }
  }
};
const assertProjectInvariants = (project, state = null) => {
  assertUnique(project.layers.map((layer) => layer.id), 'Layer');
  assertUnique(project.views.map((view) => view.id), 'View');
  assertUnique(project.transitions.map((transition) => transition.id), 'Transition');
  const viewIds = new Set(project.views.map((view) => view.id));
  const layerIds = new Set(project.layers.map((layer) => layer.id));
  for (const view of project.views) {
    assert.ok(Number.isFinite(view.holdDuration) && view.holdDuration >= 0);
    assert.ok(!('transitionDuration' in view), 'normalized View has no Transition state');
    for (const id of Object.keys(view.layerConfigs)) assert.ok(layerIds.has(id));
  }
  for (const transition of project.transitions) {
    assert.ok(viewIds.has(transition.fromViewId) && viewIds.has(transition.toViewId));
    assert.ok(Number.isFinite(transition.duration) && transition.duration >= 0);
    for (const id of Object.keys(transition.layerConfigs)) assert.ok(layerIds.has(id));
  }
  assertNoSharedUsage(project);
  if (state?.selectedTimelineEntity) {
    const pool = state.selectedTimelineEntity.kind === 'view' ? project.views : project.transitions;
    assert.ok(pool.some((entity) => entity.id === state.selectedTimelineEntity.id));
  }
};
const setAll = (project, selection, included) => {
  let next = project;
  for (const layer of project.layers)
    next =
      selection.kind === 'view'
        ? m.setViewLayerIncluded(next, selection.id, layer.id, included)
        : m.setTransitionLayerIncluded(next, selection.id, layer.id, included);
  return next;
};

// Formal mutation matrix and structural sharing.
{
  const project = fixture();
  const state = editor();
  state.selectedTimelineEntity = { kind: 'transition', id: 't1' };
  state.transitionPopoverId = 't1';
  const beforeState = structuredClone(state);
  const layersRef = project.layers;
  const viewsRef = project.views;
  const t2Ref = project.transitions[1];
  const otherUsageRef = project.transitions[0].layerConfigs.b;
  const beforeUsages = usageSnapshot(project);
  const next = m.setTransitionLayerIncluded(project, 't1', 'a', true);
  assert.notEqual(next, project);
  assert.equal(next.layers, layersRef);
  assert.equal(next.views, viewsRef);
  assert.equal(next.transitions[1], t2Ref);
  assert.equal(next.transitions[0].layerConfigs.b, otherUsageRef);
  assert.deepEqual(state, beforeState);
  assert.deepEqual(usageSnapshot(next).views, beforeUsages.views);
  assert.deepEqual(usageSnapshot(next).transitions.slice(1), beforeUsages.transitions.slice(1));

  const viewBefore = usageSnapshot(next);
  const viewChanged = m.setViewLayerIncluded(next, 'v1', 'b', true);
  assert.deepEqual(usageSnapshot(viewChanged).transitions, viewBefore.transitions);
  assert.deepEqual(usageSnapshot(viewChanged).views.slice(1), viewBefore.views.slice(1));

  const membershipBeforeProperty = usageSnapshot(viewChanged);
  const propertyChanged = {
    ...viewChanged,
    layers: viewChanged.layers.map((layer) =>
      layer.id === 'a' ? { ...layer, x: 900, y: 500, color: '#123456', opacity: 0.4, locked: true } : layer,
    ),
  };
  assert.deepEqual(usageSnapshot(propertyChanged), membershipBeforeProperty);
  for (const entity of [...propertyChanged.views, ...propertyChanged.transitions]) {
    const resolved = m.resolveSegmentLayer(
      propertyChanged,
      { kind: 'view', id: entity.id },
      'a',
    );
    if ('holdDuration' in entity && entity.layerConfigs.a.included) assert.equal(resolved.color, '#123456');
  }
}

// Rapid stable-ID selection, membership toggles, all-off recovery, and mode predicates.
{
  let project = fixture();
  const state = editor();
  const ids = [
    ['view', 'v1'], ['transition', 't1'], ['view', 'v2'], ['transition', 't2'], ['view', 'v3'],
    ['transition', 't1'], ['view', 'v1'], ['transition', 't2'], ['view', 'v2'], ['transition', 't1'], ['view', 'v3'],
  ];
  const before = usageSnapshot(project);
  for (let repeat = 0; repeat < 40; repeat += 1) {
    const [kind, id] = ids[repeat % ids.length];
    state.selectedTimelineEntity = { kind, id };
    assert.equal(m.isSegmentEditMode(state.playbackState, state.selectedTimelineEntity), true);
    assert.equal(state.selectedTimelineEntity.id, id);
    assert.deepEqual(usageSnapshot(project), before);
  }
  state.selectedTimelineEntity = { kind: 'transition', id: 't1' };
  for (const included of [false, true, false, true, false, true]) {
    project = m.setTransitionLayerIncluded(project, 't1', 'a', included);
    assert.deepEqual(state.selectedTimelineEntity, { kind: 'transition', id: 't1' });
    assert.equal(m.canEditMembership('stopped', state.selectedTimelineEntity), true);
  }
  project = setAll(project, state.selectedTimelineEntity, false);
  assert.ok(Object.values(project.transitions[0].layerConfigs).every((usage) => !usage.included));
  assert.equal(m.canOpenTransitionPopover('stopped', state.selectedTimelineEntity), true);
  project = m.setTransitionLayerIncluded(project, 't1', 'c', true);
  assert.equal(project.transitions[0].layerConfigs.c.included, true);
  assert.equal(m.canEditAnimation('stopped', state.selectedTimelineEntity, false), false);
  assert.equal(m.canEditAnimation('stopped', state.selectedTimelineEntity, true), true);
  assert.equal(m.canEditProjectLayer('paused'), false);
  assert.equal(m.canToggleMapMode('playing'), false);
}

// Eye/membership truth table and preservation through the Preview state machine.
{
  const project = fixture();
  const state = editor();
  const selection = { kind: 'view', id: 'v2' };
  state.selectedTimelineEntity = selection;
  for (const eyeOn of [false, true]) {
    for (const included of [false, true]) {
      const changed = m.setViewLayerIncluded(project, 'v2', 'a', included);
      const editScene = m.resolveEditingScene(changed, selection);
      const editVisible = editScene.layers.some((layer) => layer.id === 'a') && eyeOn;
      assert.equal(editVisible, eyeOn, 'Eye alone controls edit visibility');
      const viewStart = m.compileTimeline(changed).segments.find((segment) => segment.id === 'v2').start;
      const previewVisible = m.evaluateProjectAtTime(changed, viewStart + 0.5).layers.some((layer) => layer.id === 'a');
      assert.equal(previewVisible, included, 'membership alone controls Preview');
    }
  }
  const playing = m.playPreviewMode(state);
  const paused = m.pausePreviewMode(playing);
  const manual = m.stopPreviewMode(paused);
  const natural = m.completePreviewMode(paused);
  assert.deepEqual(natural, manual);
  assert.equal(manual.selectedProjectLayerId, 'b');
  assert.deepEqual(manual.eyeHiddenLayerIds, new Set(['d']));
  assert.equal(m.isMapMode(manual.playbackState, manual.selectedTimelineEntity), true);
}

// Add/delete/duplicate ownership and persistence round trips.
{
  let project = fixture();
  const before = usageSnapshot(project);
  const added = makeLayer('new');
  project = m.addProjectLayer(project, added);
  assert.equal(project.layers.filter((layer) => layer.id === 'new').length, 1);
  for (const entity of [...project.views, ...project.transitions])
    assert.deepEqual(entity.layerConfigs.new, { included: false });
  assert.deepEqual(
    {
      views: project.views.map((view) => {
        const { new: ignored, ...configs } = view.layerConfigs;
        return configs;
      }),
      transitions: project.transitions.map((transition) => {
        const { new: ignored, ...configs } = transition.layerConfigs;
        return configs;
      }),
    },
    before,
  );
  const duplicate = structuredClone(project.views[1]);
  duplicate.id = 'v2-copy';
  assert.notEqual(duplicate.layerConfigs, project.views[1].layerConfigs);
  for (const id of Object.keys(duplicate.layerConfigs))
    assert.notEqual(duplicate.layerConfigs[id], project.views[1].layerConfigs[id]);
  const deleted = m.deleteProjectLayer(project, 'a');
  assert.ok(!deleted.layers.some((layer) => layer.id === 'a'));
  assert.ok([...deleted.views, ...deleted.transitions].every((entity) => !entity.layerConfigs.a));
  assert.doesNotThrow(() => m.evaluateProjectAtTime(deleted, 0.5));

  const normalized = m.validateAndMigrateProject(JSON.parse(JSON.stringify(project)));
  const reopened = m.validateAndMigrateProject(JSON.parse(JSON.stringify(normalized)));
  assert.deepEqual(reopened, normalized, 'normalized Save/Open is idempotent');
  assertProjectInvariants(reopened);
}

// Exhaustive zero-Hold membership, animation, camera, and terminal matrices.
{
  for (let mask = 0; mask < 8; mask += 1) {
    const project = fixture();
    project.views.forEach((view) => (view.holdDuration = 0));
    project.transitions = project.transitions.slice(0, 2);
    project.transitions[0].layerConfigs.a.included = Boolean(mask & 1);
    project.views[1].layerConfigs.a.included = Boolean(mask & 2);
    project.transitions[1].layerConfigs.a.included = Boolean(mask & 4);
    const before = [0.5, 0.999999].map((time) => m.evaluateProjectAtTime(project, time));
    const boundary = project.transitions[0].duration;
    const around = [boundary, boundary + 0.000001].map((time) => m.evaluateProjectAtTime(project, time));
    const changed = structuredClone(project);
    changed.views[1].layerConfigs.a.included = !changed.views[1].layerConfigs.a.included;
    changed.views[1].layerConfigs.a.animation = {
      appearEnabled: true,
      appearType: ['fade', 'pop', 'drop'][mask % 3],
      appearDelay: mask,
      appearDuration: mask + 0.1,
      layerHoldDuration: mask / 2,
      wipeEnabled: true,
      wipeDuration: mask + 0.1,
    };
    assert.deepEqual([0.5, 0.999999].map((time) => m.evaluateProjectAtTime(changed, time)), before);
    assert.deepEqual(
      [boundary, boundary + 0.000001].map((time) => m.evaluateProjectAtTime(changed, time)),
      around,
    );
    assert.deepEqual(m.evaluateProjectAtTime(project, boundary).camera, project.views[1].camera);
  }
  const terminal = fixture();
  terminal.views.at(-1).holdDuration = 0;
  terminal.views.at(-1).layerConfigs.a.included = true;
  terminal.transitions.at(-1).layerConfigs.a.included = false;
  const duration = m.compileTimeline(terminal).duration;
  const final = m.evaluateProjectAtTime(terminal, duration);
  assert.deepEqual(final.camera, terminal.views.at(-1).camera);
  assert.ok(!final.layers.some((layer) => layer.id === 'a'));

  const consecutive = fixture();
  consecutive.views[0].holdDuration = 0;
  consecutive.views[1].holdDuration = 0;
  consecutive.views[2].holdDuration = 0;
  consecutive.views[3].holdDuration = 2;
  assert.equal(
    m.compileTimeline(consecutive).duration,
    consecutive.transitions.reduce((sum, transition) => sum + transition.duration, 0) + 2,
  );
}

// Timeline geometry/model stress and deterministic fixed-seed randomized state machine.
{
  const stress = m.createProject('Twenty Views');
  stress.layers = [makeLayer('a')];
  stress.views = Array.from({ length: 20 }, (_, index) => {
    const view = m.createView(`V${index}`, index % 2 ? stress.layers : [], { x: index, y: -index, zoom: 1 }, stress.layers);
    view.id = `stress-v${index}`;
    view.holdDuration = [0, 0.1, 20][index % 3];
    return view;
  });
  stress.transitions = stress.views.slice(0, -1).map((view, index) => {
    const transition = m.createTransition(view.id, stress.views[index + 1].id, stress.layers);
    transition.id = `stress-t${index}`;
    transition.duration = [0.1, 10][index % 2];
    return transition;
  });
  const compiled = m.compileTimeline(stress);
  assert.ok(compiled.duration > 0 && Number.isFinite(compiled.duration));
  for (let index = 1; index < compiled.segments.length; index += 1)
    assert.equal(compiled.segments[index].start, compiled.segments[index - 1].end);
  assertProjectInvariants(stress);

  let project = fixture();
  const state = editor();
  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let operation = 0; operation < 500; operation += 1) {
    const action = Math.floor(random() * 9);
    const layer = project.layers[Math.floor(random() * project.layers.length)];
    const view = project.views[Math.floor(random() * project.views.length)];
    const transition = project.transitions[Math.floor(random() * project.transitions.length)];
    if (action === 0) state.selectedTimelineEntity = { kind: 'view', id: view.id };
    else if (action === 1) state.selectedTimelineEntity = { kind: 'transition', id: transition.id };
    else if (action === 2) state.selectedTimelineEntity = null;
    else if (action === 3)
      project = m.setViewLayerIncluded(project, view.id, layer.id, random() > 0.5);
    else if (action === 4)
      project = m.setTransitionLayerIncluded(project, transition.id, layer.id, random() > 0.5);
    else if (action === 5)
      project = { ...project, views: project.views.map((item) => item.id === view.id ? { ...item, holdDuration: Math.round(random() * 20) / 10 } : item) };
    else if (action === 6)
      project = { ...project, transitions: project.transitions.map((item) => item.id === transition.id ? { ...item, duration: Math.max(0.1, Math.round(random() * 50) / 10) } : item) };
    else if (action === 7)
      project = { ...project, layers: project.layers.map((item) => item.id === layer.id ? { ...item, color: `#${Math.floor(random() * 0xffffff).toString(16).padStart(6, '0')}` } : item) };
    else {
      const hidden = new Set(state.eyeHiddenLayerIds);
      if (hidden.has(layer.id)) hidden.delete(layer.id); else hidden.add(layer.id);
      state.eyeHiddenLayerIds = hidden;
    }
    assertProjectInvariants(project, state);
    assert.equal(m.isMapMode(state.playbackState, state.selectedTimelineEntity), state.selectedTimelineEntity === null);
    assert.doesNotThrow(() => m.evaluateProjectAtTime(project, random() * m.compileTimeline(project).duration));
  }
}

// Preview and frame-export paths must retain the single evaluator dependency.
{
  let seed = 0x0badc0de;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 0x100000000;
  };
  for (let trial = 0; trial < 80; trial += 1) {
    const project = fixture();
    project.views[1].holdDuration = 0;
    for (const entity of [project.transitions[0], project.views[1], project.transitions[1]])
      for (const layer of project.layers) entity.layerConfigs[layer.id].included = random() > 0.5;
    const changed = structuredClone(project);
    for (const layer of changed.layers) {
      changed.views[1].layerConfigs[layer.id] = {
        included: random() > 0.5,
        animation: {
          appearEnabled: random() > 0.5,
          appearType: ['fade', 'pop', 'drop'][Math.floor(random() * 3)],
          appearDelay: random() * 10,
          appearDuration: 0.05 + random() * 4,
          layerHoldDuration: random() * 3,
          wipeEnabled: random() > 0.5,
          wipeDuration: 0.05 + random() * 4,
        },
      };
    }
    const duration = m.compileTimeline(project).duration;
    const samples = Array.from({ length: 40 }, (_, index) => (duration * index) / 39);
    assert.deepEqual(
      samples.map((time) => m.evaluateProjectAtTime(changed, time)),
      samples.map((time) => m.evaluateProjectAtTime(project, time)),
      `random zero-Hold differential trial ${trial}`,
    );
  }
}

// Invalid direct timing input cannot introduce NaN/Infinity into compilation or evaluation.
{
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -10]) {
    const project = fixture();
    project.views[1].holdDuration = invalid;
    project.transitions[1].duration = invalid;
    const sequence = m.compileTimeline(project);
    assert.ok(Number.isFinite(sequence.duration) && sequence.duration >= 0);
    for (const time of [0, sequence.duration / 2, sequence.duration]) {
      const state = m.evaluateProjectAtTime(project, time);
      assert.ok(Object.values(state.camera).every(Number.isFinite));
      assert.ok(state.layers.every((layer) => Number.isFinite(layer.opacity)));
    }
  }
}

// Preview and frame-export paths must retain the single evaluator dependency.
{
  const frameRenderer = readFileSync(join(root, 'src/core/frameRenderer.tsx'), 'utf8');
  assert.match(frameRenderer, /evaluateProjectAtTime\((?:this\.)?project, time\)/);
  assert.ok(!frameRenderer.includes('viewLayersOf('), 'frame renderer does not bypass temporal evaluation');
}

console.log('Milestone 4 deep audit: mutation matrix, structural sharing, rapid state changes, mode capabilities, Eye/membership truth table, add/delete/duplicate, persistence, exhaustive zero-Hold, 20-View timeline, and 500 fixed-seed operations passed.');
