import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-pins-'));
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
  PIN_DEFAULTS,
  createLayer,
  createProject,
  createView,
  deleteProjectLayer,
  pinAppearOf,
  pinSizeOf,
  pinStyleOf,
  validateAndMigrateProject,
  compileViews,
  evaluateProjectAtTime,
  viewLayersOf,
  viewMemberIds,
} = mod;

/** Build a two-View project where View A does NOT include the pin, View B
 *  includes it, and the transition includes it with an optional animation. */
const enterProject = (pin, transitionAnim, holdA = 1, transDur = 3, holdB = 1) => {
  const project = createProject('Enter project');
  project.layers = [pin];
  const viewA = createView('A', [], { x: 0, y: 0, zoom: 1 }, project.layers);
  const viewB = createView('B', [pin], { x: 0, y: 0, zoom: 1 }, project.layers);
  viewA.holdDuration = holdA;
  viewA.transitionDuration = transDur;
  viewB.holdDuration = holdB;
  viewA.transitionLayerConfigs = Object.fromEntries(
    project.layers.map((l) => [l.id, { included: l.id === pin.id, animation: transitionAnim }]),
  );
  project.views = [viewA, viewB];
  return validateAndMigrateProject(project);
};

// 1. Deterministic defaults for legacy pins (no pin fields stored).
const legacyPin = createLayer('pin');
delete legacyPin.pinStyle;
delete legacyPin.pinSize;
delete legacyPin.pinAppear;
assert.equal(pinStyleOf(legacyPin), 'dot', 'legacy pin renders as the historical dot');
assert.equal(pinSizeOf(legacyPin), 13, 'legacy pin size matches the historical radius');
assert.equal(pinAppearOf(legacyPin), 'fade', 'legacy pin inherits fade appear behavior');
assert.equal(PIN_DEFAULTS.style, 'dot');
assert.equal(PIN_DEFAULTS.appear, 'fade');

// 2. New pins carry explicit professional defaults.
const freshPin = createLayer('pin');
assert.equal(freshPin.pinStyle, 'location');
assert.equal(freshPin.pinAppearEnabled, true, 'new pins have appear enabled by default');
assert.equal(freshPin.pinAppearType, 'fade', 'new pins default to fade appear type');
assert.equal(freshPin.pinAppearDelay, 0, 'new pins default to zero delay');
assert.equal(freshPin.pinAppearDuration, 0.6, 'new pins default to 0.6s duration');
assert.equal(typeof freshPin.pinSize, 'number');
assert.ok(freshPin.pinSize > 0);

// 3. Persistence round-trip preserves every pin field; invalid values rejected.
const styled = createLayer('pin');
styled.pinStyle = 'star';
styled.pinSize = 21;
styled.pinBorderColor = '#112233';
styled.pinBorderWidth = 2;
styled.pinLabelVisible = false;
styled.pinLabelSize = 14;
styled.pinLabelColor = '#aabbcc';
styled.pinLabelPosition = 'top';
styled.pinLabelGap = 8;
// New appear model (project-level default metadata; evaluation uses segment configs)
styled.pinAppearEnabled = true;
styled.pinAppearType = 'drop';
styled.pinAppearDelay = 0.3;
styled.pinAppearDuration = 0.8;
// Custom icon fields
styled.pinCustomAnchor = 'center';
const persisted = createProject('Pin persistence');
persisted.layers = [styled];
const migrated = validateAndMigrateProject(persisted);
assert.equal(migrated.layers[0].pinStyle, 'star');
assert.equal(migrated.layers[0].pinSize, 21);
assert.equal(migrated.layers[0].pinBorderColor, '#112233');
assert.equal(migrated.layers[0].pinBorderWidth, 2);
assert.equal(migrated.layers[0].pinLabelVisible, false);
assert.equal(migrated.layers[0].pinLabelSize, 14);
assert.equal(migrated.layers[0].pinLabelColor, '#aabbcc');
assert.equal(migrated.layers[0].pinLabelPosition, 'top');
assert.equal(migrated.layers[0].pinLabelGap, 8);
assert.equal(migrated.layers[0].pinAppearEnabled, true);
assert.equal(migrated.layers[0].pinAppearType, 'drop');
assert.equal(migrated.layers[0].pinAppearDelay, 0.3);
assert.equal(migrated.layers[0].pinAppearDuration, 0.8);
assert.equal(migrated.layers[0].pinCustomAnchor, 'center');

