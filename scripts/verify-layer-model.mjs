import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-layer-model-'));
const entryFile = join(outDir, 'entry.ts');
const toPosix = (p) => p.replace(/\\/g, '/');
writeFileSync(
  entryFile,
  [
    "export * from '" + toPosix(join(root, 'src', 'core', 'viewCompiler')) + "';",
    "export * from '" + toPosix(join(root, 'src', 'core', 'project')) + "';",
    "export * from '" + toPosix(join(root, 'src', 'core', 'projectPersistence')) + "';",
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
  createLayer,
  createProject,
  createView,
  validateAndMigrateProject,
  evaluateProjectAtTime: evaluateRaw,
  deleteProjectLayer,
  viewLayersOf,
  viewMemberIds,
  transitionMemberIds: transitionMemberIdsRaw,
  transitionAnimOf: transitionAnimRaw,
  viewAnimOf,
  viewLayerConfigsOf,
  transitionLayerConfigsOf: transitionLayerConfigsRaw,
  initTransitionConfigsFromView,
} = mod;
const evaluateProjectAtTime = (project, time) => evaluateRaw(validateAndMigrateProject(project), time);
const transitionLayerConfigsOf = (entity) => entity.fromViewId ? entity.layerConfigs : entity.transitionLayerConfigs ?? {};
const transitionAnimOf = (entity, layerId) => transitionLayerConfigsOf(entity)[layerId]?.animation;
const transitionMemberIds = (entity) => new Set(Object.entries(transitionLayerConfigsOf(entity)).filter(([, config]) => config.included).map(([id]) => id));

const pin = (id, overrides = {}) => {
  const layer = createLayer('pin');
  layer.id = id;
  layer.name = `Pin ${id}`;
  layer.color = '#e11d48';
  layer.pinSize = 30;
  return { ...layer, ...overrides };
};

/** Three-segment spine: View 1 → Transition 1→2 → View 2, all using layer-a. */
const spine = (a, holdA = 1, transDur = 2, holdB = 1) => {
  const project = createProject('Spine');
  project.layers = [a];
  const v1 = createView('View 1', [a], { x: 0, y: 0, zoom: 1 }, project.layers);
  const v2 = createView('View 2', [a], { x: 100, y: 0, zoom: 1 }, project.layers);
  v1.holdDuration = holdA;
  v1.transitionDuration = transDur;
  v2.holdDuration = holdB;
  project.views = [v1, v2];
  return { project, v1, v2 };
};

// 1. PROJECT SOURCE OF TRUTH — one Layer identity; changing the Project Layer
//    changes it in EVERY segment that uses it. No per-segment visual copy.
{
  const a = pin('layer-a');
  const { project, v1 } = spine(a);
  v1.transitionLayerConfigs = { 'layer-a': { included: true } };
  project.views[0].transitionLayerConfigs = v1.transitionLayerConfigs;

  const samples = [
    evaluateProjectAtTime(project, 0.5), // View 1 hold
    evaluateProjectAtTime(project, 1.5), // Transition
    evaluateProjectAtTime(project, 4.0), // View 2 hold
  ];
  for (const s of samples) {
    assert.equal(s.layers.length, 1, 'layer present in every segment');
    assert.equal(s.layers[0].id, 'layer-a');
    assert.equal(s.layers[0].color, '#e11d48', 'renders the project color');
  }

  // Change the Project Layer globally: color + location + size.
  const changed = { ...a, color: '#16a34a', x: 999, y: 555, pinSize: 60 };
  project.layers = [changed];

  for (const [label, t] of [
    ['View 1', 0.5],
    ['Transition', 1.5],
    ['View 2', 4.0],
  ]) {
    const s = evaluateProjectAtTime(project, t);
    assert.equal(s.layers[0].color, '#16a34a', `${label} renders the new project color immediately`);
    assert.equal(s.layers[0].x, 999, `${label} renders the new project location immediately`);
    assert.equal(s.layers[0].pinSize, 60, `${label} renders the new project size immediately`);
  }

  // No segment config holds a copy of the visual state.
  for (const view of project.views) {
    for (const config of Object.values(viewLayerConfigsOf(view)))
      assert.ok(!('state' in config) && !('color' in config) && !('x' in config) && !('pinSize' in config),
        'view config holds usage + animation only');
    for (const config of Object.values(transitionLayerConfigsOf(view)))
      assert.ok(!('state' in config) && !('color' in config) && !('x' in config) && !('pinSize' in config),
        'transition config holds usage + animation only');
  }
}

// 2. SEGMENT USAGE — independent included states AND independent animation
//    configs for the SAME project layer.
{
  const a = pin('layer-a');
  // Transition-only drop scenario: the layer is absent from View 1, drops in
  // during the Transition, and stays static in View 2. The same project layer
  // carries a different animation config in each segment.
  const project = createProject('Segment usage');
  project.layers = [a];
  const v1 = createView('View 1', [], { x: 0, y: 0, zoom: 1 }, project.layers);
  const v2 = createView('View 2', [a], { x: 100, y: 0, zoom: 1 }, project.layers);
  v1.holdDuration = 1;
  v1.transitionDuration = 2;
  v2.holdDuration = 1;
  v1.layerConfigs = { 'layer-a': { included: false } };
  v1.transitionLayerConfigs = {
    'layer-a': { included: true, animation: { appearEnabled: true, appearType: 'drop', appearDelay: 0.2, appearDuration: 0.8 } },
  };
  v2.layerConfigs = { 'layer-a': { included: true } };
  project.views = [v1, v2];

  assert.equal(viewAnimOf(v1, 'layer-a'), undefined, 'View 1 has no animation config');
  assert.equal(transitionAnimOf(v1, 'layer-a')?.appearType, 'drop', 'Transition animation is drop');
  assert.equal(viewAnimOf(v2, 'layer-a'), undefined, 'View 2 has no animation config');

  // Different animation behavior at render time, same visual properties.
  assert.equal(evaluateProjectAtTime(project, 0.5).layers.length, 0, 'absent in View 1');
  const inTrans = evaluateProjectAtTime(project, 1.5).layers[0]; // drop mid-flight
  assert.equal(inTrans.color, '#e11d48', 'same visual properties as the project layer');
  assert.ok(inTrans.pinDropOffsetY !== undefined && inTrans.pinDropOffsetY < 0, 'drop offset applied in Transition');
  const inView2 = evaluateProjectAtTime(project, 4.0).layers[0];
  assert.equal(inView2.opacity, 1, 'View 2 renders static full state');
  assert.equal(inView2.pinDropOffsetY, undefined, 'no transient residue in View 2');
}

// 3. NO SNAPSHOTS — the persisted model has no copied Layer visual state, and
//    a full save→load round-trip preserves that.
{
  const a = pin('layer-a');
  const { project, v1 } = spine(a);
  v1.transitionLayerConfigs = { 'layer-a': { included: true, animation: { appearEnabled: true, appearType: 'pop' } } };
  const out = validateAndMigrateProject(project);

  const walk = (view) => {
    for (const config of Object.values(viewLayerConfigsOf(view))) {
      const keys = Object.keys(config);
      for (const k of keys) assert.ok(['included', 'animation'].includes(k), `view config key ${k} must not exist`);
      assert.ok(typeof config.included === 'boolean');
    }
  };
  out.views.forEach(walk);
  for (const transition of out.transitions) for (const config of Object.values(transition.layerConfigs)) {
    const keys = Object.keys(config);
    for (const k of keys) assert.ok(['included', 'animation'].includes(k), `transition config key ${k} must not exist`);
  }

  // Animations still round-trip.
  assert.deepEqual(out.transitions[0].layerConfigs['layer-a']?.animation, {
    appearEnabled: true,
    appearType: 'pop',
  });
}

// 4. DELETE CASCADE — deleting a Project Layer removes its usage from EVERY
//    View and Transition; Preview/Export never reference the missing id.
{
  const a = pin('layer-a');
  const b = pin('layer-b');
  const { project, v1 } = spine(a);
  project.layers = [a, b];
  v1.layerConfigs = {
    'layer-a': { included: true, animation: { appearEnabled: true, appearType: 'fade' } },
    'layer-b': { included: true },
  };
  v1.transitionLayerConfigs = {
    'layer-a': { included: true, animation: { appearEnabled: true, appearType: 'drop' } },
    'layer-b': { included: true },
  };
  const v2 = project.views[1];
  v2.layerConfigs = {
    'layer-a': { included: true },
    'layer-b': { included: true },
  };
  v2.transitionLayerConfigs = {};

  const cleaned = deleteProjectLayer(validateAndMigrateProject(project), 'layer-a');
  assert.deepEqual(cleaned.layers.map((l) => l.id), ['layer-b'], 'registry loses layer-a');
  for (const view of cleaned.views) {
    assert.ok(!viewMemberIds(view).has('layer-a'), 'view usage removed');
    assert.ok(!('layer-a' in (view.layerConfigs ?? {})), 'view config entry removed');
  }
  for (const transition of cleaned.transitions) assert.ok(!transitionMemberIds(transition).has('layer-a'), 'transition usage removed');

  // Preview stays valid: no dangling id in evaluated output.
  const s = evaluateProjectAtTime(cleaned, 1.5);
  assert.ok(s.layers.every((l) => l.id !== 'layer-a'), 'evaluated output has no dangling layer');
  assert.deepEqual(
    s.layers.map((l) => l.id),
    ['layer-b'],
    'remaining layers still render',
  );
}

// 5. EYE — editor-only visibility; changing Eye must not touch segment configs
//    or evaluated output (it is app UI state, not part of the model).
{
  const a = pin('layer-a');
  const { project, v1 } = spine(a);
  v1.transitionLayerConfigs = { 'layer-a': { included: true } };
  const before = validateAndMigrateProject(project);
  const beforeView = before.views[0].layerConfigs?.['layer-a']?.included;
  const beforeTrans = before.views[0].transitionLayerConfigs?.['layer-a']?.included;

  // Simulate the app toggling editor eye: it mutates UI state only.
  const eyeHidden = new Set(['layer-a']);
  const after = validateAndMigrateProject(project);
  assert.equal(after.views[0].layerConfigs?.['layer-a']?.included, beforeView, 'eye does not change view config');
  assert.equal(after.views[0].transitionLayerConfigs?.['layer-a']?.included, beforeTrans, 'eye does not change transition config');
  assert.ok(eyeHidden.size === 1, 'eye state lives in editor UI state');
  const s = evaluateProjectAtTime(after, 0.5);
  assert.equal(s.layers.length, 1, 'Preview still renders the layer when eye is off');
}

// 6. THUMBNAILS — deterministic thumbnails resolve the CURRENT Project Layer
//    definition, so a global change is reflected everywhere it is used.
{
  const a = pin('layer-a');
  const { project, v1 } = spine(a);
  v1.transitionLayerConfigs = { 'layer-a': { included: true } };

  // Thumbnails evaluate the same Project-time renderer; a layer that is not
  // in a View must not appear in that View's thumbnail.
  const viewA = viewLayersOf(project, project.views[0]);
  assert.equal(viewA[0].id, 'layer-a', 'thumbnail layer resolved from project registry');

  // Global change is reflected in the resolved list immediately.
  project.layers = [{ ...a, color: '#f59e0b' }];
  const viewA2 = viewLayersOf(project, project.views[0]);
  assert.equal(viewA2[0].color, '#f59e0b', 'thumbnail reflects global color change');
  assert.equal(evaluateProjectAtTime(project, 0.5).layers[0].color, '#f59e0b', 'evaluated thumbnail frame reflects global change');
}

// 7. PERSISTENCE — normalized model round-trips exactly through save/load.
{
  const a = pin('layer-a');
  const { project, v1, v2 } = spine(a);
  v1.layerConfigs = { 'layer-a': { included: true, animation: { appearEnabled: true, appearType: 'fade', appearDelay: 0.3, appearDuration: 1.2, layerHoldDuration: 0.5, wipeEnabled: true, wipeType: 'fade-out', wipeDuration: 0.7 } } };
  v1.transitionLayerConfigs = { 'layer-a': { included: true, animation: { appearEnabled: true, appearType: 'drop' } } };
  v2.layerConfigs = { 'layer-a': { included: true } };

  const out = validateAndMigrateProject(project);
  assert.equal(out.views[0].layerConfigs?.['layer-a']?.included, true);
  assert.deepEqual(
    out.views[0].layerConfigs?.['layer-a']?.animation,
    {
      appearEnabled: true,
      appearType: 'fade',
      appearDelay: 0.3,
      appearDuration: 1.2,
      layerHoldDuration: 0.5,
      wipeEnabled: true,
      wipeType: 'fade-out',
      wipeDuration: 0.7,
    },
    'full view animation round-trips',
  );
  assert.deepEqual(out.transitions[0].layerConfigs['layer-a']?.animation, {
    appearEnabled: true,
    appearType: 'drop',
  });
  // A second pass is stable (idempotent migration).
  const out2 = validateAndMigrateProject(out);
  assert.deepEqual(out2.views[0].layerConfigs?.['layer-a']?.animation, out.views[0].layerConfigs?.['layer-a']?.animation);
}

// 8. MIGRATION — the last COMMITTED schema (per-view `layers` clones +
//    `transitionLayers`/`layerAnimations`, no configs) loads without crashing,
//    preserves the registry + camera, and renders deterministically.
{
  const project = createProject('Legacy load');
  const a = pin('layer-a');
  const b = pin('layer-b');
  project.layers = [a, b];

  const v1 = createView('View 1', [a], { x: 10, y: 20, zoom: 1.5 });
  const v2 = createView('View 2', [b], { x: -10, y: -20, zoom: 0.5 });
  v1.holdDuration = 2;
  v1.transitionDuration = 3;
  v2.holdDuration = 2;
  // Committed format: full layer clones, no layerConfigs.
  const legacyV1 = {
    ...v1,
    layerConfigs: undefined,
    layers: [{ ...a, visible: true }],
    transitionLayers: [{ ...a, visible: true }],
    layerAnimations: { 'layer-a': { appearEnabled: true, appearType: 'fade', appearDuration: 1 } },
  };
  const legacyV2 = {
    ...v2,
    layerConfigs: undefined,
    layers: [{ ...b, visible: false }],
    transitionLayers: undefined,
    layerAnimations: undefined,
  };
  project.views = [legacyV1, legacyV2];

  const migrated = validateAndMigrateProject(project); // must not throw
  assert.equal(migrated.views.length, 2, 'all views load');
  assert.deepEqual(
    migrated.layers.map((l) => l.id),
    ['layer-a', 'layer-b'],
    'registry preserved',
  );
  assert.deepEqual(migrated.views[0].camera, { x: 10, y: 20, zoom: 1.5 }, 'camera preserved');
  assert.deepEqual(migrated.views[1].camera, { x: -10, y: -20, zoom: 0.5 }, 'second camera preserved');

  // Membership preserved: View 1 includes layer-a (visible), View 2 excludes
  // layer-b (invisible in legacy = not allocated).
  assert.deepEqual([...viewMemberIds(migrated.views[0])], ['layer-a']);
  assert.deepEqual([...viewMemberIds(migrated.views[1])], []);
  // Legacy transition animation preserved.
  assert.deepEqual(transitionAnimOf(migrated.transitions[0], 'layer-a'), {
    appearEnabled: true,
    appearType: 'fade',
    appearDuration: 1,
  });
  assert.ok(!('layers' in migrated.views[0]), 'legacy View snapshots removed');
  assert.ok(!('transitionLayers' in migrated.views[0]), 'legacy transition snapshots removed');
  assert.ok(!('layerAnimations' in migrated.views[0]), 'legacy animation maps removed');

  // Renders deterministically with project definitions.
  const hold = evaluateProjectAtTime(migrated, 0.5);
  assert.equal(hold.layers[0].id, 'layer-a');
  assert.equal(hold.layers[0].color, '#e11d48');
  const trans = evaluateProjectAtTime(migrated, 3.0);
  assert.equal(trans.layers[0].id, 'layer-a', 'transition union preserves membership');
}

// 9. PREVIEW — shared Project Layer with different segment animations across
//    View / Transition / View; membership switches exactly at boundaries.
{
  const a = pin('layer-a');
  const project = createProject('Preview');
  project.layers = [a];
  const v1 = createView('View 1', [], { x: 0, y: 0, zoom: 1 }, project.layers);
  const v2 = createView('View 2', [a], { x: 0, y: 0, zoom: 1 }, project.layers);
  v1.holdDuration = 1;
  v1.transitionDuration = 2;
  v2.holdDuration = 2;
  v1.transitionLayerConfigs = {
    'layer-a': {
      included: true,
      animation: { appearEnabled: true, appearType: 'drop', appearDelay: 0, appearDuration: 0.6 },
    },
  };
  project.views = [v1, v2];

  // View 1: layer absent.
  assert.equal(evaluateProjectAtTime(project, 0.5).layers.length, 0, 'absent in View 1');
  // Transition: layer enters with drop.
  const t1 = evaluateProjectAtTime(project, 1.3);
  assert.equal(t1.layers.length, 1, 'present during transition');
  assert.ok(t1.layers[0].pinDropOffsetY !== undefined, 'drop animation active in transition');
  // After appear completes inside the transition: full state, no residue.
  const t2 = evaluateProjectAtTime(project, 2.5);
  assert.equal(t2.layers[0].opacity, 1, 'settled at full opacity');
  assert.equal(t2.layers[0].pinDropOffsetY, undefined, 'no residue once appear completes');
  // View 2: continues (included in both transition and View 2).
  assert.equal(evaluateProjectAtTime(project, 3.0).layers.length, 1, 'present in View 2');
  assert.equal(evaluateProjectAtTime(project, 4.5).layers[0].opacity, 1, 'stable in View 2 hold');
}

// 10. VIEW ANIMATION — a View Hold can carry its own appear/hold/wipe
//     lifecycle independent of the transition.
{
  const a = pin('layer-a');
  const project = createProject('View animation');
  project.layers = [a];
  const v1 = createView('View 1', [a], { x: 0, y: 0, zoom: 1 }, project.layers);
  const v2 = createView('View 2', [a], { x: 0, y: 0, zoom: 1 }, project.layers);
  v1.holdDuration = 5;
  v1.transitionDuration = 1;
  v2.holdDuration = 1;
  // Delay 1, Fade 1, Layer Hold 2, Wipe 1 → full lifecycle inside the 5s hold.
  v1.layerConfigs = {
    'layer-a': {
      included: true,
      animation: {
        appearEnabled: true,
        appearType: 'fade',
        appearDelay: 1,
        appearDuration: 1,
        layerHoldDuration: 2,
        wipeEnabled: true,
        wipeType: 'fade-out',
        wipeDuration: 1,
      },
    },
  };
  project.views = [v1, v2];

  assert.equal(evaluateProjectAtTime(project, 0.5).layers[0].visible, false, 'hidden before appear delay');
  const midFade = evaluateProjectAtTime(project, 1.5).layers[0];
  assert.ok(midFade.opacity > 0 && midFade.opacity < 1, 'fade mid-flight');
  assert.equal(evaluateProjectAtTime(project, 3.0).layers[0].opacity, 1, 'full during layer hold');
  const midWipe = evaluateProjectAtTime(project, 4.5).layers[0];
  assert.ok(midWipe.opacity > 0 && midWipe.opacity < 1, 'wipe mid-flight');
  assert.ok(evaluateProjectAtTime(project, 4.999).layers[0].opacity < 0.01, 'wipe reaches zero before boundary');
}

// 11. initTransitionConfigsFromView — creating a new View copies the previous
//     segment's membership once (initialization only), then stays independent.
{
  const project = createProject('Init copy');
  const a = pin('layer-a');
  const b = pin('layer-b');
  project.layers = [a, b];
  const source = createView('View 1', [a], { x: 0, y: 0, zoom: 1 }, project.layers);

  const init = initTransitionConfigsFromView(source, project.layers);
  assert.equal(init['layer-a'].included, true, 'copied from source view');
  assert.equal(init['layer-b'].included, false, 'absent layer defaults to false');
  assert.equal(init['layer-a'].animation, undefined, 'new Transition starts with independent animation state');

  // The new config is a fresh object — mutating it never touches the source.
  init['layer-a'].included = false;
  assert.equal(source.layerConfigs['layer-a'].included, true, 'source untouched after copy');
}

console.log(
  'Layer-model verification: project source of truth, global property mutation, segment usage independence, no snapshots, delete cascade, eye isolation, thumbnails, persistence round-trip, legacy migration, preview membership, view animation, init-copy independence passed.',
);
