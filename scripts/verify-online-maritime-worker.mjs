import assert from 'node:assert/strict';
import { findOceanPath } from '@arcnautical/maritime-routing/pathfinding';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

const assets = new URL('../dist/assets/', import.meta.url);
const workerName = readdirSync(assets).find((name) => name.startsWith('maritimeScalableRouting.worker-') && name.endsWith('.js'));
assert.ok(workerName, 'Run npm run build before the production maritime worker regression');
const productionWorker = new URL(workerName, assets);
const temporary = mkdtempSync(join(tmpdir(), 'mapmotion-maritime-worker-'));
const bootstrap = join(temporary, 'bootstrap.mjs');
writeFileSync(bootstrap, `import { parentPort } from 'node:worker_threads';\nglobalThis.self = globalThis;\nglobalThis.postMessage = (data) => parentPort.postMessage(data);\nawait import(${JSON.stringify(productionWorker.href)});\nparentPort.on('message', (data) => globalThis.onmessage({ data }));\n`);
const worker = new Worker(pathToFileURL(bootstrap));
let requestId = 0;
const route = (geometry) => new Promise((resolve, reject) => {
  const id = ++requestId;
  const listener = (data) => {
    if (data.id !== id) return;
    worker.off('message', listener);
    if (data.error) reject(new Error(data.error)); else resolve(data);
  };
  worker.on('message', listener);
  worker.postMessage({ id, geometry });
});
const fixtures = [
  ['Persian Gulf', [27.1749, 56.2923], [25.2927, 55.2754]],
  ['Shanghai → Bandar Abbas', [31.2304, 121.4737], [27.1832, 56.2666]],
  ['Singapore → Rotterdam', [1.264, 103.84], [51.9, 4.5]],
  ['Pacific antimeridian', [35, 140], [37.8, -122.4]],
].filter(([name]) => !process.env.MARITIME_FIXTURE || name.includes(process.env.MARITIME_FIXTURE));
const results = [];
try {
  for (const [name, from, to] of fixtures) {
    console.log('Running production maritime worker:', name);
    const macro = findOceanPath(from[0], from[1], to[0], to[1]);
    const started = performance.now();
    const result = await route(macro);
    assert.ok(result.geometry.length >= macro.length);
    assert.deepEqual(result.geometry[0], macro[0]);
    assert.deepEqual(result.geometry.at(-1), macro.at(-1));
    assert.ok(result.diagnostic.uniqueTileCount <= 800);
    assert.ok(result.diagnostic.maxConcurrentFetches <= 6);
    results.push({ name, macroCoordinates: macro.length, finalCoordinates: result.geometry.length, milliseconds: Math.round(performance.now() - started), ...result.diagnostic });
  }
} finally {
  await worker.terminate();
  rmSync(temporary, { recursive: true, force: true });
}
console.log('Production Maritime Worker:', JSON.stringify(results));
