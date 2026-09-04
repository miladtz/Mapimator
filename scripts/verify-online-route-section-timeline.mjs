import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'route-section-timeline-'));
const entry = join(out, 'entry.ts');
const source = (value) => join(root, value).replaceAll('\\', '/');
writeFileSync(
  entry,
  `export * from '${source('src/core/routes')}'; export { createProject, reconcileRouteSectionTimelineUsage, viewLayersOf } from '${source('src/core/project')}'; export { evaluateProjectAtTime } from '${source('src/core/viewCompiler')}'; export { serializeCanonicalProject, parseProjectFile } from '${source('src/core/projectFile')}'; export { onlineRouteFeatureCollection } from '${source('src/core/onlineProjectOverlays')}';`,
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
      lib: { entry, formats: ['es'], fileName: () => 'module.mjs' },
    },
  });
  core = await import(pathToFileURL(join(out, 'module.mjs')).href);
} finally {
  rmSync(out, { recursive: true, force: true });
}

const points = [
  { id: 'a', name: 'A', longitude: 0, latitude: 0 },
  { id: 'b', name: 'B', longitude: 1, latitude: 0 },
  { id: 'c', name: 'C', longitude: 11, latitude: 0 },
  { id: 'd', name: 'D', longitude: 21, latitude: 0 },
];
const layer = core.createRouteLayer(points);
const ids = layer.routeSegments.map((section) => section.id);

let animation = core.setAllRouteSectionsIncluded(undefined, ids, true);
assert.equal(core.routeParentIncludedFromSections(animation, ids, false), true);
animation = core.patchRouteSectionTimelineUsage(animation, ids[1], { included: false });
assert.deepEqual(
  ids.map((id) => core.routeSectionTimelineUsage(animation, id, true).included),
  [true, false, true],
);
assert.equal(core.routeParentIncludedFromSections(animation, ids, true), true);
animation = core.patchRouteSectionTimelineUsage(animation, ids[0], { included: false });
animation = core.patchRouteSectionTimelineUsage(animation, ids[2], { included: false });
assert.equal(core.routeParentIncludedFromSections(animation, ids, true), false);
assert.ok(
  ids.every(
    (id) =>
      !core.routeSectionTimelineUsage(core.setAllRouteSectionsIncluded(animation, ids, false), id, true)
        .included,
  ),
);
assert.ok(
  ids.every(
    (id) =>
      core.routeSectionTimelineUsage(core.setAllRouteSectionsIncluded(animation, ids, true), id, false)
        .included,
  ),
);

animation = core.patchRouteSectionTimelineUsage(animation, ids[1], {
  included: true,
  appearEnabled: true,
  appearType: 'draw-route',
  appearDelay: 1,
  appearDuration: 4,
  wipeEnabled: true,
  wipeDelay: 7,
  wipeDuration: 2,
  vehicleEnabled: false,
});
for (const sourceId of ids) {
  const sourceAnimation = core.patchRouteSectionTimelineUsage(animation, sourceId, {
    included: sourceId !== ids[0],
    appearEnabled: true,
    appearType: sourceId === ids[2] ? 'drop' : 'draw-route',
  });
  const copied = core.applyRouteSectionTimelineToAll(sourceAnimation, ids, sourceId, true);
  const expected = core.routeSectionTimelineUsage(sourceAnimation, sourceId, true);
  assert.ok(
    ids.every(
      (id) => JSON.stringify(core.routeSectionTimelineUsage(copied, id, true)) === JSON.stringify(expected),
    ),
  );
}

const draw = core.evaluateRouteRenderState(layer, animation, 3)[1];
assert.equal(draw.exists, true);
assert.equal(draw.drawProgress, 0.5);
assert.equal(draw.opacityMultiplier, 1);
const fadeAnimation = core.patchRouteSectionTimelineUsage(undefined, ids[0], {
  included: true,
  appearEnabled: true,
  appearType: 'fade',
  appearDuration: 4,
});
assert.equal(core.evaluateRouteRenderState(layer, fadeAnimation, 2)[0].opacityMultiplier, 0.5);
const vehicleAnimation = core.patchRouteSectionTimelineUsage(undefined, ids[0], {
  included: true,
  vehicleEnabled: true,
  vehicleDelay: 0,
  vehicleDuration: 1,
  vehicleType: 'directional-capsule',
});
const vehicleAtDestination = core.evaluateRouteRenderState(layer, vehicleAnimation, 3)[0];
assert.equal(vehicleAtDestination.vehicleVisible, true);
assert.equal(vehicleAtDestination.vehicleProgress, 1);
const hiddenAnimation = core.setAllRouteSectionsIncluded(undefined, ids, false);
const evaluated = structuredClone(layer);
core.applyRouteEvaluation(evaluated, hiddenAnimation, 0);
assert.equal(
  core
    .onlineRouteFeatureCollection([evaluated])
    .features.filter((feature) => feature.properties.role === 'line').length,
  0,
);