// Legacy pinAppear still round-trips
const legacyStyled = createLayer('pin');
legacyStyled.pinAppear = 'pop';
const legacyPersisted = createProject('Legacy pin');
legacyPersisted.layers = [legacyStyled];
const legacyMigrated = validateAndMigrateProject(legacyPersisted);
assert.equal(legacyMigrated.layers[0].pinAppear, 'pop', 'legacy pinAppear round-trips');

for (const bad of [
  { pinStyle: 'banana' },
  { pinAppear: 'bounce' },
  { pinAppearType: 'bounce' },
  { pinCustomAnchor: 'top-left' },
  { pinLabelPosition: 'upper-left' },
  { pinSize: 'big' },
  { pinLabelVisible: 'yes' },
  { pinAppearEnabled: 'yes' },
  { pinAppearDelay: -1 },
  { pinAppearDuration: 0 },
]) {
  const candidate = createProject('Bad pin');
  const layer = createLayer('pin');
  Object.assign(layer, bad);
  candidate.layers = [layer];
  assert.throws(
    () => validateAndMigrateProject(candidate),
    undefined,
    `validation must reject ${JSON.stringify(bad)}`,
  );
}

// 4. GLOBAL PROPERTY BEHAVIOR — one canonical Project Pin; every View using it
//    renders the same visual state. Changing the Project Pin changes it in all
//    segments immediately (no View snapshot, no Update View needed).
{
  const project = createProject('Global property');
  const pin = createLayer('pin');
  pin.pinStyle = 'dot';
  pin.pinSize = 12;
  pin.x = 600;
  pin.y = 300;
  pin.text = 'Tehran';
  project.layers = [pin];
  const vA = createView('A', [pin], { x: 0, y: 0, zoom: 1 }, project.layers);
  const vB = createView('B', [pin], { x: 0, y: 0, zoom: 1 }, project.layers);
  vA.holdDuration = 1;
  vA.transitionDuration = 2;
  vB.holdDuration = 1;
  project.views = [vA, vB];

  const holdA = evaluateProjectAtTime(project, 0.5).layers[0];
  const holdB = evaluateProjectAtTime(project, 1 + 2 + 0.5).layers[0];
  assert.equal(holdA.pinSize, 12, 'View A renders canonical size');
  assert.equal(holdB.pinSize, 12, 'View B renders canonical size');
  assert.equal(holdA.x, 600, 'View A renders canonical x');
  assert.equal(holdB.x, 600, 'View B renders canonical x (no per-view position)');

  // Change the Project Pin → every segment changes immediately.
  project.layers[0].pinSize = 50;
  project.layers[0].x = 900;
  project.layers[0].text = 'Paris';
  const holdA2 = evaluateProjectAtTime(project, 0.5).layers[0];
  const holdB2 = evaluateProjectAtTime(project, 1 + 2 + 0.5).layers[0];
  assert.equal(holdA2.pinSize, 50, 'global size change reflected in View A');
  assert.equal(holdB2.pinSize, 50, 'global size change reflected in View B');
  assert.equal(holdA2.x, 900, 'global position change reflected in View A');
  assert.equal(holdB2.x, 900, 'global position change reflected in View B');
  assert.equal(holdA2.text, 'Paris', 'global label change reflected everywhere');
}

