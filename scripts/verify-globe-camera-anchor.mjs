import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-globe-anchor-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/camera').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/globeMath').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectPersistence').replaceAll('\\', '/')}';`,
  ].join('\n'),
);
let m;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: { outDir, emptyOutDir: false, minify: false, lib: { entry, formats: ['es'], fileName: () => 'core.mjs' } },
  });
  m = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const closeVector = (actual, expected, tolerance = 1e-9) =>
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance));
const vectorOf = (focus) => [focus.x, focus.y, focus.z];
const focuses = [
  [-100, 39], // USA
  [2, 47], // France
  [53, 32], // Iran
  [138, 37], // Japan
  [134, -25], // Australia
];

for (const [lon, lat] of focuses) {
  const focusVector = m.lonLatToSphere(lon, lat);
  const orientation = m.quaternionFromAxisAngle([0, 1, 0], ((lon + 33) * Math.PI) / 180);
  let camera = m.roundCamera({
    x: 0,
    y: 0,
    zoom: 2.5,
    pitch: 0,
    globeOrientation: orientation,
    globeFocus: { x: focusVector[0], y: focusVector[1], z: focusVector[2] },
  });
  const originalFocus = vectorOf(camera.globeFocus);
  const originalOrientation = camera.globeOrientation;
  for (const operation of [
    [120, false],
    [-500, true],
    [500, true],
    [-240, false],
  ]) {
    const before = camera;
    camera = m.applyCameraWheel(camera, 'globe', operation[0], 0, operation[1], false).camera;
    closeVector(vectorOf(camera.globeFocus), originalFocus);
    assert.deepEqual(camera.globeOrientation, originalOrientation);
    if (operation[1]) assert.equal(camera.zoom, before.zoom, 'Pitch preserves distance/Zoom');
    else assert.equal(camera.pitch, before.pitch, 'Zoom preserves Pitch');
    const matrices = m.globeCameraMatrices(camera, 1920, 1080);
    const projected = m.projectGlobeObjectPoint(matrices, camera.globeOrientation, originalFocus);
    assert.ok(projected, 'stored focus remains visible');
    assert.ok(Math.abs(projected.x - 960) < 0.001 && Math.abs(projected.y - 540) < 0.001, 'focus stays centered');
    assert.ok([...matrices.viewProjection, ...matrices.inverseViewProjection, ...matrices.position].every(Number.isFinite));
    assert.ok(Math.hypot(...matrices.position) > 1, 'camera remains outside sphere');
  }
  for (const pitch of [-85, -80, -75, -60, -30, 0, 30, 60, 75, 80, 85]) {
    const pitched = m.roundCamera({ ...camera, pitch });
    assert.equal(pitched.pitch, pitch);
    closeVector(vectorOf(pitched.globeFocus), originalFocus);
    const matrices = m.globeCameraMatrices(pitched, 1000, 560);
    assert.ok([...matrices.viewProjection, ...matrices.inverseViewProjection].every(Number.isFinite));
  }
  for (let index = 0; index < 100; index += 1)
    camera = m.applyCameraWheel(camera, 'globe', index % 2 ? 80 : -80, 0, index % 3 === 0, false).camera;
  closeVector(vectorOf(camera.globeFocus), originalFocus);
}

const project = m.createProject('Globe anchor persistence');
const focus = m.lonLatToSphere(138, 37);
const camera = m.roundCamera({
  x: 0, y: 0, zoom: 3, pitch: 85,
  globeOrientation: m.quaternionFromAxisAngle([0, 1, 0], 1.2),
  globeFocus: { x: focus[0], y: focus[1], z: focus[2] },
});
project.views = [m.createView('Japan', [], camera, [], 'globe')];
const reopened = m.validateAndMigrateProject(JSON.parse(m.canonicalProjectJson(project)));
assert.deepEqual(reopened.views[0].camera.globeFocus, camera.globeFocus, 'Save/Open preserves focus');
assert.equal(reopened.views[0].camera.pitch, 85, 'Globe View validation accepts +85');
const duplicate = structuredClone(reopened.views[0]);
assert.deepEqual(duplicate.camera.globeFocus, camera.globeFocus, 'View duplication preserves focus');

const legacy = m.createProject('Legacy Globe');
const legacyCamera = { x: 0, y: 0, zoom: 2, pitch: 0, globeOrientation: camera.globeOrientation };
legacy.views = [m.createView('Legacy', [], legacyCamera, [], 'globe')];
const migrated = m.validateAndMigrateProject(legacy);
closeVector(vectorOf(migrated.views[0].camera.globeFocus), m.centralGlobePoint(camera.globeOrientation));

console.log('Globe camera anchor stability, persistence, centered projection, and ±85° safety passed.');
