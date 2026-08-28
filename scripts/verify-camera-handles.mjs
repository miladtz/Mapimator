import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-camera-handles-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(entry, `export * from '${join(root, 'src/core/globeMath').replaceAll('\\', '/')}';`);
let m;
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir, emptyOutDir: false, minify: false, lib: { entry, formats: ['es'], fileName: () => 'math.mjs' } } });
  m = await import(pathToFileURL(join(outDir, 'math.mjs')).href);
} finally { rmSync(outDir, { recursive: true, force: true }); }

const base = m.cameraWithTargetLonLat({ x: 0, y: 0, zoom: 2.5, bearing: 0, pitch: 0 }, 53.7, 32.4);
const target = m.cameraTargetLonLat(base);
for (const bearing of [-180, -90, 0, 90, 179]) for (const pitch of [-60, -30, 0, 30, 60]) {
  const camera = { ...base, bearing, pitch };
  assert.deepEqual(m.cameraTargetLonLat(camera), target, 'orientation does not mutate target');
  assert.deepEqual(m.globeCameraMatrices(camera, 1000, 560), m.globeCameraMatrices(camera, 1000, 560), 'absolute camera is deterministic');
}
assert.deepEqual(m.cameraTargetLonLat({ ...base, zoom: base.zoom }), target);
assert.ok(m.globeDistanceForZoom(1) > m.globeDistanceForZoom(6));
const control = readFileSync(join(root, 'src/components/CameraOrbitControl.tsx'), 'utf8');
const globe = readFileSync(join(root, 'src/components/WebGLGlobe.tsx'), 'utf8');
const map = readFileSync(join(root, 'src/components/OfflineMap.tsx'), 'utf8');
assert.match(control, /aria-label="Bearing"/);
assert.match(control, /aria-label="Pitch"/);
assert.match(control, /bearing: 0, pitch: 0/);
assert.match(control, /Reset Globe/);
assert.match(control, /globeOrientation/);
assert.match(control, /disabled=\{disabled\}/);
assert.match(map, /<CameraOrbitControl[\s\S]*disabled=\{!interactionEnabled\}/);
assert.match(globe, /interactionFrameRef[\s\S]*requestAnimationFrame/);
assert.match(globe, /globeScreenContact/);
assert.match(globe, /quaternionBetweenVectors/);
assert.doesNotMatch(globe, /drag\.camera\.pitch[\s\S]*clientY/);
assert.match(globe, /setPointerCapture/);
assert.match(globe, /releasePointerCapture/);
console.log('Camera handles verification passed.');
