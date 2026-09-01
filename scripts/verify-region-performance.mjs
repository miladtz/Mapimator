import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { build } from 'vite';
import earcut from 'earcut';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'region-performance-'));
const entry = join(out, 'entry.ts');
const modulePath = (path) => join(root, path).replaceAll('\\', '/');
writeFileSync(
  entry,
  [
    `export * from '${modulePath('src/core/regions')}';`,
    `export * from '${modulePath('src/core/geographicRegionFillLayer')}';`,
  ].join('\n'),
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

const results = [];
let usaBounds;
let legacyUsUvMs;
for (const code of ['USA', 'IDN', 'PHL', 'JPN', 'CAN', 'NOR', 'GRC']) {
  const record = core.ADMINISTRATIVE_REGIONS.find(
    (candidate) => candidate.kind === 'country' && candidate.countryCode === code,
  );
  assert.ok(record, `missing stress Region ${code}`);
  const geometry = record.geometry;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const earcutStarted = performance.now();
  for (const polygon of polygons) {
    const flat = [];
    const holes = [];
    polygon.forEach((ring, ringIndex) => {
      if (ringIndex > 0) holes.push(flat.length / 2);
      const points =
        ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]
          ? ring.slice(0, -1)
          : ring;
      for (const point of points) flat.push(point[0], point[1]);
    });
    earcut(flat, holes, 2);
  }
  const earcutMs = performance.now() - earcutStarted;
  const started = performance.now();
  const cover = core.meshFor(geometry, 4 / 3, 'cover', 4);
  const firstMs = performance.now() - started;
  const cachedStarted = performance.now();
  const cached = core.meshFor(geometry, 4 / 3, 'cover', 4);
  const cachedMs = performance.now() - cachedStarted;
  assert.equal(cached, cover, `${code} mesh cache returns the same immutable allocation`);
  const tile = core.meshFor(geometry, 4 / 3, 'tile', 4);
  assert.equal(tile.length, cover.length, `${code} Tile and Cover share topology`);
  const statistics = core.regionGeometryStatistics(geometry);
  assert.equal(cover.length / 12, statistics.triangles, `${code} triangle inventory is stable`);
  results.push({ code, ...statistics, earcutMs, firstMs, cachedMs });
  if (code === 'USA') {
    usaBounds = {
      raw: core.regionGeometryBounds(geometry),
      wrapped: core.minimalWrappedRegionBounds(geometry),
    };
    if (process.env.MAPMOTION_PROFILE_LEGACY_UV === '1') {
      const points =
        geometry.type === 'Polygon' ? geometry.coordinates.flat(1) : geometry.coordinates.flat(2);
      const legacyStarted = performance.now();
      for (const [longitude, latitude] of points)
        core.regionTextureUv(longitude, latitude, geometry, 4 / 3, 'cover', 4);
      legacyUsUvMs = performance.now() - legacyStarted;
    }
  }
}

const antimeridian = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [179, 0],
        [179, 2],
        [180, 2],
        [180, 0],
        [179, 0],
      ],
    ],
    [
      [
        [-180, 0],
        [-180, 2],
        [-179, 2],
        [-179, 0],
        [-180, 0],
      ],
    ],
  ],
};
const wrapped = core.minimalWrappedRegionBounds(antimeridian);
assert.equal(wrapped.wrapsAntimeridian, true);
assert.ok(Math.abs(wrapped.maxX - wrapped.minX - 2) < 1e-9, '179/-179 uses a 2 degree mapping interval');
assert.ok(
  Math.abs(core.regionTextureUv(179, 1, antimeridian, 1, 'cover', 4)[0] - 0) < 1e-9,
  'wrapped western UV is stable',
);
assert.ok(
  Math.abs(core.regionTextureUv(-179, 1, antimeridian, 1, 'cover', 4)[0] - 1) < 1e-9,
  'wrapped eastern UV is stable',
);

const rendererSource = await import('node:fs').then(({ readFileSync }) =>
  readFileSync(join(root, 'src/core/geographicRegionFillLayer.ts'), 'utf8'),
);
assert.doesNotMatch(
  rendererSource,
  /regionEffectProgress.*staticSignature|staticSignature.*regionEffectProgress/,
);
assert.doesNotMatch(rendererSource, /gl\.bufferData\(gl\.ARRAY_BUFFER, entry\.vertices, gl\.DYNAMIC_DRAW\)/);
assert.match(rendererSource, /gl\.bufferData\(gl\.ARRAY_BUFFER, entry\.vertices, gl\.STATIC_DRAW\)/);
assert.match(rendererSource, /const triangulationCache = new WeakMap/);
assert.match(rendererSource, /const meshCache = new WeakMap/);
assert.match(rendererSource, /this\.textures\.get\(entry\.url\)/);
assert.match(rendererSource, /this\.releaseEntry\(entry\)/);

console.table(results);
console.log('USA mapping bounds:', JSON.stringify(usaBounds));
if (legacyUsUvMs !== undefined)
  console.log(`USA legacy repeated-bounds UV cost: ${legacyUsUvMs.toFixed(3)} ms`);
console.log(
  'MultiPolygon performance: cached topology/UV meshes, one texture per asset, static GPU buffers, dynamic-only opacity updates, antimeridian bounds, and stress inventory passed.',
);
