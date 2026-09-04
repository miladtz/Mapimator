import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { findOceanPath } from '@arcnautical/maritime-routing/pathfinding';
import { build } from 'vite';

const root = new URL('..', import.meta.url).pathname.slice(1);
const out = mkdtempSync(join(tmpdir(), 'maritime-scale-'));
const entry = join(out, 'entry.ts');
writeFileSync(entry, `export * from '${join(root, 'src/core/maritimePrepass').replaceAll('\\', '/')}';\nexport * from '${join(root, 'src/core/maritimeGeometry').replaceAll('\\', '/')}';`);
let core;
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: out, emptyOutDir: false, minify: false, lib: { entry, formats: ['es'], fileName: () => 'module.mjs' } } });
  core = await import(pathToFileURL(join(out, 'module.mjs')).href);
} finally { rmSync(out, { recursive: true, force: true }); }

const tileAt = ([longitude, latitude], zoom) => {
  const extent = 2 ** zoom;
  return ({
  x: Math.floor(((((longitude + 180) % 360 + 360) % 360) / 360) * extent),
  y: Math.floor(((1 - Math.log(Math.tan(latitude * Math.PI / 180) + 1 / Math.cos(latitude * Math.PI / 180)) / Math.PI) / 2) * extent),
  });
};
const key = ({ x, y }, zoom) => { const extent = 2 ** zoom; return `${zoom}/${(x % extent + extent) % extent}/${Math.max(0, Math.min(extent - 1, y))}`; };
const tilesForGeometry = (geometry, zoom, radius) => {
  const result = new Set();
  for (let index = 0; index < geometry.length - 1; index += 1) {
    const start = geometry[index], end = geometry[index + 1];
    const count = Math.max(1, Math.ceil(core.haversineMeters(start, end) / 3_000));
    let delta = end[0] - start[0]; if (delta > 180) delta -= 360; if (delta < -180) delta += 360;
    for (let step = 0; step <= count; step += 1) {
      const amount = step / count;
      const center = tileAt([start[0] + delta * amount, start[1] + (end[1] - start[1]) * amount], zoom);
      for (let dx = -radius; dx <= radius; dx += 1) for (let dy = -radius; dy <= radius; dy += 1) result.add(key({ x: center.x + dx, y: center.y + dy }, zoom));
    }
  }
  return result;
};
const fixtures = [
  ['Persian Gulf', [27.1749, 56.2923], [25.2927, 55.2754]],
  ['Shanghai → Bandar Abbas', [31.2304, 121.4737], [27.1832, 56.2666]],
  ['Singapore → Rotterdam', [1.264, 103.84], [51.9, 4.5]],
  ['Pacific antimeridian', [35, 140], [37.8, -122.4]],
];
const results = [];
const liveTileSets = new Map();
for (const [name, from, to] of fixtures) {
  const started = performance.now();
  const macro = findOceanPath(from[0], from[1], to[0], to[1]);
  const macroMs = performance.now() - started;
  const prepassStarted = performance.now();
  const windows = core.selectMaritimeRefinementWindows(macro);
  const prepassMs = performance.now() - prepassStarted;
  const oldTiles = tilesForGeometry(macro, 12, 2);
  const detailZoom = macro.length > 1_500 ? 9 : macro.length > 200 ? 10 : 12;
  const radius = detailZoom === 12 ? 2 : 1;
  const detailedTiles = new Set(windows.flatMap((window) => [...tilesForGeometry(window.geometry, detailZoom, radius)]));
  liveTileSets.set(name, detailedTiles);
  console.log('Maritime scale diagnostic', { name, macroCoordinates: macro.length, oldTiles: oldTiles.size, windows: windows.length, spans: windows.map((window) => [window.startSegment, window.endSegment]), detailedTiles: detailedTiles.size });
  assert.ok(detailedTiles.size <= 800, `${name} exceeds the detailed tile budget`);
  assert.ok(detailedTiles.size < oldTiles.size || oldTiles.size < 250, `${name} must not refine its entire long route`);
  results.push({ name, macroCoordinates: macro.length, macroMs: Math.round(macroMs), prepassMs: Math.round(prepassMs), oldTiles: oldTiles.size, windows: windows.length, detailZoom, detailedTiles: detailedTiles.size });
}
assert.ok(results[1].detailedTiles < results[1].oldTiles / 2, 'Shanghai route must eliminate most detailed tile requests');
assert.ok(results[2].detailedTiles < results[2].oldTiles / 2, 'Singapore route must eliminate most detailed tile requests');
assert.ok(results[3].detailedTiles < 800, 'Antimeridian route must not create a world-spanning tile set');

if (process.env.MARITIME_FETCH_LIVE === '1') {
  const tileJson = await fetch('https://tiles.openfreemap.org/planet').then((response) => response.json());
  const template = tileJson.tiles[0];
  const ids = [...liveTileSets.get('Shanghai → Bandar Abbas')];
  let cursor = 0, active = 0, maximumActive = 0, bytes = 0, downloaded = 0, retries = 0;
  const runner = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++]; const [z, x, y] = id.split('/');
      const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      active += 1; maximumActive = Math.max(maximumActive, active);
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const response = await fetch(url);
            if (response.ok) { const body = await response.arrayBuffer(); bytes += body.byteLength; downloaded += 1; break; }
            if (response.status !== 429 && response.status < 500) throw new Error(`${id} HTTP ${response.status}: ${url}`);
            if (attempt === 2) throw new Error(`${id} HTTP ${response.status}: ${url}`);
          } catch (error) { if (attempt === 2) throw error; retries += 1; await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt)); }
        }
      } finally { active -= 1; }
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: 6 }, runner));
  console.log('Shanghai live tile fetch:', { requested: ids.length, downloaded, bytes, retries, maximumActive, milliseconds: Math.round(performance.now() - started) });
}

const retryingFetch = async (fetcher, attempts = 3) => {
  let error;
  for (let attempt = 0; attempt < attempts; attempt += 1) try {
    const response = await fetcher();
    if (response.ok) return response;
    if (response.status !== 429 && response.status < 500) throw new Error(`HTTP ${response.status}`);
    error = new Error(`HTTP ${response.status}`);
  } catch (caught) { error = caught; }
  throw new Error(`Detailed coastline data could not be loaded: ${error instanceof Error ? error.message : error}`);
};
let calls = 0;
assert.equal((await retryingFetch(async () => ({ ok: ++calls === 2, status: calls === 1 ? 500 : 200 }))).status, 200);
calls = 0;
assert.equal((await retryingFetch(async () => ({ ok: ++calls === 3, status: calls < 3 ? 429 : 200 }))).status, 200);
await assert.rejects(() => retryingFetch(async () => { throw new TypeError('Failed to fetch'); }), /Detailed coastline data could not be loaded/);
await assert.rejects(() => retryingFetch(async () => ({ ok: false, status: 404 })), /HTTP 404/);
console.log('Online Maritime Scalability:', JSON.stringify(results));
