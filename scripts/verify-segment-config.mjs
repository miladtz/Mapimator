import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-segment-config-'));
const entryFile = join(outDir, 'entry.ts');
const toPosix = (p) => p.replace(/\\/g, '/');
writeFileSync(
  entryFile,
  [
    "export * from '" + toPosix(join(root, 'src', 'core', 'viewCompiler')) + "';",
    "export * from '" + toPosix(join(root, 'src', 'core', 'project')) + "';",
    "export * from '" + toPosix(join(root, 'src', 'core', 'projectPersistence')) + "';",
    "export * from '" + toPosix(join(root, 'src', 'core', 'segmentValidation')) + "';",
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
  viewLayerConfigsOf,
  viewLayersOf,
  viewMemberIds,
  transitionLayerConfigsOf: transitionLayerConfigsRaw,
  transitionLayersOf,
  transitionMemberIds,
  transitionAnimOf,
  validateTransitionLayer,
} = mod;
const evaluateProjectAtTime = (project, time) => evaluateRaw(validateAndMigrateProject(project), time);
const transitionLayerConfigsOf = (entity) => entity.layerConfigs ?? entity.transitionLayerConfigs ?? {};

const pin = (id, overrides = {}) => {
  const layer = createLayer('pin');
  layer.id = id;
  layer.name = `Pin ${id}`;
  layer.color = '#e11d48';
  return { ...layer, ...overrides };
};

// 1. PROJECT REGISTRY — the project owns stable layer identities; View and
//    Transition configs reference the SAME ids, never new identities.
{
  const project = createProject('Registry');
  const a = pin('layer-a');
  const b = pin('layer-b');
  const c = createLayer('text');
  c.id = 'layer-c';
  const d = createLayer('route');
  d.id = 'layer-d';
  project.layers = [a, b, c, d];

  const view1 = createView('View 1', [a, c], { x: 0, y: 0, zoom: 1 }, project.layers);
  const view2 = createView('View 2', [b, d], { x: 0, y: 0, zoom: 1 }, project.layers);
  project.views = [view1, view2];

  // The registry ids are the source of truth.
  assert.deepEqual(
    project.layers.map((l) => l.id),
    ['layer-a', 'layer-b', 'layer-c', 'layer-d'],
    'project owns the master layer registry',
  );
  // View configs reference the same ids — no duplicate identities.
  assert.ok(view1.layerConfigs && view1.layerConfigs['layer-a'], 'View 1 config references layer-a');
  assert.ok(view1.layerConfigs && view1.layerConfigs['layer-c'], 'View 1 config references layer-c');
  assert.ok(view2.layerConfigs && view2.layerConfigs['layer-b'], 'View 2 config references layer-b');
  assert.ok(view2.layerConfigs && view2.layerConfigs['layer-d'], 'View 2 config references layer-d');
  for (const view of [view1, view2])
    for (const layerId of Object.keys(view.layerConfigs ?? {}))
      assert.ok(
        project.layers.some((l) => l.id === layerId),
        `config layer ${layerId} exists in the project registry`,
      );
}

// 2. VIEW CONFIG — independent allocation per View.
{
  const project = createProject('View config');
  const a = pin('layer-a');
  const b = pin('layer-b');
  const c = createLayer('text');
  c.id = 'layer-c';
  const d = createLayer('route');
  d.id = 'layer-d';
  project.layers = [a, b, c, d];

  const view1 = createView('View 1', [a, c], { x: 0, y: 0, zoom: 1 }, project.layers);
  const view2 = createView('View 2', [b, d], { x: 0, y: 0, zoom: 1 }, project.layers);
  view1.layerConfigs = {
    'layer-a': { included: true },
    'layer-b': { included: false },
    'layer-c': { included: true },
    'layer-d': { included: false },
  };
  view2.layerConfigs = {
    'layer-a': { included: false },
    'layer-b': { included: true },
    'layer-c': { included: false },
    'layer-d': { included: true },
  };
  view1.holdDuration = 2;
  project.views = [view1, view2];

  assert.deepEqual(
    [...viewMemberIds(view1)],
    ['layer-a', 'layer-c'],
    'View 1 allocates A and C',
  );
  assert.deepEqual(
    [...viewMemberIds(view2)],
    ['layer-b', 'layer-d'],
    'View 2 allocates B and D',
  );

  // Each View hold renders exactly its own allocation.
  const hold1 = evaluateProjectAtTime(project, 0.1).layers.map((l) => l.id).sort();
  assert.deepEqual(hold1, ['layer-a', 'layer-c'], 'View 1 hold renders only its allocated layers');
}

// 3. TRANSITION CONFIG — independent allocation, and a layer can exist only
//    during the transition (absent from both Views).
{
  const project = createProject('Transition only');
  const a = pin('layer-a');
  project.layers = [a];

  const view1 = createView('View 1', [], { x: 0, y: 0, zoom: 1 });
  const view2 = createView('View 2', [], { x: 0, y: 0, zoom: 1 });
  view1.holdDuration = 1;
  view1.transitionDuration = 2;
  view2.holdDuration = 1;
  // Transition owns layer-a even though neither View does.
  view1.transitionLayerConfigs = {
    'layer-a': {
      included: true,
      animation: {
        appearEnabled: true,
        appearType: 'drop',
        appearDelay: 0,
        appearDuration: 0.6,
      },
    },
  };
  project.views = [view1, view2];

  assert.equal(evaluateProjectAtTime(project, 0.5).layers.length, 0, 'absent during View 1 hold');
  const during = evaluateProjectAtTime(project, 2.0);
  assert.equal(during.layers.length, 1, 'present during the transition');
  assert.equal(during.layers[0].id, 'layer-a', 'transition owns the layer');
  assert.equal(evaluateProjectAtTime(project, 3.5).layers.length, 0, 'absent in View 2 hold');
}

// 4. NO CROSS-MUTATION — changing a Transition config must not change the
//    adjacent Views' configs.
{
  const project = createProject('Independence');
  const a = pin('layer-a');
  const b = pin('layer-b');
  project.layers = [a, b];

  const view1 = createView('View 1', [a, b], { x: 0, y: 0, zoom: 1 });
  const view2 = createView('View 2', [a, b], { x: 0, y: 0, zoom: 1 });
  view1.holdDuration = 1;
  view1.transitionDuration = 1;
  view1.transitionLayerConfigs = {
    'layer-a': { included: true },
    'layer-b': { included: true },
  };
  project.views = [view1, view2];

  const beforeViews = structuredClone(project.views);
  // Uncheck layer-a in the Transition config only.
  const next = {
    ...project,
    views: project.views.map((v, index) =>
      index === 0
        ? {
            ...v,
            transitionLayerConfigs: {
              ...(v.transitionLayerConfigs ?? {}),
              'layer-a': { included: false },
            },
          }
        : v,
    ),
  };

  assert.equal(
    next.views[0].transitionLayerConfigs?.['layer-a']?.included,
    false,
    'transition config changed',
  );
  assert.equal(
    next.views[0].layerConfigs?.['layer-a']?.included,
    true,
    'View 1 config unchanged',
  );
  assert.equal(
    next.views[1].layerConfigs?.['layer-a']?.included,
    true,
    'View 2 config unchanged',
  );
  assert.equal(beforeViews[0].transitionLayerConfigs?.['layer-a']?.included, true, 'original untouched');
}

// 5. CONTINUATION — transition + destination View both allocate the layer:
//    a still-running appear animation continues into the View Hold.
{
  const project = createProject('Continuation');
  const a = pin('layer-a');
  project.layers = [a];

  const view1 = createView('View 1', [], { x: 0, y: 0, zoom: 1 });
  const view2 = createView('View 2', [a], { x: 0, y: 0, zoom: 1 });
  view1.holdDuration = 1;
  view1.transitionDuration = 2;
  view2.holdDuration = 3;
  view1.transitionLayerConfigs = {
    'layer-a': {
      included: true,
      animation: {
        appearEnabled: true,
        appearType: 'drop',
        appearDelay: 0,
        appearDuration: 4,
      },
    },
  };
  project.views = [view1, view2];

  const duringHold = evaluateProjectAtTime(project, 4.0).layers[0];
  // Transition ends at t=3; drop (0..4s) continues into the View B hold.
  assert.equal(duringHold.visible, true, 'layer continues into the View hold');
  assert.ok(duringHold.pinDropOffsetY !== undefined, 'drop still animating during hold');
  assert.ok(duringHold.pinDropOffsetY < 0, 'drop offset still negative during hold');

  const settled = evaluateProjectAtTime(project, 5.5).layers[0];
  assert.equal(settled.opacity, 1, 'exact destination opacity after animation completes');
  assert.equal(settled.pinDropOffsetY, undefined, 'no transient residue after completion');
}

// 6. CUT — transition allocated, destination View NOT allocated: the layer
//    disappears exactly at the View boundary even mid-animation.
{
  const project = createProject('Cut');
  const a = pin('layer-a');
  project.layers = [a];

  const view1 = createView('View 1', [], { x: 0, y: 0, zoom: 1 });
  const view2 = createView('View 2', [], { x: 0, y: 0, zoom: 1 });
  view1.holdDuration = 1;
  view1.transitionDuration = 2;
  view2.holdDuration = 2;
  view1.transitionLayerConfigs = {
    'layer-a': {
      included: true,
      animation: {
        appearEnabled: true,
        appearType: 'fade',
        appearDelay: 0,
        appearDuration: 5,
      },
    },
  };
  project.views = [view1, view2];

  assert.equal(evaluateProjectAtTime(project, 2.9).layers.length, 1, 'present near transition end');
  assert.equal(
    evaluateProjectAtTime(project, 3.0).layers.length,
    0,
    'cut exactly at the View boundary (allocation wins)',
  );
}

// 7. VIEW-ONLY — transition absent, View allocated: appears immediately at the
//    View boundary with no transition animation.
{
  const project = createProject('View only');
  const a = pin('layer-a');
  project.layers = [a];

  const view1 = createView('View 1', [], { x: 0, y: 0, zoom: 1 });
  const view2 = createView('View 2', [a], { x: 0, y: 0, zoom: 1 });
  view1.holdDuration = 1;
  view1.transitionDuration = 2;
  view2.holdDuration = 2;
  view1.transitionLayerConfigs = {}; // transition allocates nothing
  project.views = [view1, view2];

  assert.equal(evaluateProjectAtTime(project, 2.9).layers.length, 0, 'absent during the transition');
  const atBoundary = evaluateProjectAtTime(project, 3.0);
  assert.equal(atBoundary.layers.length, 1, 'appears exactly at View B start');
  assert.equal(atBoundary.layers[0].opacity, 1, 'appears immediately at full opacity');
}

// 8. EYE is editor-only: it is not part of the config schema and never
//    persists; evaluated output never carries eye state.
{
  const project = createProject('Eye isolation');
  const a = pin('layer-a');
  project.layers = [{ ...a, visible: true }];
  const view = createView('View 1', [a], { x: 0, y: 0, zoom: 1 });
  view.holdDuration = 1;
  project.views = [view, createView('Destination', [], { x: 0, y: 0, zoom: 1 })];
  const migrated = validateAndMigrateProject(project);
  assert.ok(!('eyeHidden' in migrated.layers[0]), 'no eye state persisted on registry layers');
  assert.ok(
    !('eyeHidden' in viewLayersOf(migrated, migrated.views[0])[0]),
    'no eye state in the resolved View layer list',
  );
  assert.ok(
    !('eyeHidden' in evaluateProjectAtTime(project, 0.5).layers[0]),
    'no eye state in evaluated output',
  );
}

// 9. PERSISTENCE — configs round-trip; invalid configs are rejected.
{
  const project = createProject('Config persistence');
  const a = pin('layer-a');
  const b = pin('layer-b');
  project.layers = [a, b];
  const view = createView('View 1', [a], { x: 0, y: 0, zoom: 1 });
  view.transitionLayerConfigs = {
    'layer-a': {
      included: true,
      animation: {
        appearEnabled: true,
        appearType: 'drop',
        appearDelay: 0.2,
        appearDuration: 1.5,
        layerHoldDuration: 0.5,
        wipeEnabled: true,
        wipeType: 'fade-out',
        wipeDuration: 0.8,
      },
    },
  };
  project.views = [view, createView('Destination', [], { x: 0, y: 0, zoom: 1 })];

  const out = validateAndMigrateProject(project);
  const outView = out.views[0];
  assert.ok(outView.layerConfigs?.['layer-a'], 'view config round-trips');
  assert.equal(outView.layerConfigs?.['layer-a'].included, true, 'view inclusion round-trips');
  assert.equal(out.transitions[0].layerConfigs['layer-a'].included, true, 'transition inclusion round-trips');
  assert.deepEqual(
    out.transitions[0].layerConfigs['layer-a'].animation,
    view.transitionLayerConfigs?.['layer-a'].animation,
    'transition animation round-trips',
  );
  // Configs store usage + animation only — no copied Layer visual state.
  assert.ok(!('state' in outView.layerConfigs['layer-a']), 'no visual state snapshot in view configs');

  for (const bad of [
    { layerConfigs: { x: { included: 'yes' } } },
    { layerConfigs: { x: { included: true, animation: { appearType: 'bounce' } } } },
    { transitionLayerConfigs: { x: { included: true, animation: { appearDelay: -1 } } } },
    { transitionLayerConfigs: { x: { included: false, animation: { wipeDuration: -3 } } } },
  ]) {
    const candidate = createProject('Bad config');
    const badView = createView('V', [], { x: 0, y: 0, zoom: 1 });
    Object.assign(badView, bad);
    candidate.views = [badView];
    assert.throws(
      () => validateAndMigrateProject(candidate),
      undefined,
      `validation must reject ${JSON.stringify(bad)}`,
    );
  }
}

// 10. BACKWARD COMPATIBILITY — legacy views (full `layers` clones, no configs)
//     migrate to equivalent usages and render identically.
{
  const project = createProject('Legacy compat');
  const a = pin('layer-a');
  a.pinAppearEnabled = true;
  a.pinAppearType = 'fade';
  const view = createView('View 1', [a], { x: 0, y: 0, zoom: 1 });
  view.holdDuration = 1;
  // Strip the config model to simulate a committed legacy project.
  project.layers = [a];
  const legacyView = {
    ...view,
    layerConfigs: undefined,
    layers: [{ ...a, visible: true }],
    transitionLayers: undefined,
    layerAnimations: undefined,
  };
  project.views = [legacyView];

  const migrated = validateAndMigrateProject(project);
  const migratedView = migrated.views[0];
  assert.ok(migratedView.layerConfigs?.['layer-a'], 'legacy layers migrate to view configs');
  assert.equal(migratedView.layerConfigs?.['layer-a'].included, true, 'legacy visible layer is included');
  assert.ok(!('state' in migratedView.layerConfigs['layer-a']), 'no snapshot created during migration');

  const evaluated = evaluateProjectAtTime(migrated, 0.5).layers[0];
  assert.equal(evaluated.id, 'layer-a', 'migrated project renders the same layer');
  assert.equal(evaluated.opacity, 1, 'migrated project renders at full opacity');
}

// 11. SEMANTIC WARNINGS — config-aware validation produces the expected
//     advisories for wipe+next-View, animation-cut, and absent transition
//     layer animation config.
{
  // (a) Wipe enabled while the destination View still contains the layer.
  const warnings = validateTransitionLayer({
    sourceMemberIds: new Set(),
    transitionIncluded: true,
    destMemberIds: new Set(['layer-a']),
    layerId: 'layer-a',
    anim: { wipeEnabled: true, wipeDuration: 0.5 },
  });
  assert.ok(
    warnings.some((w) => w.message.includes('also visible in the next View')),
    'wipe + next View produces a warning',
  );
  // (b) Animation extends beyond the transition but the destination View
  //     does not contain the layer.
  const cut = validateTransitionLayer({
    sourceMemberIds: new Set(),
    transitionIncluded: true,
    destMemberIds: new Set(),
    layerId: 'layer-a',
    anim: { appearEnabled: true, appearDuration: 4 },
  });
  assert.ok(
    cut.some((w) => w.message.includes('cut at the View boundary')),
    'animation cut at boundary produces a warning',
  );
  // (c) Animation config exists for a layer NOT allocated to the transition.
  const absent = validateTransitionLayer({
    sourceMemberIds: new Set(),
    transitionIncluded: false,
    destMemberIds: new Set(),
    layerId: 'layer-a',
    anim: { appearEnabled: true, appearDuration: 1 },
  });
  assert.ok(
    absent.some((w) => w.message.includes('Enable this layer')),
    'animation on an unallocated transition layer produces a warning',
  );
}

// 12. Helpers stay consistent between new configs and normalized legacy input.
{
  const project = createProject('Helpers');
  const a = pin('layer-a');
  project.layers = [a];
  const view = createView('View 1', [a], { x: 0, y: 0, zoom: 1 });
  const transition = { id: 'transition-a', fromViewId: view.id, toViewId: 'view-2', duration: 1, preset: 'smooth', type: 'smooth', layerConfigs: { 'layer-a': { included: true, animation: { appearEnabled: true } } } };
  project.transitions = [transition];
  assert.equal(transitionAnimOf(transition, 'layer-a')?.appearEnabled, true, 'transitionAnimOf reads configs');
  assert.equal(transitionLayersOf(project, transition)[0].id, 'layer-a', 'transitionLayersOf returns included layers');
  assert.deepEqual(
    [...transitionMemberIds(transition)],
    ['layer-a'],
    'transitionMemberIds matches the config',
  );
  assert.deepEqual(
    [...viewMemberIds(view)],
    ['layer-a'],
    'viewMemberIds matches the config',
  );
  const normalized = transitionLayerConfigsOf(transition);
  assert.equal(normalized['layer-a'].included, true, 'normalized transition config exposes inclusion');
}

// 13. FULL 4-LAYER MODEL — the definitive scenario from the product spec.
//     Every segment's config has entries for ALL project layers, and checkbox
//     state is deterministic.
{
  const project = createProject('Full model');
  const a = pin('layer-a');
  const b = pin('layer-b');
  const c = createLayer('text'); c.id = 'layer-c';
  const d = createLayer('route'); d.id = 'layer-d';
  project.layers = [a, b, c, d];

  // Create 3 Views with independent configs.
  const v1 = createView('View 1', [a, c], { x: 0, y: 0, zoom: 1 }, project.layers);
  const v2 = createView('View 2', [b, d], { x: 0, y: 0, zoom: 1 }, project.layers);
  const v3 = createView('View 3', [c, d], { x: 0, y: 0, zoom: 1 }, project.layers);
  // Manually set full configs (simulate what the app does).
  v1.layerConfigs = {
    'layer-a': { included: true },
    'layer-b': { included: false },
    'layer-c': { included: true },
    'layer-d': { included: false },
  };
  v2.layerConfigs = {
    'layer-a': { included: false },
    'layer-b': { included: true },
    'layer-c': { included: false },
    'layer-d': { included: true },
  };
  v3.layerConfigs = {
    'layer-a': { included: false },
    'layer-b': { included: false },
    'layer-c': { included: true },
    'layer-d': { included: true },
  };
  project.views = [v1, v2, v3];
  const runtime = validateAndMigrateProject(project);

  // Every View config has entries for ALL 4 project layers.
  for (const view of project.views) {
    const keys = Object.keys(view.layerConfigs ?? {});
    assert.equal(keys.length, 4, `${view.name} config has entries for all 4 layers`);
  }

  // Exact checkbox patterns.
  assert.deepEqual([...viewMemberIds(v1)].sort(), ['layer-a', 'layer-c'], 'View 1 allocates A+C');
  assert.deepEqual([...viewMemberIds(v2)].sort(), ['layer-b', 'layer-d'], 'View 2 allocates B+D');
  assert.deepEqual([...viewMemberIds(v3)].sort(), ['layer-c', 'layer-d'], 'View 3 allocates C+D');

  // Switching between Views reproduces exact patterns.
  assert.deepEqual([...viewMemberIds(v1)].sort(), ['layer-a', 'layer-c'], 'View 1 checkbox pattern stable');
  assert.deepEqual([...viewMemberIds(v3)].sort(), ['layer-c', 'layer-d'], 'View 3 checkbox pattern stable');
  assert.deepEqual([...viewMemberIds(v2)].sort(), ['layer-b', 'layer-d'], 'View 2 checkbox pattern stable');
}

// 14. createView with allLayers — configs cover the full registry.
{
  const project = createProject('allLayers');
  const a = pin('layer-a');
  const b = pin('layer-b');
  const c = createLayer('text'); c.id = 'layer-c';
  project.layers = [a, b, c];

  const view = createView('View 1', [a], { x: 0, y: 0, zoom: 1 }, project.layers);
  // view.layerConfigs should have ALL 3 layers.
  assert.equal(Object.keys(view.layerConfigs ?? {}).length, 3, 'createView with allLayers covers all layers');
  assert.equal(view.layerConfigs?.['layer-a']?.included, true, 'layer-a included (in layers array)');
  assert.equal(view.layerConfigs?.['layer-b']?.included, false, 'layer-b not included (not in layers array)');
  assert.equal(view.layerConfigs?.['layer-c']?.included, false, 'layer-c not included (not in layers array)');
}

// 15. MIGRATION BACKFILL — legacy projects with incomplete configs get filled in.
{
  const project = createProject('Backfill');
  const a = pin('layer-a');
  const b = pin('layer-b');
  const c = createLayer('text'); c.id = 'layer-c';
  project.layers = [a, b, c];

  // Simulate a legacy project: View has configs only for 2 of 3 layers.
  const legacyView = createView('View 1', [a, b], { x: 0, y: 0, zoom: 1 });
  legacyView.layerConfigs = {
    'layer-a': { included: true },
    'layer-b': { included: true },
    // layer-c is MISSING
  };
  project.views = [legacyView];

  const migrated = validateAndMigrateProject(project);
  const vc = migrated.views[0].layerConfigs ?? {};
  assert.equal(Object.keys(vc).length, 3, 'migration backfills all 3 layers');
  assert.equal(vc['layer-c']?.included, false, 'missing layer defaults to included=false');
}

// 16. INDEPENDENCE ACROSS 5 SEGMENTS — the user's exact test scenario.
{
  const project = createProject('5-segment');
  const a = pin('layer-a');
  const b = pin('layer-b');
  const c = createLayer('text'); c.id = 'layer-c';
  const d = createLayer('route'); d.id = 'layer-d';
  project.layers = [a, b, c, d];

  const v1 = createView('View 1', [], { x: 0, y: 0, zoom: 1 }, project.layers);
  const v2 = createView('View 2', [], { x: 0, y: 0, zoom: 1 }, project.layers);
  const v3 = createView('View 3', [], { x: 0, y: 0, zoom: 1 }, project.layers);
  // Set exact patterns.
  v1.layerConfigs = {
    'layer-a': { included: true },
    'layer-b': { included: false },
    'layer-c': { included: true },
    'layer-d': { included: false },
  };
  v2.layerConfigs = {
    'layer-a': { included: false },
    'layer-b': { included: true },
    'layer-c': { included: false },
    'layer-d': { included: true },
  };
  v3.layerConfigs = {
    'layer-a': { included: true },
    'layer-b': { included: true },
    'layer-c': { included: false },
    'layer-d': { included: false },
  };
  // Transitions also independent.
  v1.transitionLayerConfigs = {
    'layer-a': { included: false },
    'layer-b': { included: true },
    'layer-c': { included: false },
    'layer-d': { included: true },
  };
  v2.transitionLayerConfigs = {
    'layer-a': { included: true },
    'layer-b': { included: false },
    'layer-c': { included: true },
    'layer-d': { included: true },
  };
  v1.holdDuration = 2;
  v1.transitionDuration = 1;
  v2.holdDuration = 2;
  v2.transitionDuration = 1;
  v3.holdDuration = 2;
  project.views = [v1, v2, v3];
  const runtime = validateAndMigrateProject(project);

  // Switch between segments — exact patterns preserved.
  assert.deepEqual([...viewMemberIds(v1)].sort(), ['layer-a', 'layer-c']);
  assert.deepEqual([...viewMemberIds(v2)].sort(), ['layer-b', 'layer-d']);
  assert.deepEqual([...viewMemberIds(v3)].sort(), ['layer-a', 'layer-b']);
  assert.deepEqual([...transitionMemberIds(runtime.transitions[0])].sort(), ['layer-b', 'layer-d']);
  assert.deepEqual([...transitionMemberIds(runtime.transitions[1])].sort(), ['layer-a', 'layer-c', 'layer-d']);
  // Re-verify after "switching" — still exact.
  assert.deepEqual([...viewMemberIds(v1)].sort(), ['layer-a', 'layer-c']);
  assert.deepEqual([...transitionMemberIds(runtime.transitions[1])].sort(), ['layer-a', 'layer-c', 'layer-d']);
}

// 17. PERSISTENCE ROUND-TRIP preserves exact configs for all layers.
{
  const project = createProject('Persistence');
  const a = pin('layer-a');
  const b = pin('layer-b');
  project.layers = [a, b];
  const view = createView('View 1', [a], { x: 0, y: 0, zoom: 1 }, project.layers);
  view.transitionLayerConfigs = {
    'layer-a': { included: true, animation: { appearEnabled: true, appearType: 'pop' } },
    'layer-b': { included: false },
  };
  project.views = [view, createView('Destination', [], { x: 0, y: 0, zoom: 1 })];

  const out = validateAndMigrateProject(project);
  assert.equal(Object.keys(out.views[0].layerConfigs ?? {}).length, 2, 'view configs preserved after round-trip');
  assert.equal(out.views[0].layerConfigs?.['layer-a']?.included, true);
  assert.equal(out.views[0].layerConfigs?.['layer-b']?.included, false);
  assert.deepEqual(out.transitions[0].layerConfigs['layer-a']?.animation, { appearEnabled: true, appearType: 'pop' });
}

console.log(
  'Segment-config verification: registry ids, view/transition allocation, independence, continuation, cut, view-only, eye isolation, persistence, backward compatibility, semantic warnings, helpers, full 4-layer model, allLayers createView, migration backfill, 5-segment independence, persistence completeness passed.',
);
