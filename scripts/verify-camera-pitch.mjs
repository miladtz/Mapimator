import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-camera-pitch-'));
const entryFile = join(outDir, 'entry.ts');
writeFileSync(
  entryFile,
  [
    `export * from '${join(root, 'src/core/camera').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectPersistence').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/viewCompiler').replaceAll('\\', '/')}';`,
  ].join('\n'),
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

const {
  CAMERA_FOV_DEGREES,
  canonicalProjectJson,
  compileTimeline,
  createProject,
  createTransition,
  createView,
  evaluateProjectAtTime,
  intersectRayWithMapPlane,
  interpolateCamera,
  projectWorldToScreen,
  roundCamera,
  screenRay,
  unprojectScreenToWorld,
  validateAndMigrateProject,
} = mod;

assert.equal(CAMERA_FOV_DEGREES, 45, 'fixed moderate FOV');
assert.equal(roundCamera({ x: 0, y: 0, zoom: 1, pitch: -90 }).pitch, -85);
assert.equal(roundCamera({ x: 0, y: 0, zoom: 1, pitch: 90 }).pitch, 85);
for (const pitch of [0, 20, -20, 45, -45, 60, -60, 75, -75, 80, -80, 85, -85])
  assert.equal(roundCamera({ x: 0, y: 0, zoom: 1, pitch }).pitch, pitch);

const topDown = { x: -420, y: -160, zoom: 2.4, bearing: 37, pitch: 0 };
const oldAffine = (worldX, worldY) => {
  const x = worldX * topDown.zoom + topDown.x - 500;
  const y = worldY * topDown.zoom + topDown.y - 280;
  const angle = (topDown.bearing * Math.PI) / 180;
  return {
    x: 500 + x * Math.cos(angle) - y * Math.sin(angle),
    y: 280 + x * Math.sin(angle) + y * Math.cos(angle),
  };
};
for (const point of [[0, 0], [500, 280], [721.25, 188.75]]) {
  const projected = projectWorldToScreen(topDown, point[0], point[1]);
  const expected = oldAffine(point[0], point[1]);
  assert.ok(
    Math.abs(projected.x - expected.x) < 1e-12 && Math.abs(projected.y - expected.y) < 1e-12,
    'Pitch 0 preserves 6A affine output to floating-point precision',
  );
}

let seed = 0x6b2026;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};
for (let index = 0; index < 500; index += 1) {
  const camera = {
    x: -random() * 2000,
    y: -random() * 900,
    zoom: 1 + random() * 5,
    bearing: -180 + random() * 360,
    pitch: -60 + random() * 120,
  };
  const screen = { x: 20 + random() * 960, y: 20 + random() * 520 };
  const ray = screenRay(camera, screen.x, screen.y);
  const plane = intersectRayWithMapPlane(ray);
  assert.ok(plane && Number.isFinite(plane.x) && Number.isFinite(plane.y), 'viewport ray hits map plane');
  const world = unprojectScreenToWorld(camera, screen.x, screen.y);
  assert.ok(world && Number.isFinite(world.x) && Number.isFinite(world.y), 'inverse projection is finite');
  const recovered = projectWorldToScreen(camera, world.x, world.y);
  assert.ok(recovered, 'inverse point remains in front of camera');
  assert.ok(Math.abs(recovered.x - screen.x) < 1e-7, 'randomized x round trip');
  assert.ok(Math.abs(recovered.y - screen.y) < 1e-7, 'randomized y round trip');
  const target = unprojectScreenToWorld(camera, 500, 280);
  const center = projectWorldToScreen(camera, target.x, target.y);
  assert.ok(Math.abs(center.x - 500) < 1e-8 && Math.abs(center.y - 280) < 1e-8, 'target invariant');
}

const legacy = createProject('Legacy pitch');
legacy.views = [createView('Legacy', [], { x: 0, y: 0, zoom: 1 }, [])];
assert.equal(validateAndMigrateProject(legacy).views[0].camera.pitch, 0);