let project = core.createProject('Section timeline');
project.layers = [layer];
project.views = [
  {
    id: 'view-1',
    name: 'One',
    holdDuration: 4,
    camera: { x: 0, y: 0, zoom: 1 },
    mapMode: 'flat',
    layerConfigs: { [layer.id]: { included: true, animation } },
    thumbnailColor: '#000',
  },
  {
    id: 'view-2',
    name: 'Two',
    holdDuration: 0,
    camera: { x: 0, y: 0, zoom: 1 },
    mapMode: 'flat',
    layerConfigs: { [layer.id]: { included: false, animation: hiddenAnimation } },
    thumbnailColor: '#000',
  },
];
project.transitions = [
  {
    id: 'transition-1',
    fromViewId: 'view-1',
    toViewId: 'view-2',
    duration: 2,
    referenceDuration: 2,
    speed: 1,
    timingSource: 'duration',
    preset: 'linear',
    type: 'smooth',
    layerConfigs: { [layer.id]: { included: true, animation } },
  },
];
const reopened = core.parseProjectFile(core.serializeCanonicalProject(project).json);
assert.deepEqual(
  reopened.views[0].layerConfigs[layer.id].animation.routeSegmentAnimations,
  animation.routeSegmentAnimations,
);
assert.equal(reopened.views[1].layerConfigs[layer.id].included, false);
assert.notDeepEqual(reopened.views[0].layerConfigs[layer.id], reopened.views[1].layerConfigs[layer.id]);

const vehicleProject = structuredClone(project);
vehicleProject.views[0].layerConfigs[layer.id] = { included: true, animation: vehicleAnimation };
const playbackState = core.evaluateProjectAtTime(vehicleProject, 3);
const playbackVehicles = core
  .onlineRouteFeatureCollection(playbackState.layers)
  .features.filter((feature) => feature.properties.role === 'vehicle');
assert.equal(playbackVehicles.length, 1, 'enabled Section vehicle must remain visible in Playback');
const exportState = core.evaluateProjectAtTime(vehicleProject, 3);
assert.deepEqual(
  core.onlineRouteFeatureCollection(exportState.layers),
  core.onlineRouteFeatureCollection(playbackState.layers),
  'Export and Playback must consume identical deterministic Section evaluation',
);

const resolvedLayers = core.viewLayersOf(vehicleProject, vehicleProject.views[0]);
assert.equal(
  resolvedLayers[0].routeSegments[0].geometry,
  vehicleProject.layers[0].routeSegments[0].geometry,
  'playback snapshots must preserve immutable geometry references for metric caching',
);
const performanceStarted = performance.now();
for (let frame = 0; frame < 180; frame += 1)
  core.onlineRouteFeatureCollection(core.evaluateProjectAtTime(vehicleProject, frame / 60).layers);
const performanceMs = performance.now() - performanceStarted;
assert.ok(performanceMs < 1000, `180-frame three-Section evaluation took ${performanceMs.toFixed(1)}ms`);
const denseRoute = structuredClone(layer);
denseRoute.routeSegments = denseRoute.routeSegments.map((section, sectionIndex) => ({
  ...section,
  geometry: Array.from({ length: 4000 }, (_, pointIndex) => [
    sectionIndex * 20 + pointIndex / 200,
    Math.sin(pointIndex / 80) * 4,
  ]),
}));
const legacyCloneStarted = performance.now();
for (let frame = 0; frame < 180; frame += 1) structuredClone(denseRoute);
const legacyCloneMs = performance.now() - legacyCloneStarted;
const referenceSnapshotStarted = performance.now();
for (let frame = 0; frame < 180; frame += 1) ({ ...denseRoute, visible: true });
const referenceSnapshotMs = performance.now() - referenceSnapshotStarted;
assert.ok(
  referenceSnapshotMs < legacyCloneMs,
  `reference snapshots ${referenceSnapshotMs.toFixed(1)}ms must beat deep clones ${legacyCloneMs.toFixed(1)}ms`,
);

const replacementIds = [ids[1], 'new-section'];
const reconciled = core.reconcileRouteSectionTimelineUsage(project, layer.id, replacementIds);
const reconciledMap = reconciled.views[0].layerConfigs[layer.id].animation.routeSegmentAnimations;
assert.deepEqual(Object.keys(reconciledMap), replacementIds);
assert.deepEqual(reconciledMap[ids[1]], animation.routeSegmentAnimations[ids[1]]);
assert.equal(reconciledMap['new-section'].included, true);

const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
for (const token of [
  'Route Section Usage',
  'Exists in this',
  'Draw Route',
  'Apply to all sections',
  'onSetDerivedMembership',
  'Layer exists in this',
])
  assert.ok(app.includes(token), `missing timeline UI token: ${token}`);

console.log(
  `Online Route Section Timeline: parent/child existence, vehicle Playback/Export parity, cumulative Draw/Wipe, persistence, and stable geometry caching passed; 180 frames evaluated in ${performanceMs.toFixed(1)}ms; dense legacy clones ${legacyCloneMs.toFixed(1)}ms vs reference snapshots ${referenceSnapshotMs.toFixed(1)}ms.`,
);
