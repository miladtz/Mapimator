import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = new URL('../public/map-data/gbopen-adm1-v6/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const index = JSON.parse(await readFile(new URL('index.json', root), 'utf8'));

assert.equal(manifest.source, 'geoBoundaries gbOpen');
assert.equal(manifest.sourceVersion, 'v6.0.0');
assert.equal(manifest.license, 'CC BY 4.0');
assert.equal(index.length, 3235);
assert.equal(new Set(index.map(({ id }) => id)).size, index.length);
assert.ok(index.every(({ id }) => id.startsWith('gbopen-v6-adm1-')));

const expected = [
  ['Fars', 'IRN'],
  ['Bayern', 'DEU'],
  ['Île-de-France', 'FRA'],
  ['Kyoto Prefecture', 'JPN'],
  ['California', 'USA'],
  ['Ontario', 'CAN'],
  ['Queensland', 'AUS'],
  ['Sao Paulo', 'BRA'],
  ['Gauteng', 'ZAF'],
];
for (const [name, countryCode] of expected) {
  const matches = index.filter((item) => item.name === name && item.countryCode === countryCode);
  assert.equal(matches.length, 1, `${name} must resolve unambiguously in ${countryCode}.`);
}

const assetNames = (await readdir(new URL('countries/', root))).filter((name) => name.endsWith('.json'));
assert.equal(assetNames.length, 198);
let loaded = 0;
for (const name of assetNames.sort()) {
  const boundaries = JSON.parse(await readFile(new URL(`countries/${name}`, root), 'utf8'));
  for (const boundary of boundaries) {
    assert.ok(['Polygon', 'MultiPolygon'].includes(boundary.geometry?.type));
    assert.equal(boundary.adminLevel, 1);
    assert.equal(boundary.source, 'geoBoundaries-gbOpen');
    const polygons = boundary.geometry.type === 'Polygon' ? [boundary.geometry.coordinates] : boundary.geometry.coordinates;
    for (const polygon of polygons) {
      assert.ok(polygon.length > 0);
      for (const ring of polygon) {
        assert.ok(ring.length >= 4, `${boundary.id} contains a collapsed ring.`);
        assert.ok(ring.every(([longitude, latitude]) => Number.isFinite(longitude) && Number.isFinite(latitude)));
        assert.deepEqual(ring[0], ring.at(-1), `${boundary.id} contains an open ring.`);
      }
    }
    loaded++;
  }
}
assert.equal(loaded, index.length);

const runtimeSource = await readFile(new URL('../src/core/globalAdmin1Boundaries.ts', import.meta.url), 'utf8');
assert.match(runtimeSource, /entity\.category !== 'Administrative Region'/);
assert.doesNotMatch(runtimeSource, /City|Town|Village/);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const pathname = new URL(String(input), 'http://mapmotion.local').pathname;
  try {
    return new Response(await readFile(new URL(`../public${pathname}`, import.meta.url)), { status: 200 });
  } catch {
    return new Response('Not found', { status: 404 });
  }
};
const vite = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  configFile: false,
  cacheDir: path.join(tmpdir(), 'mapmotion-global-admin1-vite-cache'),
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
try {
  const { resolveGlobalAdmin1BoundaryRef } = await vite.ssrLoadModule('/src/core/globalAdmin1Boundaries.ts');
  const entities = [
    ['Fars', 'استان فارس', 'IR', 54.0641546, 28.6692545, '17685810B30738859401369'],
    ['Bayern', 'Bayern', 'DE', 11.4038717, 48.9467562, '10402087B60477050509260'],
    ['Kyoto', '京都府', 'JP', 135.454601, 35.242552, '47310658B94014236912993'],
    ['Île-de-France', 'Île-de-France', 'FR', 2.7537863, 48.6443057, '19338628B22645672383103'],
  ];
  for (const [label, name, countryCode, longitude, latitude, expectedSourceId] of entities) {
    const resolved = await resolveGlobalAdmin1BoundaryRef({
      id: `test:${label}`,
      source: 'geocoder',
      name,
      category: 'Administrative Region',
      coordinates: { longitude, latitude },
      countryCode,
      sourceMetadata: { osmValue: label === 'Fars' || label === 'Kyoto' ? 'province' : 'state' },
      capabilities: { addPin: true, addRegion: false },
    });
    assert.equal(resolved?.sourceId, expectedSourceId, `${label} must resolve through the runtime resolver.`);
    const resolvedByStableId = await resolveGlobalAdmin1BoundaryRef({
      id: `test:accepted:${label}`,
      source: 'geocoder',
      name,
      category: 'Other',
      geographicFeatureId: resolved?.id,
      coordinates: { longitude, latitude },
      capabilities: { addPin: true, addRegion: true },
    });
    assert.equal(
      resolvedByStableId?.sourceId,
      expectedSourceId,
      `${label} stable boundary identity must survive the add-Region handoff.`,
    );
  }
  for (const category of ['City', 'Administrative Region']) {
    const rejected = await resolveGlobalAdmin1BoundaryRef({
      id: `test:rejected:${category}`,
      source: 'geocoder',
      name: category === 'City' ? 'Kyoto' : 'Example County',
      category,
      coordinates: { longitude: 135.75, latitude: 35.02 },
      countryCode: 'JP',
      sourceMetadata: { osmValue: category === 'City' ? 'city' : 'county' },
      capabilities: { addPin: true, addRegion: false },
    });
    assert.equal(rejected, undefined, `${category} must not enter ADM1 containment.`);
  }
} finally {
  await vite.close();
  globalThis.fetch = originalFetch;
}

console.log(
  `Global ADM1 validation passed: ${loaded} boundaries, ${assetNames.length} country assets, ${manifest.runtimeGzipBytes} gzip bytes.`,
);
