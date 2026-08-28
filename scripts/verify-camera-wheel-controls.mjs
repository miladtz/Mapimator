import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-camera-wheel-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(entry, `export * from '${join(root, 'src/core/camera').replaceAll('\\', '/')}';`);
let m;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'camera.mjs' },
    },
  });
  m = await import(pathToFileURL(join(outDir, 'camera.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const q = { x: 0.123456789, y: -0.234567891, z: 0.345678912, w: 0.897654321 };
const base = { x: -123.5, y: 88.25, zoom: 2.75, bearing: 37, pitch: -18, globeOrientation: q };
const exact = (actual, fields) => fields.forEach((field) => assert.deepEqual(actual[field], base[field], field));

let result = m.applyCameraWheel(base, 'flat', -120, 0, false, false);
assert.equal(result.action, 'zoom');
assert.notEqual(result.camera.zoom, base.zoom);
exact(result.camera, ['x', 'y', 'bearing', 'pitch', 'globeOrientation']);

result = m.applyCameraWheel(base, 'flat', -120, 0, true, false);
assert.equal(result.action, 'pitch');
assert.notEqual(result.camera.pitch, base.pitch);
exact(result.camera, ['x', 'y', 'zoom', 'bearing', 'globeOrientation']);

result = m.applyCameraWheel(base, 'flat', -120, 0, false, true);
assert.equal(result.action, 'bearing');
assert.notEqual(result.camera.bearing, base.bearing);
exact(result.camera, ['x', 'y', 'zoom', 'pitch', 'globeOrientation']);

result = m.applyCameraWheel(base, 'flat', -120, 0, true, true);
assert.equal(result.action, 'pitch', 'Ctrl has precedence over Alt');
exact(result.camera, ['x', 'y', 'zoom', 'bearing', 'globeOrientation']);

result = m.applyCameraWheel(base, 'globe', -120, 0, false, false);
assert.equal(result.action, 'zoom');
assert.notEqual(result.camera.zoom, base.zoom);
exact(result.camera, ['x', 'y', 'bearing', 'pitch', 'globeOrientation']);

result = m.applyCameraWheel(base, 'globe', -120, 0, true, false);
assert.equal(result.action, 'pitch');
assert.notEqual(result.camera.pitch, base.pitch);
exact(result.camera, ['x', 'y', 'zoom', 'bearing', 'globeOrientation']);

result = m.applyCameraWheel(base, 'globe', -120, 0, false, true);
assert.equal(result.action, 'reserved');
assert.strictEqual(result.camera, base, 'Globe Alt-wheel is a no-op');

assert.equal(m.normalizeWheelDelta(10, 1), 160);
assert.equal(m.normalizeWheelDelta(1, 2, 700), 240);
assert.equal(m.normalizeWheelDelta(10000, 0), 240);
assert.equal(m.normalizeWheelDelta(-10000, 0), -240);

const flatSource = readFileSync(join(root, 'src/components/OfflineMap.tsx'), 'utf8');
const globeSource = readFileSync(join(root, 'src/components/WebGLGlobe.tsx'), 'utf8');
assert.match(flatSource, /viewport\.addEventListener\('wheel', onWheel, \{ passive: false \}\)/);
assert.match(flatSource, /event\.ctrlKey \|\| event\.altKey/);
assert.match(flatSource, /applyCameraWheel/);
assert.doesNotMatch(globeSource, /addEventListener\('wheel'/);

console.log('Mode-specific camera wheel controls verification passed.');
