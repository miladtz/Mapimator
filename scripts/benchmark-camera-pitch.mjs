import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-camera-pitch-benchmark-'));
const entryFile = join(outDir, 'entry.ts');
writeFileSync(
  entryFile,
  [
    `export * from '${join(root, 'src/core/perspectiveGeometry').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/data/worldMap').replaceAll('\\', '/')}';`,
  ].join('\n'),
);
let mod;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      lib: { entry: entryFile, formats: ['es'], fileName: () => 'benchmark.mjs' },
    },
  });
  mod = await import(pathToFileURL(join(outDir, 'benchmark.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const {
  COASTLINE_PATH,
  COUNTRIES,
  COUNTRY_BORDER_PATH,
  LAKE_PATH,
  RIVER_PATHS,
  perspectiveGeometryCacheStats,
  preparseSvgPaths,
  projectSvgPath,
} = mod;
const land = COUNTRIES.map((country) => country.path);
const physical = [LAKE_PATH, ...RIVER_PATHS];
const outlines = [COUNTRY_BORDER_PATH, COASTLINE_PATH];
const all = [...land, ...physical, ...outlines];

const parseStarted = performance.now();
preparseSvgPaths(all);
const parseMs = performance.now() - parseStarted;
const stats = perspectiveGeometryCacheStats();

const cameraForPitch = (pitch) => ({ x: -1000, y: -420, zoom: 3, bearing: 37, pitch });
const measure = (paths, pitch, iterations = 2) => {
  const camera = cameraForPitch(pitch);
  let elapsed = 0;
  let outputCharacters = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    for (const path of paths) outputCharacters += projectSvgPath(path, camera).length;
    elapsed += performance.now() - started;
  }
  return { ms: elapsed / iterations, outputCharacters: Math.round(outputCharacters / iterations) };
};

console.log('MapMotion perspective geometry diagnostic');
console.log(`Static paths: ${stats.pathCount}`);
console.log(`Static vertices: ${stats.vertexCount}`);
console.log(`One-time source parse: ${parseMs.toFixed(2)} ms`);
console.log('Pitch 0: affine SVG transform; no per-vertex geometry rebuild');
for (const pitch of [20, -20, 45, -45, 60, -60]) {
  const full = measure(all, pitch);
  console.log(
    `Pitch ${pitch >= 0 ? '+' : ''}${pitch}: ${full.ms.toFixed(2)} ms/update | ${(1000 / full.ms).toFixed(1)} geometry updates/s | ${full.outputCharacters} output chars`,
  );
}
const pitch = 45;
for (const [name, paths] of [
  ['land', land],
  ['lakes/rivers', physical],
  ['borders/coastlines', outlines],
]) {
  const result = measure(paths, pitch, 3);
  console.log(`${name} at +45: ${result.ms.toFixed(2)} ms/update`);
}
console.log('React reconciliation, DOM mutation, layout, paint, and raster/composite require native WebView profiling.');