// 5. TRANSITION APPEAR — fade via segment animation config (delay + duration).
{
  const pin = createLayer('pin');
  pin.opacity = 0.8;
  const project = enterProject(
    pin,
    { appearEnabled: true, appearType: 'fade', appearDelay: 0.5, appearDuration: 1.0 },
  );
  // holdA=1, trans=3 → transition spans [1, 4)
  const beforeDelay = evaluateProjectAtTime(project, 1.2).layers[0];
  assert.equal(beforeDelay.opacity, 0, 'fade: absent before delay');
  assert.equal(beforeDelay.visible, false, 'fade: not visible before delay');
  const mid = evaluateProjectAtTime(project, 2.0).layers[0];
  assert.ok(mid.opacity > 0 && mid.opacity < 0.8, 'fade: opacity ramps during animation');
  assert.equal(mid.visible, true, 'fade: visible during animation');
  const after = evaluateProjectAtTime(project, 2.6).layers[0];
  assert.equal(after.opacity, 0.8, 'fade: exact final opacity');
  const hold = evaluateProjectAtTime(project, 4.5).layers[0];
  assert.equal(hold.opacity, 0.8, 'fade: hold is exact');
  assert.equal(hold.pinPopScale, undefined, 'fade: no transient scale in hold');
  assert.equal(hold.pinDropOffsetY, undefined, 'fade: no transient Y offset in hold');
}

// 6. TRANSITION APPEAR — pop (transient scale ramp, exact endpoint).
{
  const pin = createLayer('pin');
  pin.opacity = 1;
  const project = enterProject(
    pin,
    { appearEnabled: true, appearType: 'pop', appearDelay: 0.3, appearDuration: 0.8 },
  );
  const mid = evaluateProjectAtTime(project, 1 + 0.3 + 0.4).layers[0];
  assert.ok(mid.pinPopScale >= 0.85 && mid.pinPopScale < 1, 'pop: transient scale during animation');
  assert.ok(mid.opacity > 0 && mid.opacity < 1, 'pop: opacity ramps');
  assert.ok(
    mid.pinDropOffsetY === undefined || mid.pinDropOffsetY === 0,
    'pop: no Y offset',
  );
  const hold = evaluateProjectAtTime(project, 4.5).layers[0];
  assert.equal(hold.opacity, 1, 'pop: exact final opacity');
  assert.equal(hold.pinPopScale, undefined, 'pop: no transient scale in hold');
}

// 7. TRANSITION APPEAR — drop (transient Y offset, exact endpoint).
{
  const pin = createLayer('pin');
  pin.opacity = 0.9;
  const project = enterProject(
    pin,
    { appearEnabled: true, appearType: 'drop', appearDelay: 0.2, appearDuration: 0.8 },
  );
  const before = evaluateProjectAtTime(project, 1.1).layers[0];
  assert.equal(before.opacity, 0, 'drop: absent before delay');
  const early = evaluateProjectAtTime(project, 1 + 0.2 + 0.1).layers[0];
  assert.ok(early.pinDropOffsetY < 0, 'drop: negative Y offset (above target)');
  assert.ok(early.opacity > 0, 'drop: opacity ramps');
  assert.ok(early.pinPopScale >= 0.97 && early.pinPopScale < 1, 'drop: restrained 0.97→1 scale');
  assert.equal(early.x, pin.x, 'drop: geographic X unchanged');
  assert.equal(early.y, pin.y, 'drop: geographic Y unchanged');
  const after = evaluateProjectAtTime(project, 1 + 0.2 + 0.8 + 0.1).layers[0];
  assert.equal(after.opacity, 0.9, 'drop: exact final opacity');
  assert.equal(after.pinDropOffsetY, undefined, 'drop: no transient offset after completion');
  const hold = evaluateProjectAtTime(project, 4.5).layers[0];
  assert.equal(hold.pinDropOffsetY, undefined, 'drop: no transient Y offset in hold');
}

// 8. INDEPENDENT TIMING — layer animation is longer than the camera
//    transition and continues into the destination View Hold.
{
  const pin = createLayer('pin');
  pin.opacity = 1;
  // holdA=0.5, trans=1.0, holdB=2.0. Animation delay 0.8 + duration 1.0.
  const project = enterProject(
    pin,
    { appearEnabled: true, appearType: 'fade', appearDelay: 0.8, appearDuration: 1.0 },
    0.5,
    1.0,
    2.0,
  );
  // Animation start = 0.5 + 0.8 = 1.3; end = 2.3.
  const transEnd = evaluateProjectAtTime(project, 0.5 + 1.0).layers[0];
  assert.ok(transEnd.opacity > 0 && transEnd.opacity < 1, 'independent timing: animating at transition end');
  const before = evaluateProjectAtTime(project, 1.0).layers[0];
  assert.equal(before.opacity, 0, 'independent timing: absent before delay elapses');
  const mid = evaluateProjectAtTime(project, 2.0).layers[0];
  assert.ok(mid.opacity > 0 && mid.opacity < 1, 'independent timing: animating during hold period');
  const complete = evaluateProjectAtTime(project, 2.5).layers[0];
  assert.equal(complete.opacity, 1, 'independent timing: exact final opacity after completion in hold');
  assert.equal(complete.visible, true, 'independent timing: visible after completion');
}

