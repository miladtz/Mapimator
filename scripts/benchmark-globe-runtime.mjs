import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-globe-benchmark-'));
const entryFile = join(outDir, 'entry.ts');
writeFileSync(entryFile, [`export * from '${join(root, 'src/core/globeMath').replaceAll('\\', '/')}';`, `export * from '${join(root, 'src/core/mapLabels').replaceAll('\\', '/')}';`].join('\n'));
let m;
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir, emptyOutDir: false, minify: true, lib: { entry: entryFile, formats: ['es'], fileName: () => 'bench.mjs' } } });
  m = await import(pathToFileURL(join(outDir, 'bench.mjs')).href);
} finally { rmSync(outDir, { recursive: true, force: true }); }
const iterations = 10000;
let matrices;
let orientation = { x: 0, y: 0, z: 0, w: 1 };
const quaternionStarted = performance.now();
for (let index = 0; index < iterations; index += 1)
  orientation = m.multiplyQuaternions(
    m.quaternionBetweenVectors(
      m.normalize3([1, ((index % 17) - 8) * 0.002, ((index % 13) - 6) * 0.002]),
      m.normalize3([1, ((index % 19) - 9) * 0.002, ((index % 11) - 5) * 0.002]),
    ),
    orientation,
  );
const quaternionMs = performance.now() - quaternionStarted;
const cameraStarted = performance.now();
for (let index = 0; index < iterations; index += 1) matrices = m.globeCameraMatrices({ x: 0, y: 0, zoom: 1 + index % 5, pitch: -60 + index % 120, globeOrientation: orientation }, 1920, 1080);
const cameraMs = performance.now() - cameraStarted;
const labelStarted = performance.now();
for (let index = 0; index < 500; index += 1) m.selectMapLabels({ x: -500, y: -280, zoom: 1 + index % 5, bearing: 0, pitch: 0 });
const labelMs = performance.now() - labelStarted;
console.log('MapMotion WebGL Globe diagnostic');
console.log('Static geometry upload invariant: 1 per renderer/context lifecycle');
console.log(`Quaternion drag CPU: ${(quaternionMs / iterations).toFixed(4)} ms/update (${iterations} iterations)`);
console.log(`Camera matrix CPU: ${(cameraMs / iterations).toFixed(4)} ms/update (${iterations} iterations)`);
console.log(`Label selection CPU: ${(labelMs / 500).toFixed(4)} ms/update (500 iterations)`);
console.log(`Finite output: ${[...matrices.viewProjection].every(Number.isFinite)}`);
console.log('WebGL draw/readPixels, Pins, effective FPS, and memory require native WebView profiling.');
