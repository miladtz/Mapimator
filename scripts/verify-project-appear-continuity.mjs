import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'mapmotion-appear-continuity-'));
const entry = join(out, 'entry.ts');
const source = (value) => join(root, value).replaceAll('\\', '/');
writeFileSync(
  entry,
  `export * from '${source('src/core/project')}'; export * from '${source('src/core/shapes')}'; export * from '${source('src/core/routes')}'; export * from '${source('src/core/viewCompiler')}';`,
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

const camera = { x: 0, y: 0, zoom: 1 };
const makeFourViewProject = (layers, firstAnimation, overrides = {}) => {
  const project = core.createProject('Cross-segment Appear');
  project.layers = layers;
  project.views = Array.from({ length: 4 }, (_, index) => {
    const view = core.createView(`View ${index + 1}`, index === 0 ? [] : layers, camera, layers);
    view.id = `view-${index + 1}`;
    view.holdDuration = overrides.holds?.[index] ?? 0;
    return view;
  });
  project.transitions = project.views.slice(0, -1).map((view, index) => {
    const transition = core.createTransition(view.id, project.views[index + 1].id, layers, view);
    transition.id = `transition-${index + 1}`;
    transition.duration = overrides.transitionDurations?.[index] ?? 5;
    for (const layer of layers) {
      transition.layerConfigs[layer.id] = {
        included: overrides.excluded?.[index]?.includes(layer.id) !== true,
        animation: index === 0 ? structuredClone(firstAnimation(layer)) : {},
      };
    }
    return transition;
  });
  return project;
};

const shape = core.createShapeLayerAt('polyline', 300, 250);
const arrow = core.createShapeLayerAt('arrow', 400, 260);
const text = core.createLayer('text');
const pin = core.createLayer('pin');
const region = core.createLayer('region');
const route = core.createRouteLayer([
  { id: 'a', name: 'A', longitude: 0, latitude: 0 },
  { id: 'b', name: 'B', longitude: 10, latitude: 5 },
]);
const routeSectionId = route.routeSegments[0].id;
const layers = [shape, arrow, text, pin, region, route];
const animationFor = (layer) => ({
  appearEnabled: true,
  appearType: layer.type === 'shape' ? 'draw-shape' : layer.type === 'route' ? 'draw-route' : 'fade',
  appearDelay: 4,
  appearDuration: 10,
  ...(layer.type === 'route'
    ? {
        routeSegmentAnimations: {
          [routeSectionId]: {
            included: true,
            appearEnabled: true,
            appearType: 'draw-route',
            appearDelay: 4,
            appearDuration: 10,
          },
        },
      }
    : {}),
});
const project = makeFourViewProject(layers, animationFor);

const expected = new Map([
  [3.9, 0],
  [4, 0],
  [5, 0.1],
  [7.5, 0.35],
  [10, 0.6],
  [12, 0.8],
  [14, 1],
  [15, 1],
]);
for (const [time, progress] of expected) {
  const state = core.evaluateProjectAtTime(project, time);
  for (const layer of state.layers.filter((candidate) => candidate.type !== 'route')) {
    assert.ok(Math.abs((layer.pinSceneOpacity ?? 1) - progress) < 1e-9, `${layer.type} progress at t=${time}`);
  }
  const routeState = state.layers.find((layer) => layer.id === route.id)?.routeRenderState?.[0];
  assert.ok(routeState, `Route exists at t=${time}`);
  assert.ok(Math.abs(routeState.drawProgress - progress) < 1e-9, `Route Draw progress at t=${time}`);
}
assert.equal(core.evaluateProjectAtTime(project, 7.5).layers.find((layer) => layer.id === shape.id).shapePathProgress, 0.35);
assert.equal(core.evaluateProjectAtTime(project, 12).layers.find((layer) => layer.id === arrow.id).shapePathProgress, 0.8);

// Shape11 timing reproduction: 5s Transitions, delay 3.5s, duration 10s.
const shape11 = makeFourViewProject([arrow], () => ({
  appearEnabled: true,
  appearType: 'draw-shape',
  appearDelay: 3.5,
  appearDuration: 10,
}));
assert.equal(core.evaluateProjectAtTime(shape11, 10).layers[0].shapePathProgress, 0.65);
assert.equal(core.evaluateProjectAtTime(shape11, 13.5).layers[0].shapePathProgress, 1);

// Direct/reverse/repeated seek is reconstructed solely from project data.
const direct = core.evaluateProjectAtTime(project, 12);
core.evaluateProjectAtTime(project, 7);
assert.deepEqual(core.evaluateProjectAtTime(project, 12), direct);
assert.deepEqual(core.evaluateProjectAtTime(project, 12), direct);

// Zero-Hold Views contribute no time and do not start/reset their authored event.
project.views[1].layerConfigs[shape.id].animation = {
  appearEnabled: true,
  appearType: 'pop',
  appearDelay: 0,
  appearDuration: 1,
};
assert.equal(core.evaluateProjectAtTime(project, 7.5).layers.find((layer) => layer.id === shape.id).shapePathProgress, 0.35);

// Positive Hold is canonical elapsed project time.
const holdProject = makeFourViewProject([pin], animationFor, { holds: [0, 3, 0, 0] });
assert.equal(core.evaluateProjectAtTime(holdProject, 6).layers[0].opacity, 0.2);
assert.equal(core.evaluateProjectAtTime(holdProject, 8).layers[0].opacity, 0.4);

// A later explicit event overrides the older event from the new entity start.
const override = makeFourViewProject([text], animationFor);
override.transitions[2].layerConfigs[text.id].animation = {
  appearEnabled: true,
  appearType: 'fade',
  appearDelay: 2,
  appearDuration: 4,
};
assert.equal(core.evaluateProjectAtTime(override, 10).layers[0].opacity, 0);
assert.equal(core.evaluateProjectAtTime(override, 11).layers[0].opacity, 0);
assert.equal(core.evaluateProjectAtTime(override, 13).layers[0].opacity, 0.25);

// Membership remains authoritative and an excluded interval does not invent resume behavior.
const excluded = makeFourViewProject([pin], animationFor, { excluded: { 1: [pin.id] } });
assert.equal(core.evaluateProjectAtTime(excluded, 7).layers.length, 0);
assert.equal(core.evaluateProjectAtTime(excluded, 12).layers[0].opacity, 1);

// Timeline duration edits need no cache invalidation: starts are recompiled each evaluation.
const edited = structuredClone(project);
edited.transitions[0].duration = 6;
assert.equal(core.compileTimeline(edited).segments[1].start, 6);
assert.equal(core.evaluateProjectAtTime(edited, 12).layers.find((layer) => layer.id === pin.id).opacity, 0.8);

console.log('Project-level Appear continuity across Transitions, Holds, seeks, and layer types passed.');