// 9. NO ANIMATION CONFIG / APPEAR DISABLED — instant full appearance.
{
  const pin = createLayer('pin');
  pin.opacity = 0.7;
  const project = enterProject(pin, undefined);
  const early = evaluateProjectAtTime(project, 1 + 0.01).layers[0];
  assert.equal(early.opacity, 0.7, 'no config: instant full opacity');
  assert.equal(early.visible, true, 'no config: instantly visible');
  assert.ok(early.pinPopScale === undefined || early.pinPopScale === 1, 'no config: no transient scale');
  assert.ok(early.pinDropOffsetY === undefined || early.pinDropOffsetY === 0, 'no config: no transient Y offset');
}

// 10. NO REPLAY — a layer continuously visible from the source View into the
//     transition never replays appear (entering=false).
{
  const pin = createLayer('pin');
  pin.opacity = 1;
  const project = createProject('No replay');
  project.layers = [pin];
  const vA = createView('A', [pin], { x: 0, y: 0, zoom: 1 }, project.layers);
  const vB = createView('B', [pin], { x: 0, y: 0, zoom: 1 }, project.layers);
  vA.holdDuration = 1;
  vA.transitionDuration = 2.5;
  vB.holdDuration = 0;
  // Transition includes the pin with appear enabled, but the pin is already in
  // the source View → appear must NOT play.
  vA.transitionLayerConfigs = Object.fromEntries(
    project.layers.map((l) => [
      l.id,
      { included: true, animation: { appearEnabled: true, appearType: 'pop', appearDelay: 0, appearDuration: 1 } },
    ]),
  );
  project.views = [vA, vB];
  const mid = evaluateProjectAtTime(validateAndMigrateProject(project), 1 + 1.25).layers[0];
  assert.equal(mid.opacity, 1, 'continuously visible: no replay, full opacity mid-transition');
  assert.ok(mid.pinPopScale === undefined || mid.pinPopScale === 1, 'continuously visible: no transient pop scale');
  assert.equal(mid.visible, true, 'continuously visible: visible throughout');
}

// 11. VIEW-HOLD ANIMATION — a View's own animation lifecycle runs during the
//     View Hold: appear → layer hold → wipe.
{
  const project = createProject('View hold animation');
  const pin = createLayer('pin');
  pin.opacity = 1;
  project.layers = [pin];
  const vA = createView('A', [pin], { x: 0, y: 0, zoom: 1 }, project.layers);
  vA.holdDuration = 5;
  vA.layerConfigs = {
    [pin.id]: {
      included: true,
      animation: {
        appearEnabled: true,
        appearType: 'fade',
        appearDelay: 1,
        appearDuration: 1,
        layerHoldDuration: 2,
        wipeEnabled: true,
        wipeDuration: 1,
      },
    },
  };
  project.views = [vA];
  assert.equal(evaluateProjectAtTime(project, 0).layers[0].opacity, 0, 'view appear: hidden before delay');
  const ramping = evaluateProjectAtTime(project, 1.5).layers[0];
  assert.ok(ramping.opacity > 0 && ramping.opacity < 1, 'view appear: ramping');
  assert.equal(evaluateProjectAtTime(project, 2.5).layers[0].opacity, 1, 'view appear: complete at t=2');
  const wiping = evaluateProjectAtTime(project, 4.5).layers[0];
  assert.ok(wiping.opacity > 0 && wiping.opacity < 1, 'view wipe: ramping (hold ends at 4)');
  assert.equal(evaluateProjectAtTime(project, 5.5).layers[0].opacity, 0, 'view wipe: complete at t=5');
}

