import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-export-benchmark-'));
const entryFile = join(outDir, 'entry.ts');
writeFileSync(
  entryFile,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/viewCompiler').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/mapLabels').replaceAll('\\', '/')}';`,
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
      lib: { entry: entryFile, formats: ['es'], fileName: () => 'core.mjs' },
    },
  });
  mod = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const { createProject, createView, createTransition, evaluateProjectAtTime, selectMapLabels } = mod;
const project = createProject('Runtime benchmark');
const first = createView('Start', [], { x: 0, y: 0, zoom: 1 }, []);
const last = createView('End', [], { x: -600, y: -240, zoom: 4 }, []);
const transition = createTransition(first.id, last.id, [], first);
transition.duration = 10;
project.views = [first, last];
project.transitions = [transition];
const frames = 300;
let evaluatorMs = 0;
let labelsMs = 0;
for (let index = 0; index < frames; index++) {
  const time = index / 30;
  let started = performance.now();
  const state = evaluateProjectAtTime(project, time);
  evaluatorMs += performance.now() - started;
  started = performance.now();
  selectMapLabels(state.camera);
  labelsMs += performance.now() - started;
}
console.log('MapMotion export runtime diagnostic (pure stages)');
console.log(`Frames: ${frames}`);
const measuredMs = evaluatorMs + labelsMs;
const row = (name, total) =>
  console.log(
    `${name}: ${total.toFixed(3)} ms total | ${(total / frames).toFixed(4)} ms/frame | ${((total / measuredMs) * 100).toFixed(1)}% of measured pure stages`,
  );
console.log(`Measured pure-stage duration: ${measuredMs.toFixed(3)} ms`);
row('Evaluator', evaluatorMs);
row('Labels', labelsMs);
for (const stage of ['Prepare scene', 'React render', 'SVG serialize', 'Blob', 'Image decode', 'Canvas draw', 'RGBA readback', 'IPC/FFmpeg write', 'Finalization'])
  console.log(`${stage}: native WebView export required (reported by the Export performance console table)`);
