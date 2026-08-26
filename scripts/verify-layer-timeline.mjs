import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-layer-timeline-'));
const entryFile = join(outDir, 'entry.ts');
writeFileSync(
  entryFile,
  [
    "export * from '" + join(root, 'src', 'core', 'viewCompiler').replaceAll('\\', '/') + "';",
    "export * from '" + join(root, 'src', 'core', 'camera').replaceAll('\\', '/') + "';",
    "export * from '" + join(root, 'src', 'core', 'project').replaceAll('\\', '/') + "';",
    "export * from '" + join(root, 'src', 'core', 'projectPersistence').replaceAll('\\', '/') + "';",
    "export * from '" + join(root, 'src', 'core', 'segmentValidation').replaceAll('\\', '/') + "';",
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
}const {
  createLayer,
  createProject,
  createView,
  validateAndMigrateProject,
  compileViews,
  evaluateProjectAtTime,
  validateTransitionLayer,
  viewLayersOf,
  viewMemberIds,
  transitionMemberIds,
} = mod;


/** Build a 2-view project. `layers` is the canonical project registry; the
 *  outgoing transition of View A may own `transitionLayers` + `layerAnimations`
 *  (legacy fields, normalized by the helpers). */
const twoViewProject = (a, b, layers = []) => {
  const project = createProject('Segment model');
  project.layers = layers;
  project.views = [a, b];
  return validateAndMigrateProject(project);
};
const pinLayer = (overrides = {}) => {
  const pin = createLayer('pin');
  pin.name = 'Segment Pin';
  pin.x = 500;
  pin.y = 280;
  Object.assign(pin, overrides);
  return pin;
};
const pinId = (pin) => pin.id;

// 1. Independent membership (test 65): a layer selected ONLY in the
//    transition renders only during the transition.
{
  const pin = pinLayer();
  const a = createView('A', [], { x: 0, y: 0, zoom: 1 });
  const b = createView('B', [], { x: 0, y: 0, zoom: 1 });
  a.holdDuration = 1;
  a.transitionDuration = 2;
  b.holdDuration = 1;
  a.transitionLayers = [{ ...pin, visible: true }];
  const project = twoViewProject(a, b, [{ ...pin, visible: true }]);
  assert.equal(evaluateProjectAtTime(project, 0.5).layers.length, 0, 'absent during View A hold');
  const mid = evaluateProjectAtTime(project, 2.0);
  assert.equal(mid.layers.length, 1, 'present during the transition');
  assert.equal(mid.layers[0].id, pin.id, 'transition owns the layer usage');
  assert.equal(evaluateProjectAtTime(project, 3.5).layers.length, 0, 'absent in View B hold');
}

// 2. Transition → View cut (test 66): layer in transition but NOT in the next
//    View disappears EXACTLY at the boundary even mid-animation.
{
  const pin = pinLayer({
    pinAppearEnabled: true,
    pinAppearType: 'drop',
    pinAppearDelay: 0,
    pinAppearDuration: 5,
  });
  const a = createView('A', [], { x: 0, y: 0, zoom: 1 });
  const b = createView('B', [], { x: 0, y: 0, zoom: 1 });
  a.holdDuration = 1;
  a.transitionDuration = 2;
  b.holdDuration = 1;
  a.transitionLayers = [{ ...pin, visible: true }];
  a.layerAnimations = {
    [pinId(pin)]: { appearEnabled: true, appearType: 'drop', appearDelay: 0, appearDuration: 5 },
  };
  const project = twoViewProject(a, b, [{ ...pin, visible: true }]);
  const mid = evaluateProjectAtTime(project, 2.0).layers[0];
  assert.ok(
    mid.pinDropOffsetY !== undefined && mid.pinDropOffsetY < 0,
    'drop animation is running mid-transition',
  );
  assert.ok(mid.opacity > 0 && mid.opacity < 1, 'partial opacity mid-transition');
  // Exact boundary → View B is authoritative: the layer is gone despite the
  // unfinished 5s animation.
  assert.equal(evaluateProjectAtTime(project, 3.0).layers.length, 0, 'layer cut at exact View boundary');
}

// 3. Continuation (test 67): layer in transition AND next View; a long appear
//    continues into the View Hold, then settles on the exact View state.
{
  const pin = pinLayer({
    pinAppearEnabled: true,
    pinAppearType: 'fade',
    pinAppearDelay: 0,
    pinAppearDuration: 4,
  });
  const a = createView('A', [], { x: 0, y: 0, zoom: 1 });
  const b = createView('B', [{ ...pin, visible: true }], { x: 0, y: 0, zoom: 1 });
  a.holdDuration = 1;
  a.transitionDuration = 2;
  b.holdDuration = 3;
  a.transitionLayers = [{ ...pin, visible: true }];
  a.layerAnimations = {
    [pinId(pin)]: { appearEnabled: true, appearType: 'fade', appearDelay: 0, appearDuration: 4 },
  };
  const project = twoViewProject(a, b, [{ ...pin, visible: true }]);
  const midTransition = evaluateProjectAtTime(project, 2.0).layers[0].opacity;
  assert.ok(midTransition > 0 && midTransition < 1, 'appear running during transition');
  const duringHold = evaluateProjectAtTime(project, 3.5).layers[0];
  assert.ok(duringHold.opacity > midTransition, 'animation continues into the View Hold');
  assert.equal(duringHold.visible, true, 'visible during hold');
  // After appear completes (t = 1 + 4 = 5): exact destination state.
  const settled = evaluateProjectAtTime(project, 5.5).layers[0];
  assert.equal(settled.opacity, 1, 'exact final opacity once appear completes');
  assert.ok(
    settled.pinPopScale === undefined && settled.pinDropOffsetY === undefined,
    'no transient residue after completion',
  );
}

// 4. View → Transition cut (test 68): layer in View but NOT in the transition
//    disappears exactly when the transition starts.
{
  const pin = pinLayer();
  const a = createView('A', [{ ...pin, visible: true }], { x: 0, y: 0, zoom: 1 });
  const b = createView('B', [], { x: 0, y: 0, zoom: 1 });
  a.holdDuration = 1;
  a.transitionDuration = 2;
  b.holdDuration = 1;
  a.transitionLayers = []; // layer absent from the transition
  const project = twoViewProject(a, b, [{ ...pin, visible: true }]);
  assert.equal(evaluateProjectAtTime(project, 0.5).layers.length, 1, 'visible during View A hold');
  assert.equal(evaluateProjectAtTime(project, 1.5).layers.length, 0, 'cut exactly at transition start');
}

// 5. Transition → View appear (test 69): layer NOT in transition but in the
//    next View appears exactly at the View start (no transition animation).
{
  const pin = pinLayer();
  const a = createView('A', [], { x: 0, y: 0, zoom: 1 });
  const b = createView('B', [{ ...pin, visible: true }], { x: 0, y: 0, zoom: 1 });
  a.holdDuration = 1;
  a.transitionDuration = 2;
  b.holdDuration = 1;
  a.transitionLayers = [];
  const project = twoViewProject(a, b, [{ ...pin, visible: true }]);
  assert.equal(evaluateProjectAtTime(project, 2.9).layers.length, 0, 'absent during transition');
  const atBoundary = evaluateProjectAtTime(project, 3.0);
  assert.equal(atBoundary.layers.length, 1, 'appears exactly at View B start');
  assert.equal(atBoundary.layers[0].opacity, 1, 'appears immediately at full opacity');
}

// 6. Transition layer lifecycle: appear → hold → wipe with absolute timing.
{
  const pin = pinLayer();
  const a = createView('A', [], { x: 0, y: 0, zoom: 1 });
  const b = createView('B', [], { x: 0, y: 0, zoom: 1 });
  a.holdDuration = 1;
  a.transitionDuration = 6;
  b.holdDuration = 1;
  a.transitionLayers = [{ ...pin, visible: true }];
  a.layerAnimations = {
    [pinId(pin)]: {
      appearEnabled: true,
      appearType: 'fade',
      appearDelay: 0.5,
      appearDuration: 1,
      layerHoldDuration: 1,
      wipeEnabled: true,
      wipeDuration: 1,
    },
  };
  const project = twoViewProject(a, b, [{ ...pin, visible: true }]);
  // Transition spans [1, 7]. Appear [1.5, 2.5], hold [2.5, 3.5], wipe [3.5, 4.5].
  const before = evaluateProjectAtTime(project, 1.2).layers[0];
  assert.equal(before.visible, false, 'absent before appear delay elapses');
  assert.equal(before.opacity, 0, 'zero opacity before appear');
  const appearMid = evaluateProjectAtTime(project, 2.0).layers[0];
  assert.ok(appearMid.opacity > 0 && appearMid.opacity < 1, 'mid-appear partial opacity');
  const held = evaluateProjectAtTime(project, 3.0).layers[0];
  assert.equal(held.opacity, 1, 'full opacity during layer hold');
  const wipeMid = evaluateProjectAtTime(project, 4.0).layers[0];
  assert.ok(wipeMid.opacity > 0 && wipeMid.opacity < 1, 'mid-wipe partial opacity');
  assert.equal(wipeMid.visible, true, 'still visible while wiping');
  const wiped = evaluateProjectAtTime(project, 5.0).layers[0];
  assert.equal(wiped.visible, false, 'hidden after wipe completes');
  assert.equal(wiped.opacity, 0, 'zero opacity after wipe');
}

// 7. Transition-only layer with Wipe Out (Example A): appears, holds, wipes
//    out entirely inside the transition; the next View starts clean.
{
  const pin = pinLayer();
  const a = createView('A', [], { x: 0, y: 0, zoom: 1 });
  const b = createView('B', [], { x: 0, y: 0, zoom: 1 });
  a.holdDuration = 1;
  a.transitionDuration = 4;
  b.holdDuration = 1;
  a.transitionLayers = [{ ...pin, visible: true }];
  a.layerAnimations = {
    [pinId(pin)]: {
      appearEnabled: true,
      appearType: 'fade',
      appearDelay: 0,
      appearDuration: 1,
      layerHoldDuration: 0.5,
      wipeEnabled: true,
      wipeDuration: 1,
    },
  };
  const project = twoViewProject(a, b, [{ ...pin, visible: true }]);
  // appear [1,2], hold [2,2.5], wipe [2.5,3.5], gone [3.5,5]
  assert.equal(evaluateProjectAtTime(project, 1.5).layers[0].visible, true, 'appears during transition');
  assert.equal(evaluateProjectAtTime(project, 2.2).layers[0].opacity, 1, 'full during hold');
  assert.ok(evaluateProjectAtTime(project, 3.0).layers[0].opacity < 1, 'wiping out before the boundary');
  assert.equal(
    evaluateProjectAtTime(project, 4.0).layers[0].visible,
    false,
    'invisible before boundary (no wipe residue)',
  );
  assert.equal(evaluateProjectAtTime(project, 5.5).layers.length, 0, 'View B starts without the layer');
}

// 8. Appear is not replayed for continuously visible layers (visible → visible).
{
  const pin = pinLayer();
  const a = createView('A', [{ ...pin, visible: true }], { x: 0, y: 0, zoom: 1 });
  const b = createView('B', [{ ...pin, visible: true }], { x: 0, y: 0, zoom: 1 });
  a.holdDuration = 1;
  a.transitionDuration = 2;
  b.holdDuration = 1;
  a.transitionLayers = [{ ...pin, visible: true }];
  a.layerAnimations = {
    [pinId(pin)]: { appearEnabled: true, appearType: 'pop', appearDelay: 0, appearDuration: 1 },
  };
  const project = twoViewProject(a, b, [{ ...pin, visible: true }]);
  const mid = evaluateProjectAtTime(project, 2.0).layers[0];
  assert.equal(mid.opacity, 1, 'no appear replay for a continuously visible layer');
  assert.ok(mid.pinPopScale === undefined, 'no transient pop scale when appear is suppressed');
}

// 9. Semantic warnings (test 70).
{
  const id = 'layer-x';
  const anim = (o) => o;
  const empty = new Set();
  const both = new Set([id]);
  // Animation on a layer not selected in the transition.
  let warnings = validateTransitionLayer({
    sourceMemberIds: empty,
    transitionIncluded: false,
    destMemberIds: empty,
    layerId: id,
    anim: anim({ appearEnabled: true }),
  });
  assert.ok(
    warnings.some((w) => w.message.includes('Enable this layer')),
    'warns: animation on unselected layer',
  );
  // Wipe Out then the next View shows the layer again.
  warnings = validateTransitionLayer({
    sourceMemberIds: empty,
    transitionIncluded: true,
    destMemberIds: both,
    layerId: id,
    anim: anim({ wipeEnabled: true }),
  });
  assert.ok(
    warnings.some((w) => w.message.includes('Wipe Out')),
    'warns: wipe then next View visible',
  );
  // Appear enabled while continuously visible from the source View.
  warnings = validateTransitionLayer({
    sourceMemberIds: both,
    transitionIncluded: true,
    destMemberIds: both,
    layerId: id,
    anim: anim({ appearEnabled: true }),
  });
  assert.ok(
    warnings.some((w) => w.message.includes('already visible')),
    'warns: appear on continuously visible layer',
  );
  // Layer disappears for the transition then reappears.
  warnings = validateTransitionLayer({
    sourceMemberIds: both,
    transitionIncluded: false,
    destMemberIds: both,
    layerId: id,
    anim: undefined,
  });
  assert.ok(
    warnings.some((w) => w.message.includes('disappear when the transition starts')),
    'warns: layer hidden for the transition then reappears',
  );
  // Animation cut at the View boundary (layer absent from the destination).
  warnings = validateTransitionLayer({
    sourceMemberIds: empty,
    transitionIncluded: true,
    destMemberIds: empty,
    layerId: id,
    anim: anim({ appearEnabled: true, appearDuration: 5 }),
  });
  assert.ok(
    warnings.some((w) => w.message.includes('cut at the View boundary')),
    'warns: animation cut by boundary',
  );
}

// 10. Eye is editor-only: it is not part of the schema, never persists, and
//     never appears in evaluated output.
{
  const pin = pinLayer();
  const project = createProject('Eye isolation');
  project.layers = [{ ...pin, visible: true }];
  const view = createView('V', [{ ...pin, visible: true }], { x: 0, y: 0, zoom: 1 });
  view.holdDuration = 1;
  project.views = [view, createView('Destination', [], { x: 0, y: 0, zoom: 1 })];
  const migrated = validateAndMigrateProject(project);
  assert.ok(!('eyeHidden' in migrated.layers[0]), 'no eye state persisted on layers');
  assert.ok(
    !('eyeHidden' in viewLayersOf(migrated, migrated.views[0])[0]),
    'no eye state persisted on View layers',
  );
  assert.ok(
    !('eyeHidden' in evaluateProjectAtTime(project, 0.5).layers[0]),
    'no eye state in evaluated output',
  );
}

// 11. Persistence: legacy transition snapshots migrate into normalized usage
//     configs and invalid values are rejected.
{
  const project = createProject('Segment persistence');
  const pin = pinLayer();
  const view = createView('V', [], { x: 0, y: 0, zoom: 1 });
  view.transitionLayers = [{ ...pin, visible: true }];
  view.layerAnimations = {
    [pinId(pin)]: {
      appearEnabled: true,
      appearType: 'drop',
      appearDelay: 0.2,
      appearDuration: 1.5,
      holdDuration: 0.5,
      wipeEnabled: true,
      wipeDelay: 0.1,
      wipeDuration: 0.8,
    },
  };
  project.views = [view, createView('Destination', [], { x: 0, y: 0, zoom: 1 })];
  const out = validateAndMigrateProject(project);
  assert.equal(out.transitions[0].layerConfigs[pin.id].included, true, 'transition membership migrates');
  assert.equal(out.transitions[0].layerConfigs[pin.id].animation.appearType, 'drop');
  assert.ok(!('transitionLayers' in out.views[0]), 'legacy transition snapshots are removed');
  assert.ok(!('layerAnimations' in out.views[0]), 'legacy animation map is removed');
  for (const bad of [
    { layerAnimations: { x: { appearType: 'bounce' } } },
    { layerAnimations: { x: { appearDelay: -1 } } },
    { layerAnimations: { x: { appearDuration: 0 } } },
    { layerAnimations: { x: { wipeDuration: 0 } } },
    { layerAnimations: { x: { layerHoldDuration: -0.5 } } },
    { layerAnimations: { x: { appearEnabled: 'yes' } } },
    { layerAnimations: { x: { wipeType: 'explode' } } },
  ]) {
    const candidate = createProject('Bad segment');
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

// 12. Legacy compatibility: committed projects (full `layers` clones, no
//     configs) migrate to canonical usages — membership preserved, transition
//     synthesized as the union of adjacent Views so old files render the same
//     layers during the camera move.
{
  const pin = pinLayer();
  delete pin.pinAppearEnabled;
  pin.pinAppear = 'fade';
  // Build genuinely legacy views: full `layers` clones, no `layerConfigs`.
  const a = createView('A', [], { x: 0, y: 0, zoom: 1 });
  const b = createView('B', [], { x: 0, y: 0, zoom: 1 });
  delete a.layerConfigs;
  delete b.layerConfigs;
  delete a.transitionLayerConfigs;
  delete b.transitionLayerConfigs;
  a.layers = [{ ...pin, visible: true }];
  b.layers = [{ ...pin, visible: false }];
  a.holdDuration = 1;
  a.transitionDuration = 2;
  b.holdDuration = 1;
  const project = twoViewProject(a, b, [{ ...pin, visible: true }]);
  const migrated = validateAndMigrateProject(project);
  // Membership preserved: View A includes, View B excludes.
  assert.ok(viewMemberIds(migrated.views[0]).has(pin.id), 'legacy visible layer is included in View A');
  assert.ok(!viewMemberIds(migrated.views[1]).has(pin.id), 'legacy hidden layer is excluded from View B');
  // Transition membership synthesized as the union (old interpolation showed
  // layers from either View during the camera move).
  assert.ok(transitionMemberIds(migrated.views[0]).has(pin.id), 'legacy transition includes the union layer');
  // Rendering: View A hold shows the pin; View B hold does not.
  assert.equal(evaluateProjectAtTime(migrated, 0.5).layers.length, 1, 'View A hold renders the pin');
  assert.equal(evaluateProjectAtTime(migrated, 1 + 2 + 0.5).layers.length, 0, 'View B hold renders nothing');
}

// 13. No NaN anywhere across the full sequence.
{
  const pin = pinLayer();
  const a = createView('A', [], { x: 0, y: 0, zoom: 1 });
  const b = createView('B', [], { x: 0, y: 0, zoom: 1 });
  a.holdDuration = 1;
  a.transitionDuration = 4;
  b.holdDuration = 1;
  a.transitionLayers = [{ ...pin, visible: true }];
  a.layerAnimations = {
    [pinId(pin)]: {
      appearEnabled: true,
      appearType: 'drop',
      appearDelay: 0.3,
      appearDuration: 2,
      layerHoldDuration: 0.5,
      wipeEnabled: true,
      wipeDuration: 1,
    },
  };
  const project = twoViewProject(a, b, [{ ...pin, visible: true }]);
  const sequence = compileViews(project.views);
  for (let t = 0; t <= sequence.duration; t += 0.25) {
    const state = evaluateProjectAtTime(project, t);
    assert.ok(
      Number.isFinite(state.camera.x) &&
        Number.isFinite(state.camera.y) &&
        Number.isFinite(state.camera.zoom),
    );
    for (const l of state.layers) {
      assert.ok(Number.isFinite(l.opacity), `t=${t}: opacity finite`);
      assert.ok(Number.isFinite(l.x) && Number.isFinite(l.y), `t=${t}: position finite`);
      if (l.pinPopScale !== undefined) assert.ok(Number.isFinite(l.pinPopScale), `t=${t}: popScale finite`);
      if (l.pinDropOffsetY !== undefined)
        assert.ok(Number.isFinite(l.pinDropOffsetY), `t=${t}: dropY finite`);
    }
  }
}

console.log(
  'Layer-timeline verification: independent View/Transition membership, boundary cuts, appear/hold/wipe lifecycle, continuation into hold, semantic warnings, eye isolation, persistence, legacy compatibility, NaN checks passed.',
);