// 12. CONTINUATION — a transition appear still running when the destination
//     View begins continues into the View Hold (both segments include the pin).
{
  const pin = createLayer('pin');
  pin.opacity = 1;
  const project = enterProject(
    pin,
    { appearEnabled: true, appearType: 'drop', appearDelay: 0, appearDuration: 3 },
    1,
    2,
    3,
  );
  // Transition spans [1, 3); appear 0..3 → ends at t=4, during View B hold.
  const duringHold = evaluateProjectAtTime(project, 3.5).layers[0];
  assert.equal(duringHold.visible, true, 'continuation: layer continues into the View hold');
  assert.ok(duringHold.pinDropOffsetY !== undefined && duringHold.pinDropOffsetY < 0, 'continuation: drop still animating');
  const settled = evaluateProjectAtTime(project, 4.5).layers[0];
  assert.equal(settled.opacity, 1, 'continuation: exact destination opacity after completion');
  assert.equal(settled.pinDropOffsetY, undefined, 'continuation: no transient residue after completion');
}

// 13. No NaN in any evaluated pin fields.
{
  const pin = createLayer('pin');
  pin.opacity = 0.8;
  const project = enterProject(
    pin,
    { appearEnabled: true, appearType: 'drop', appearDelay: 0.5, appearDuration: 1.0 },
  );
  for (const t of [0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0]) {
    const state = evaluateProjectAtTime(project, t);
    for (const l of state.layers) {
      assert.ok(Number.isFinite(l.opacity), `t=${t}: opacity must be finite`);
      assert.ok(Number.isFinite(l.x), `t=${t}: x must be finite`);
      assert.ok(Number.isFinite(l.y), `t=${t}: y must be finite`);
      if (l.pinPopScale !== undefined) assert.ok(Number.isFinite(l.pinPopScale), `t=${t}: pinPopScale must be finite`);
      if (l.pinDropOffsetY !== undefined)
        assert.ok(Number.isFinite(l.pinDropOffsetY), `t=${t}: pinDropOffsetY must be finite`);
    }
  }
}

// 14. Custom icon pins are project-level: they survive Views, holds, and
//     transitions without falling back to a built-in style.
{
  const project = createProject('Custom pin through views');
  const custom = createLayer('pin');
  custom.pinStyle = 'custom';
  custom.pinCustomAssetId = 'asset_aaaa';
  custom.pinCustomAnchor = 'bottom-center';
  custom.pinTintEnabled = true;
  custom.pinTintColor = '#e8533e';
  custom.pinAppearEnabled = false;
  project.layers = [custom];
  const vA = createView('A', [custom], { x: 0, y: 0, zoom: 1 }, project.layers);
  const vB = createView('B', [custom], { x: 0, y: 0, zoom: 1 }, project.layers);
  vA.holdDuration = 1;
  vA.transitionDuration = 2;
  vB.holdDuration = 1;
  project.views = [vA, vB];
  const hold = evaluateProjectAtTime(project, 0.5).layers[0];
  assert.equal(pinStyleOf(hold), 'custom', 'custom style preserved at hold');
  assert.equal(hold.pinCustomAssetId, 'asset_aaaa', 'custom asset preserved at hold');
  assert.equal(hold.pinCustomAnchor, 'bottom-center', 'custom anchor preserved at hold');
  assert.equal(hold.pinTintEnabled, true, 'tint enabled preserved at hold');
  assert.equal(hold.pinTintColor, '#e8533e', 'tint color preserved at hold');
  const holdB = evaluateProjectAtTime(project, 1 + 2 + 0.5).layers[0];
  assert.equal(pinStyleOf(holdB), 'custom', 'custom style preserved in second View');
}