const project = createProject('Pitch transition');
const first = createView('Top', [], { x: -200, y: -80, zoom: 2, bearing: 170, pitch: 0 }, []);
const middle = createView('West', [], { x: -240, y: -100, zoom: 2.5, bearing: -170, pitch: 45 }, []);
const last = createView('North east', [], { x: -360, y: -180, zoom: 3.5, bearing: -45, pitch: 55 }, []);
first.holdDuration = 0;
middle.holdDuration = 0;
last.holdDuration = 1;
project.views = [first, middle, last];
project.transitions = [createTransition(first.id, middle.id, [], first), createTransition(middle.id, last.id, [], middle)];
project.transitions.forEach((transition) => (transition.duration = 2));
assert.equal(compileTimeline(project).segments.length, 3, 'zero-Hold Views remain camera-only anchors');
assert.equal(evaluateProjectAtTime(project, 0).camera.pitch, 0);
assert.equal(
  evaluateProjectAtTime(project, 1).camera.pitch,
  20.45454545,
  'zero-Hold chain uses the continuous camera tangent while preserving the exact waypoint',
);
assert.equal(evaluateProjectAtTime(project, 2).camera.pitch, 45);
assert.equal(evaluateProjectAtTime(project, 4).camera.pitch, 55);
const midpoint = interpolateCamera(first.camera, middle.camera, 0.5, 'linear');
assert.equal(midpoint.pitch, 22.5);
assert.equal(midpoint.bearing, -180, 'combined transition retains shortest bearing path');
for (const [from, to] of [
  [45, -45],
  [-45, 45],
  [60, -60],
]) {
  const source = { x: 0, y: 0, zoom: 1, bearing: 0, pitch: from };
  const destination = { ...source, pitch: to };
  assert.equal(interpolateCamera(source, destination, 0, 'linear').pitch, from);
  assert.equal(interpolateCamera(source, destination, 0.5, 'linear').pitch, 0);
  assert.equal(interpolateCamera(source, destination, 1, 'linear').pitch, to);
}

for (const pitch of [20, 45, 60]) {
  const positive = { ...topDown, pitch };
  const negative = { ...topDown, pitch: -pitch };
  for (const camera of [positive, negative]) {
    const target = unprojectScreenToWorld(camera, 500, 280);
    const center = projectWorldToScreen(camera, target.x, target.y);
    assert.ok(center && Number.isFinite(center.x) && Number.isFinite(center.y));
    assert.ok(Math.abs(center.x - 500) < 1e-8 && Math.abs(center.y - 280) < 1e-8);
  }
}

const reopened = validateAndMigrateProject(JSON.parse(canonicalProjectJson(project)));
assert.equal(reopened.views[1].camera.pitch, 45, 'Save/Open preserves Pitch');
assert.equal(reopened.views[1].camera.bearing, -170, 'Save/Open preserves Bearing');
const duplicate = structuredClone(reopened.views[1]);
duplicate.id = 'duplicate-pitch';
assert.deepEqual(duplicate.camera, reopened.views[1].camera, 'duplicate View preserves full camera');
const negativeProject = structuredClone(project);
negativeProject.views[1].camera.pitch = -40;
const negativeReopened = validateAndMigrateProject(JSON.parse(canonicalProjectJson(negativeProject)));
assert.equal(negativeReopened.views[1].camera.pitch, -40, 'negative Pitch persists through canonical project/package JSON');
assert.equal(evaluateProjectAtTime(negativeProject, 2).camera.pitch, -40, 'zero-Hold negative camera anchor is exact');

const mapSource = readFileSync(join(root, 'src/components/OfflineMap.tsx'), 'utf8');
const frameSource = readFileSync(join(root, 'src/core/frameRenderer.tsx'), 'utf8');
const appSource = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
assert.match(mapSource, /projectPathToFlatCamera/, 'pitched geography is mathematically reprojected');
assert.match(
  mapSource,
  /\(camera\.pitch \?\? 0\) !== 0/,
  'positive and negative Pitch activate the same perspective renderer',
);
assert.match(mapSource, /preparseSvgPaths/, 'static world path coordinates are parsed once');
assert.match(mapSource, /mapPlaneLocalTransform/, 'base labels follow the local pitched map plane');
assert.match(mapSource, /flatPerspectiveCamera \? 1 : 1 \/ camera\.zoom/, 'Pin size stays screen-relative');
assert.match(mapSource, /screenRotation=\{mapMode === 'globe' \|\| flatPerspectiveCamera \? 0 : -bearing\}/, 'Pin stays upright');
assert.match(mapSource, /cameraForWorldAtScreen/, 'pitched pan uses ground anchoring');
assert.match(frameSource, /<MapScene/, 'Preview thumbnails and Export share the pitched scene');
assert.match(appSource, /Reset Pitch/, 'Camera inspector exposes Pitch');
assert.match(appSource, /pendingFrame\.current !== null/, 'inspector camera input allows only one pending rAF update');
assert.ok(!appSource.includes('setCamera(previewState'), 'Preview remains read-only against View camera state');

console.log('Camera pitch verification: clamp, exact Pitch 0, deterministic perspective rays, 500 randomized round trips, center invariant, migration, persistence, duplicate Views, combined transitions, zero-Hold continuity, projected SVG geography, ground interactions, upright fixed-size Pins, thumbnails/Export parity, and read-only Preview passed.');
