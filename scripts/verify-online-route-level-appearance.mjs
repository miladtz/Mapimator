import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'mapmotion-route-level-'));
const entry = join(out, 'entry.ts');
const source = (value) => join(root, value).replaceAll('\\', '/');
writeFileSync(
  entry,
  `export * from '${source('src/core/project')}'; export * from '${source('src/core/routes')}'; export * from '${source('src/core/viewCompiler')}'; export * from '${source('src/core/projectFile')}';`,
);
let core;
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
  core = await import(pathToFileURL(join(out, 'core.mjs')).href);
} finally {
  rmSync(out, { recursive: true, force: true });
}

const points = [0, 1, 7, 10].map((longitude, index) => ({
  id: `point-${index}`,
  name: `Point ${index}`,
  longitude,
  latitude: 0,
}));
const route = core.createRouteLayer(points);
const sectionIds = route.routeSegments.map((section) => section.id);
const includedSections = Object.fromEntries(sectionIds.map((id) => [id, { included: true }]));
const approximately = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
const routeDraw = {
  appearEnabled: true,
  appearType: 'draw-route',
  appearDelay: 0,
  appearDuration: 10,
  routeSegmentAnimations: includedSections,
};

// 1:6:3 geometry receives 1:6:3 of one route-level Draw event.
let state = core.evaluateRouteRenderState(route, routeDraw, 2);
approximately(state[0].drawProgress, 1, 'first short Section completes first');
approximately(state[1].drawProgress, 1 / 6, 'second Section receives proportional progress');
assert.equal(state[2].drawProgress, 0);
state = core.evaluateRouteRenderState(route, routeDraw, 7);
approximately(state[0].drawProgress, 1, 'first Section remains complete');
approximately(state[1].drawProgress, 1, 'long middle Section completes at 70%');
assert.equal(state[2].drawProgress, 0);

// Excluded geometry receives neither pixels nor duration allocation.
const excludedMiddle = structuredClone(routeDraw);
excludedMiddle.routeSegmentAnimations[sectionIds[1]].included = false;
state = core.evaluateRouteRenderState(route, excludedMiddle, 5);
approximately(state[0].drawProgress, 1, 'included short Section completes');
assert.equal(state[1].exists, false);
approximately(state[2].drawProgress, 1 / 3, 'excluded middle distance is omitted');

// Route-level Fade/Pop/Drop use the one parent lifecycle opacity, not per-Section multiplication.
for (const appearType of ['fade', 'pop', 'drop']) {
  state = core.evaluateRouteRenderState(
    route,
    { ...routeDraw, appearType, appearDuration: 2 },
    1,
  );
  assert.ok(state.every((section) => section.opacityMultiplier === 1), `${appearType} avoids double opacity`);
}

// Route-level appearance suppresses conflicting Section appearance without mutating it.
const precedence = structuredClone(routeDraw);
precedence.routeSegmentAnimations[sectionIds[0]] = {
  included: true,
  appearEnabled: true,
  appearType: 'fade',
  appearDuration: 1,
};
const preservedSections = structuredClone(precedence.routeSegmentAnimations);
state = core.evaluateRouteRenderState(route, precedence, 2);
assert.equal(state[0].drawProgress, 1, 'route-wide distance wins over Section fade');
assert.deepEqual(precedence.routeSegmentAnimations, preservedSections, 'Section settings remain stored');

// Without a Route-level event, historical per-Section behavior is unchanged.
const sectionOnly = { routeSegmentAnimations: preservedSections };
state = core.evaluateRouteRenderState(route, sectionOnly, 0.5);
assert.equal(state[0].opacityMultiplier, 0.5);
assert.equal(state[1].drawProgress, 1);

// Wipe is one cumulative route path rather than restarting per Section.
state = core.evaluateRouteRenderState(
  route,
  { wipeEnabled: true, wipeDelay: 0, wipeDuration: 10, routeSegmentAnimations: includedSections },
  5,
);
approximately(state[0].wipeProgress, 0, 'first Section remains at half-route wipe');
approximately(state[1].wipeProgress, 1 / 3, 'middle Section is partially wiped');
approximately(state[2].wipeProgress, 1, 'last Section is fully wiped first');

// Route-level vehicles traverse the same cumulative included path without Section restarts.
const routeVehicle = {
  vehicleEnabled: true,
  vehicleDelay: 0,
  vehicleDuration: 10,
  vehicleType: 'custom',
  vehicleAssetId: 'asset-vehicle',
  vehicleSize: 31,
  vehicleFollowDirection: true,
  vehicleOrientationOffset: 17,
};
state = core.evaluateRouteRenderState(
  route,
  { routeVehicle, routeSegmentAnimations: includedSections },
  2,
);
assert.equal(state.filter((section) => section.vehicleVisible).length, 1);
assert.ok(Math.abs(state[1].vehicleProgress - 1 / 6) < 1e-9, 'vehicle crosses into long Section by distance');
assert.equal(state[1].vehicleAssetId, 'asset-vehicle');
assert.equal(state[1].vehicleSize, 31);
assert.equal(state[1].vehicleOrientationOffset, 17);
const repeatedVehicle = { ...routeVehicle, vehicleType: 'directional-capsule', vehicleRepetitive: true, vehicleInterval: 2 };
state = core.evaluateRouteRenderState(
  route,
  { routeVehicle: repeatedVehicle, routeSegmentAnimations: includedSections },
  3,
);
assert.equal(
  state.reduce((count, section) => count + section.vehicleInstances.length, 0),
  2,
  'Route-level repetition launches whole-route traversals',
);