// 15. Pin size range: large configured sizes are valid and survive the
//     persistence round-trip; invalid sizes are rejected.
{
  const project = createProject('Pin size range');
  const pin = createLayer('pin');
  pin.pinSize = 200;
  project.layers = [pin];
  const view = createView('A', [pin], { x: 0, y: 0, zoom: 1 }, project.layers);
  project.views = [view];
  const roundTripped = validateAndMigrateProject(project);
  assert.equal(
    viewLayersOf(roundTripped, roundTripped.views[0])[0].pinSize,
    200,
    'pinSize 200 survives validation round-trip',
  );
  const huge = createLayer('pin');
  huge.pinSize = 200;
  assert.equal(pinSizeOf(huge), 200, 'pinSizeOf honors the extended range');
  assert.throws(
    () => {
      const bad = createProject('Bad size');
      bad.layers = [{ ...pin, pinSize: -5 }];
      validateAndMigrateProject(bad);
    },
    /pinSize/,
    'negative pinSize is rejected',
  );
}

// 16. Tint + border fields round-trip through persistence validation.
{
  const project = createProject('Pin tint persistence');
  const pin = createLayer('pin');
  pin.pinStyle = 'custom';
  pin.pinTintEnabled = true;
  pin.pinTintColor = '#2288cc';
  pin.pinBorderColor = '#ffcc00';
  pin.pinBorderWidth = 4;
  project.layers = [pin];
  project.views = [createView('A', [pin], { x: 0, y: 0, zoom: 1 }, project.layers)];
  const roundTripped = validateAndMigrateProject(project);
  const stored = viewLayersOf(roundTripped, roundTripped.views[0])[0];
  assert.equal(stored.pinTintEnabled, true, 'tint enabled survives round-trip');
  assert.equal(stored.pinTintColor, '#2288cc', 'tint color survives round-trip');
  assert.equal(stored.pinBorderColor, '#ffcc00', 'custom border color survives round-trip');
  assert.equal(stored.pinBorderWidth, 4, 'custom border width survives round-trip');
}

// 17. DELETE CASCADE — deleting a Project Layer removes it from the registry
//     and from every View / Transition usage.
{
  const project = createProject('Delete cascade');
  const pin = createLayer('pin');
  project.layers = [pin];
  const v1 = createView('View 1', [pin], { x: 0, y: 0, zoom: 1 }, project.layers);
  const v2 = createView('View 2', [pin], { x: 0, y: 0, zoom: 1 }, project.layers);
  v1.transitionLayerConfigs = Object.fromEntries(
    project.layers.map((l) => [l.id, { included: true, animation: { appearEnabled: true } }]),
  );
  project.views = [v1, v2];
  const deleted = deleteProjectLayer(validateAndMigrateProject(project), pin.id);
  assert.equal(deleted.layers.length, 0, 'registry no longer contains the layer');
  for (const view of deleted.views) {
    assert.ok(!(pin.id in (view.layerConfigs ?? {})), 'usage removed from every View');
  }
  for (const transition of deleted.transitions)
    assert.ok(!(pin.id in transition.layerConfigs), 'usage removed from every Transition');
  // Preview/Export remain valid — no dangling references.
  const state = evaluateProjectAtTime(deleted, 0.5);
  assert.ok(state.layers.every((l) => l.id !== pin.id), 'no dangling layer renders');
  // Round-trip still validates.
  validateAndMigrateProject(deleted);
}

// 18. EYE is editor-only — it is not part of the config schema and never
//     affects evaluated output or membership.
{
  const project = createProject('Eye isolation');
  const pin = createLayer('pin');
  project.layers = [pin];
  const view = createView('View 1', [pin], { x: 0, y: 0, zoom: 1 }, project.layers);
  view.holdDuration = 1;
  project.views = [view];
  const migrated = validateAndMigrateProject(project);
  assert.ok(!('eyeHidden' in migrated.layers[0]), 'no eye state persisted on registry layers');
  assert.ok(!('eyeHidden' in viewLayersOf(migrated, migrated.views[0])[0]), 'no eye state on render layers');
  assert.ok(!('eyeHidden' in evaluateProjectAtTime(project, 0.5).layers[0]), 'no eye state in evaluated output');
  assert.ok(viewMemberIds(view).has(pin.id), 'eye state does not change membership');
}

console.log(
  'Pin verification: legacy defaults, persistence round-trip, invalid-field rejection, global property behavior, transition appear (fade/pop/drop), independent timing, no-replay, view-hold animation, continuation, custom-through-views, size range, tint/border persistence, delete cascade, eye isolation, NaN checks passed.',
);
