import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-globe-exploration-'));
const entryFile = join(outDir, 'entry.ts');
writeFileSync(
  entryFile,
  [
    `export * from '${join(root, 'src/core/globeMath').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/camera').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectPersistence').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/viewCompiler').replaceAll('\\', '/')}';`,
  ].join('\n'),
);
let m;
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
  m = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const close = (a, b, tolerance = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} ~= ${b}`);
const vectorClose = (a, b, tolerance = 1e-9) => a.forEach((value, index) => close(value, b[index], tolerance));
const quaternionClose = (a, b, tolerance = 1e-9) => {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const sign = dot < 0 ? -1 : 1;
  for (const key of ['x', 'y', 'z', 'w']) close(a[key], b[key] * sign, tolerance);
};

// Geographic local frame, including deterministic exact-pole behavior.
for (const latitude of [0, 45, 80, 89.9, 90, -89.9, -90]) {
  const normal = m.lonLatToSphere(37, latitude);
  const frame = m.localGlobeFrame(normal);
  close(Math.hypot(...frame.normal), 1);
  close(Math.hypot(...frame.east), 1);
  close(Math.hypot(...frame.north), 1);
  close(m.dot3(frame.normal, frame.east), 0);
  close(m.dot3(frame.normal, frame.north), 0);
  close(m.dot3(frame.east, frame.north), 0);
  vectorClose(m.cross3(frame.east, frame.north), frame.normal);
  assert.ok([...frame.normal, ...frame.east, ...frame.north].every(Number.isFinite));
}

const start = m.normalizeQuaternion({ x: 0.19, y: -0.31, z: 0.11, w: 0.91 });
close(Math.hypot(start.x, start.y, start.z, start.w), 1);
const identity = { x: 0, y: 0, z: 0, w: 1 };
const width = 1280, height = 720;
const contactDrag = (camera, from, to, extendToRim = true) => {
  const matrices = m.globeCameraMatrices(camera, width, height);
  const startContact = m.globeScreenContact(matrices, from.x, from.y, false);
  const currentContact = m.globeScreenContact(matrices, to.x, to.y, extendToRim);
  assert.ok(startContact && currentContact, 'frozen camera rays produce trackball contacts');
  const delta = m.quaternionBetweenVectors(startContact.world, currentContact.world);
  const orientation = m.multiplyQuaternions(delta, m.globeOrientationOf(camera));
  const projected = m.projectGlobeObjectPoint(matrices, orientation, startContact.object);
  return {
    orientation,
    startContact,
    currentContact,
    error: projected ? Math.hypot(projected.x - to.x, projected.y - to.y) : Number.POSITIVE_INFINITY,
  };
};

const center = { x: width / 2, y: height / 2 };
const drag = contactDrag(
  { x: 0, y: 0, zoom: 3, pitch: 0, globeOrientation: start },
  center,
  { x: center.x + 84, y: center.y - 51 },
).orientation;
close(Math.hypot(drag.x, drag.y, drag.z, drag.w), 1);
assert.notDeepEqual(drag, start, 'diagonal contact drag rotates the physical sphere');
assert.deepEqual(
  m.roundCamera({ x: 0, y: 0, zoom: 4, pitch: 37, globeOrientation: start }).globeOrientation,
  start,
  'Pitch/zoom rounding preserves Globe orientation exactly',
);

// Every move is derived from pointerdown. Intermediate events cannot alter the final result.
const fixedCamera = { x: 0, y: 0, zoom: 3, pitch: 28, globeOrientation: start };
const direct = contactDrag(fixedCamera, center, { x: center.x + 70, y: center.y + 42 });
contactDrag(fixedCamera, center, { x: center.x + 15, y: center.y + 8 });
contactDrag(fixedCamera, center, { x: center.x + 45, y: center.y + 24 });
quaternionClose(contactDrag(fixedCamera, center, { x: center.x + 70, y: center.y + 42 }).orientation, direct.orientation);

// The grabbed point follows the pointer across Pitch, zoom, arbitrary orientation and pole-facing starts.
const representativeErrors = [];
const orientations = [
  identity,
  start,
  m.quaternionBetweenVectors(m.lonLatToSphere(0, 90), [1, 0, 0]),
  m.quaternionBetweenVectors(m.lonLatToSphere(0, -90), [1, 0, 0]),
];
for (const globeOrientation of orientations)
  for (const pitch of [-60, 0, 60])
    for (const zoom of [1, 3, 6])
      for (const offset of [[45, 0], [0, -45], [38, 31]]) {
        const result = contactDrag(
          { x: 0, y: 0, zoom, pitch, globeOrientation },
          center,
          { x: center.x + offset[0], y: center.y + offset[1] },
        );
        if (result.currentContact.onSphere) {
          representativeErrors.push(result.error);
          assert.ok(result.error < 0.08, `grabbed contact follows pointer (${result.error}px)`);
        } else {
          assert.ok(result.error < 90, `near-rim continuation remains bounded (${result.error}px)`);
        }
        close(Math.hypot(result.orientation.x, result.orientation.y, result.orientation.z, result.orientation.w), 1);
      }

// Rim continuation is finite and bounded when pointer capture leaves the silhouette.
const rim = contactDrag(fixedCamera, center, { x: width - 1, y: 1 }, true);
assert.equal(rim.currentContact.onSphere, false);
assert.ok(Number.isFinite(rim.error));
close(Math.hypot(rim.orientation.x, rim.orientation.y, rim.orientation.z, rim.orientation.w), 1);

// Long exploration remains normalized and finite.
let longOrientation = identity;
for (let index = 0; index < 128; index += 1) {
  const result = contactDrag(
    { x: 0, y: 0, zoom: 1 + (index % 6), pitch: -60 + (index % 121), globeOrientation: longOrientation },
    center,
    { x: center.x + ((index * 37) % 81) - 40, y: center.y + ((index * 53) % 81) - 40 },
  );
  longOrientation = result.orientation;
  assert.ok(Object.values(longOrientation).every(Number.isFinite));
  close(Math.hypot(longOrientation.x, longOrientation.y, longOrientation.z, longOrientation.w), 1);
}

// Pitch moves only the observer; zoom changes only camera distance.
for (const pitch of [-60, 0, 60]) {
  const camera = { x: 0, y: 0, zoom: 3, pitch, globeOrientation: start };
  const matrices = m.globeCameraMatrices(camera, 1280, 720);
  quaternionClose(matrices.orientation, start);
  vectorClose(matrices.target, [1, 0, 0]);
}
assert.ok(m.globeDistanceForZoom(1) > m.globeDistanceForZoom(3));
assert.ok(m.globeDistanceForZoom(3) > m.globeDistanceForZoom(6));

// Reset is canonical identity and does not imply a Pitch/zoom change.
quaternionClose(m.normalizeQuaternion({ x: 0, y: 0, z: 0, w: 0 }), identity);

// Shortest normalized SLERP, including q/-q equivalence.
quaternionClose(m.slerpQuaternion(start, { x: -start.x, y: -start.y, z: -start.z, w: -start.w }, 0.5), start);
for (const t of [0, 0.1, 0.5, 0.9, 1]) {
  const value = m.slerpQuaternion(start, drag, t);
  close(Math.hypot(value.x, value.y, value.z, value.w), 1);
}

// View/persistence/package-JSON shape and deterministic Preview/Export evaluator state.
const project = m.createProject('Physical Globe');
const a = m.createView('A', [], { x: 0, y: 0, zoom: 2, pitch: -40, globeOrientation: start }, [], 'globe');
const b = m.createView('B', [], { x: 0, y: 0, zoom: 5, pitch: 50, globeOrientation: drag }, [], 'globe');
a.holdDuration = 0;
b.holdDuration = 1;
const transition = m.createTransition(a.id, b.id, [], a);
transition.duration = 2;
transition.preset = 'linear';
project.views = [a, b];
project.transitions = [transition];
const migrated = m.validateAndMigrateProject(JSON.parse(JSON.stringify(project)));
quaternionClose(migrated.views[0].camera.globeOrientation, start);
quaternionClose(structuredClone(migrated.views[1]).camera.globeOrientation, drag);
const midpoint = m.evaluateProjectAtTime(migrated, 1);
assert.equal(midpoint.mapMode, 'globe');
close(midpoint.camera.pitch, 5);
close(midpoint.camera.zoom, Math.sqrt(10));
quaternionClose(midpoint.camera.globeOrientation, m.slerpQuaternion(start, drag, 0.5));
assert.deepEqual(m.evaluateProjectAtTime(migrated, 1), midpoint, 'Preview evaluator is deterministic');
assert.equal(m.compileTimeline(migrated).segments[0].kind, 'transition', 'zero-Hold View remains a camera anchor');

const globeSource = readFileSync(join(root, 'src/components/WebGLGlobe.tsx'), 'utf8');
const rendererSource = readFileSync(join(root, 'src/core/globeRenderer.ts'), 'utf8');
const frameSource = readFileSync(join(root, 'src/core/frameRenderer.tsx'), 'utf8');
assert.match(globeSource, /globeScreenContact/);
assert.match(globeSource, /quaternionBetweenVectors/);
assert.match(globeSource, /multiplyQuaternions\(delta, globeOrientationOf\(drag\.camera\)\)/);
assert.doesNotMatch(globeSource, /const onWheel[\s\S]{0,800}cameraWithTargetLonLat/);
assert.match(globeSource, /applyCameraWheel/);
assert.match(rendererSource, /u_orientation/);
assert.match(rendererSource, /geometryUploadCount = 1/);
assert.match(frameSource, /state\.camera/);

console.log(`Physical Globe exploration verification passed (max contact error ${Math.max(...representativeErrors).toFixed(4)}px).`);