// A 12-second route event crosses three 5-second Transitions without resetting.
const project = core.createProject('Route continuity');
project.layers = [route];
project.views = Array.from({ length: 4 }, (_, index) => {
  const view = core.createView(`View ${index + 1}`, index === 0 ? [] : [route], { x: 0, y: 0, zoom: 1 }, [route]);
  view.id = `view-${index + 1}`;
  view.holdDuration = 0;
  return view;
});
project.transitions = project.views.slice(0, -1).map((view, index) => {
  const transition = core.createTransition(view.id, project.views[index + 1].id, [route], view);
  transition.id = `transition-${index + 1}`;
  transition.duration = 5;
  transition.layerConfigs[route.id] = {
    included: true,
    animation:
      index === 0
        ? { ...routeDraw, appearDelay: 2, appearDuration: 12 }
        : { routeSegmentAnimations: structuredClone(includedSections) },
  };
  return transition;
});
assert.equal(core.evaluateProjectAtTime(project, 5).layers[0].routeRenderState[0].drawProgress, 1);
assert.ok(core.evaluateProjectAtTime(project, 10).layers[0].routeRenderState[1].drawProgress > 0);
assert.ok(core.evaluateProjectAtTime(project, 13).layers[0].routeRenderState[2].drawProgress > 0);
const direct = core.evaluateProjectAtTime(project, 10);
core.evaluateProjectAtTime(project, 4);
assert.deepEqual(core.evaluateProjectAtTime(project, 10), direct, 'direct/reverse seek is stateless');

const reopened = core.parseProjectFile(JSON.stringify(project));
assert.equal(reopened.transitions[0].layerConfigs[route.id].animation.appearType, 'draw-route');
assert.equal(reopened.transitions[0].layerConfigs[route.id].animation.appearDuration, 12);

const legacyProject = structuredClone(project);
delete legacyProject.transitions[0].layerConfigs[route.id].animation.appearEnabled;
delete legacyProject.transitions[0].layerConfigs[route.id].animation.appearType;
delete legacyProject.transitions[0].layerConfigs[route.id].animation.appearDelay;
delete legacyProject.transitions[0].layerConfigs[route.id].animation.appearDuration;
const legacyReopened = core.parseProjectFile(JSON.stringify(legacyProject));
assert.deepEqual(
  legacyReopened.transitions[0].layerConfigs[route.id].animation.routeSegmentAnimations,
  legacyProject.transitions[0].layerConfigs[route.id].animation.routeSegmentAnimations,
  'old Section-only projects retain their timeline state',
);

const withHold = structuredClone(project);
withHold.views[1].holdDuration = 3;
assert.equal(core.compileTimeline(withHold).segments[1].kind, 'view');
assert.ok(
  core.evaluateProjectAtTime(withHold, 6).layers[0].routeRenderState[1].drawProgress > 0,
  'positive Hold advances the same Route-level event',
);

project.transitions[0].layerConfigs[route.id].animation.routeVehicle = structuredClone(routeVehicle);
const vehicleRoundTrip = core.parseProjectFile(JSON.stringify(project));
assert.deepEqual(
  vehicleRoundTrip.transitions[0].layerConfigs[route.id].animation.routeVehicle,
  routeVehicle,
  'Route-level vehicle controls persist',
);
const staleExperiment = structuredClone(project);
staleExperiment.transitions[0].layerConfigs[route.id].animation.routeViewToView = true;
const staleReopened = core.parseProjectFile(JSON.stringify(staleExperiment));
assert.ok(
  !('routeViewToView' in staleReopened.transitions[0].layerConfigs[route.id].animation),
  'obsolete View-To-View data is safely dropped',
);

const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
const routeHeading = app.indexOf('Route · Actual Seconds');
const sectionHeading = app.indexOf('Route Section Usage', routeHeading);
assert.ok(routeHeading >= 0 && sectionHeading > routeHeading, 'Route-level controls precede Section controls');
for (const token of ['Draw Route', 'Appear Delay', 'Appear Duration', 'Wipe Out'])
  assert.ok(app.indexOf(token, routeHeading) < sectionHeading, `${token} exists in the Route-level block`);
assert.doesNotMatch(app, /View-To-View/, 'obsolete control is absent from the Inspector');

console.log('Route-level appearance: cumulative Draw/Wipe, precedence, continuity, seek, and persistence passed.');
