import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-globe-foundation-'));
const entryFile = join(outDir, 'entry.ts');
writeFileSync(entryFile, [
  `export * from '${join(root, 'src/core/globeMath').replaceAll('\\', '/')}';`,
  `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
  `export * from '${join(root, 'src/core/projectPersistence').replaceAll('\\', '/')}';`,
  `export * from '${join(root, 'src/core/viewCompiler').replaceAll('\\', '/')}';`,
].join('\n'));
let m;
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir, emptyOutDir: false, minify: false, lib: { entry: entryFile, formats: ['es'], fileName: () => 'core.mjs' } } });
  m = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally { rmSync(outDir, { recursive: true, force: true }); }

const close = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) <= tolerance, `${a} ~= ${b}`);
for (const [lon, lat] of [[0, 0], [179.5, 72], [-123.4, -55.2], [45, 89]]) {
  const sphere = m.lonLatToSphere(lon, lat);
  close(Math.hypot(...sphere), 1);
  const roundTrip = m.sphereToLonLat(sphere);
  close(roundTrip.lon, lon); close(roundTrip.lat, lat);
}
assert.ok(m.lonLatToSphere(45, 0)[2] < 0, 'positive longitude maps to geographic east (-Z)');
for (const [targetLon, west, east] of [[-45, [-100, 38], [10, 48]], [45, [10, 48], [78, 22]], [108, [78, 22], [139, 36]], [77, [20, 5], [134, -25]]]) {
  const globeOrientation = m.quaternionBetweenVectors(m.lonLatToSphere(targetLon, 20), [1, 0, 0]);
  const camera = { x: 0, y: 0, zoom: 1, bearing: 0, pitch: 0, globeOrientation };
  const matrices = m.globeCameraMatrices(camera, 1200, 800);
  const left = m.projectGlobeLonLat(matrices, ...west), right = m.projectGlobeLonLat(matrices, ...east);
  assert.ok(left && right && left.x < right.x, `landmarks preserve west/east order around ${targetLon}°`);
}
for (const point of [[0, 0], [500, 280], [999, 559]]) {
  const geographic = m.worldToLonLat(...point);
  const recovered = m.lonLatToWorld(geographic.lon, geographic.lat);
  close(recovered.x, point[0]); close(recovered.y, point[1]);
}
assert.ok(m.globeDistanceForZoom(1) > m.globeDistanceForZoom(3));
assert.ok(m.globeDistanceForZoom(3) > m.globeDistanceForZoom(6));
for (const pitch of [-60, 0, 60]) for (const bearing of [-180, -45, 0, 135]) {
  const target = { lon: 53.7, lat: 32.4 };
  const globeOrientation = m.quaternionBetweenVectors(m.lonLatToSphere(target.lon, target.lat), [1, 0, 0]);
  const camera = { x: -500, y: -280, zoom: 2.5, bearing, pitch, globeOrientation };
  const matrices = m.globeCameraMatrices(camera, 1920, 1080);
  assert.ok([...matrices.viewProjection, ...matrices.inverseViewProjection, ...matrices.position].every(Number.isFinite));
  const projected = m.projectGlobeLonLat(matrices, target.lon, target.lat);
  assert.ok(projected, 'camera target is front-facing');
  close(projected.x, 960, 1e-4); close(projected.y, 540, 1e-4);
  const hit = m.intersectGlobeScreenRay(matrices, 960, 540);
  assert.ok(hit, 'center ray intersects sphere');
  close(hit.lon, target.lon, 1e-3); close(hit.lat, target.lat, 1e-3);
}
const dateline = m.slerpLonLat({ lon: 179, lat: 5 }, { lon: -179, lat: 5 }, 0.5);
assert.ok(Math.abs(dateline.lon) > 179.9, 'dateline takes shortest spherical path');

const legacy = m.createProject('Legacy');
const legacyView = m.createView('Legacy', [], { x: 0, y: 0, zoom: 1 }, []);
delete legacyView.mapMode;
legacy.views = [legacyView];
assert.equal(m.validateAndMigrateProject(legacy).views[0].mapMode, 'flat');
const project = m.createProject('Globe evaluator');
const globeAOrientation = m.quaternionBetweenVectors(m.lonLatToSphere(179, 5), [1, 0, 0]);
const globeBOrientation = m.quaternionBetweenVectors(m.lonLatToSphere(-179, 5), [1, 0, 0]);
const globeA = m.createView('Globe A', [], { x: 0, y: 0, zoom: 2, pitch: -40, globeOrientation: globeAOrientation }, [], 'globe');
const globeB = m.createView('Globe B', [], { x: 0, y: 0, zoom: 4, pitch: 40, globeOrientation: globeBOrientation }, [], 'globe');
globeA.holdDuration = 0; globeB.holdDuration = 1;
const transition = m.createTransition(globeA.id, globeB.id, [], globeA); transition.duration = 2; transition.preset = 'linear';
project.views = [globeA, globeB]; project.transitions = [transition];
assert.equal(m.compileTimeline(project).segments.length, 2, 'zero-Hold Globe View remains an anchor');
const middle = m.evaluateProjectAtTime(project, 1);
assert.equal(middle.mapMode, 'globe'); close(middle.camera.pitch, 0);
assert.ok(Math.abs(m.sphereToLonLat(m.centralGlobePoint(middle.camera.globeOrientation)).lon) > 179, 'evaluator uses shortest quaternion orientation interpolation');
assert.deepEqual(m.evaluateProjectAtTime(project, 1), middle, 'evaluator is deterministic');
const flat = m.createView('Flat', [], { x: 0, y: 0, zoom: 1 }, [], 'flat'); flat.holdDuration = 0;
const cross = m.createTransition(flat.id, globeB.id, [], flat); cross.duration = 1;
project.views = [flat, globeB]; project.transitions = [cross];
assert.throws(() => m.compileTimeline(project), /same map mode/, 'mixed-mode sequence is invalid');
assert.throws(() => m.validateAndMigrateProject(project), /same map mode/, 'mixed persisted mode is rejected');

const globeSource = readFileSync(join(root, 'src/core/globeRenderer.ts'), 'utf8');
const frameSource = readFileSync(join(root, 'src/core/frameRenderer.tsx'), 'utf8');
assert.match(globeSource, /getContext\('webgl2'/);
assert.match(globeSource, /gl\.bufferData\(gl\.ARRAY_BUFFER[\s\S]*gl\.STATIC_DRAW\)/);
assert.match(globeSource, /geometryUploadCount = 1/);
assert.match(globeSource, /Math\.min\(4096, gl\.getParameter\(gl\.MAX_TEXTURE_SIZE\)/);
assert.match(globeSource, /EXT_texture_filter_anisotropic/);
assert.match(globeSource, /gl\.enable\(gl\.DEPTH_TEST\)/);
assert.match(globeSource, /gl\.readPixels/);
assert.match(frameSource, /state\.mapMode/);
assert.match(frameSource, /new ImageData\(pixels, this\.width, this\.height\)/);
console.log('Globe foundation verification passed.');
