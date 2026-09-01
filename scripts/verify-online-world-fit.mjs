import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'online-world-fit-'));
const entry = join(out, 'entry.ts');
const modulePath = (path) => join(root, path).replaceAll('\\', '/');
writeFileSync(
  entry,
  [
    `export * from '${modulePath('src/core/project')}';`,
    `export * from '${modulePath('src/core/projectRenderViewport')}';`,
    `export * from '${modulePath('src/core/openFreeMapAdapter')}';`,
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

const expected = {
  landscape: [960, 540],
  portrait: [540, 960],
  square: [720, 720],
  'portrait-4-5': [648, 810],
  'classic-4-3': [800, 600],
};
for (const [layoutId, [width, height]] of Object.entries(expected)) {
  const project = core.createProject(layoutId);
  const preset = core.CANVAS_LAYOUTS.find((candidate) => candidate.id === layoutId);
  project.canvas = { ...project.canvas, layoutId, width: preset.width, height: preset.height };
  const viewport = core.projectRenderViewport(project);
  assert.deepEqual([viewport.width, viewport.height], [width, height]);
  const fitZoom = core.mapLibreWorldFitZoom(viewport);
  assert.ok(Math.abs(fitZoom - Math.log2(Math.min(width, height) / 512)) < 1e-12);
  assert.equal(core.mapLibreMinimumZoom(viewport), fitZoom);
  const camera = core.mapMotionToMapLibreCamera({ x: 500, y: 280, zoom: 1, bearing: 0, pitch: 0 }, viewport);
  assert.ok(Math.abs(camera.zoom - fitZoom) < 1e-12, `${layoutId} authored Zoom 1 is exact contain zoom`);
  assert.deepEqual(camera.center, [0, 0]);
  const worldPixels = 512 * 2 ** fitZoom;
  assert.ok(worldPixels <= width + 1e-9 && worldPixels <= height + 1e-9);
  assert.ok(Math.abs(worldPixels - Math.min(width, height)) < 1e-9);
}

const custom = core.createProject('custom');
custom.canvas = { ...custom.canvas, layoutId: 'custom', width: 1200, height: 1500 };
const customViewport = core.projectRenderViewport(custom);
assert.equal(core.mapLibreMinimumZoom(customViewport), core.mapLibreWorldFitZoom(customViewport));

const interactive = readFileSync(join(root, 'src/components/OnlineOpenFreeMap.tsx'), 'utf8');
const exporter = readFileSync(join(root, 'src/core/onlineMapFrameRenderer.ts'), 'utf8');
assert.match(interactive, /mapMotionToMapLibreCamera\(cameraRef\.current, viewport\)/);
assert.match(interactive, /minZoom: mapLibreMinimumZoom\(viewport\)/);
assert.match(interactive, /mapLibreToMapMotionCamera\([\s\S]{0,220}viewport/);
assert.match(interactive, /viewport\.height, viewport\.width/);
assert.match(exporter, /mapMotionToMapLibreCamera\(initialCamera, viewport\)/);
assert.match(exporter, /minZoom: mapLibreMinimumZoom\(viewport\)/);
assert.match(exporter, /mapMotionToMapLibreCamera\(camera, \{[\s\S]{0,120}logicalWidth/);

console.log(
  'Online world fit: Landscape, Portrait, Square, 4:5, 4:3, Custom, shared Editor/Export camera mapping, and frame-change recreation passed.',
);
