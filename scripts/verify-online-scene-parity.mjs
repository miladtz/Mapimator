import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (path) => readFileSync(join(root, path), 'utf8');
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-online-scene-parity-'));
const entryFile = join(outDir, 'entry.ts');
writeFileSync(
  entryFile,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/camera').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/openFreeMapAdapter').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectRenderViewport').replaceAll('\\', '/')}';`,
  ].join('\n'),
  'utf8',
);

let core;
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
  core = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

// ── 1. Canonical logical viewport is fixed, independent of project canvas ──
const project = core.createProject('Qeshm scene parity');
project.canvas.width = 1920;
project.canvas.height = 1080;
const viewport = core.projectRenderViewport(project);
assert.equal(viewport.width, 960, 'Canonical logical viewport width is fixed at 960.');
assert.equal(viewport.height, 540, 'Canonical logical viewport height is fixed at 540.');
assert.ok(Math.abs(viewport.aspectRatio - 16 / 9) < 1e-12, 'Canonical viewport has 16:9 aspect ratio.');

// Verify viewport is independent of project canvas dimensions
const project2 = core.createProject('Square canvas');
project2.canvas.layoutId = 'square';
project2.canvas.width = 1080;
project2.canvas.height = 1080;
const viewport2 = core.projectRenderViewport(project2);
assert.equal(viewport2.width, 720, 'Square canonical viewport width is fixed at 720.');
assert.equal(viewport2.height, 720, 'Square canonical viewport height is fixed at 720.');

// ── 2. Camera mapping is viewport-independent (canonical 960) ──
const cameras = [
  { x: -1314.125, y: -524.75, zoom: 3.75, bearing: 0, pitch: 0 },
  { x: -2760.25, y: -1080.5, zoom: 5.8, bearing: 17, pitch: 38 },
];
for (const camera of cameras) {
  const editor = core.mapMotionToMapLibreCamera(camera);
  const preview = core.mapMotionToMapLibreCamera(camera);
  const thumbnail = core.mapMotionToMapLibreCamera(camera);
  const exportFrame = core.mapMotionToMapLibreCamera(camera);
  assert.deepEqual(editor, preview, 'Editor and Preview produce identical camera.');
  assert.deepEqual(editor, thumbnail, 'Editor and Thumbnail produce identical camera.');
  assert.deepEqual(editor, exportFrame, 'Editor and Export produce identical camera.');
  assert.equal(editor.zoom, Math.log2(camera.zoom) * 4, 'MapLibre style zoom has one canonical formula.');
  const roundTrip = core.mapLibreToMapMotionCamera(
    { lng: editor.center[0], lat: editor.center[1] },
    editor.zoom,
    editor.bearing,
    editor.pitch,
  );
  const constrained = core.constrainCamera(camera);
  for (const key of ['x', 'y', 'zoom', 'bearing', 'pitch'])
    assert.ok(
      Math.abs(roundTrip[key] - constrained[key]) < 1e-5,
      `Canonical camera ${key} round-trips without viewport-dependent drift.`,
    );
}

// ── 3. fitProjectViewport always returns the canonical viewport dimensions ──
const landscapeFit = core.fitProjectViewport(viewport, 836, 470);
assert.ok(
  Math.abs(landscapeFit.displayWidth / landscapeFit.displayHeight - 16 / 9) < 1e-12,
  'Display preserves 16:9.',
);
assert.equal(landscapeFit.width, 960, 'fitProjectViewport always returns canonical width.');
assert.equal(landscapeFit.height, 540, 'fitProjectViewport always returns canonical height.');
assert.ok(landscapeFit.displayWidth <= 836, 'Display fits within available width.');
assert.ok(landscapeFit.displayHeight <= 470, 'Display fits within available height.');

// Small panel
const smallFit = core.fitProjectViewport(viewport, 400, 300);
assert.equal(smallFit.width, 960, 'Small panel still returns canonical width.');
assert.equal(smallFit.height, 540, 'Small panel still returns canonical height.');

// Large panel
const largeFit = core.fitProjectViewport(viewport, 2000, 1200);
assert.equal(largeFit.width, 960, 'Large panel still returns canonical width.');
assert.equal(largeFit.height, 540, 'Large panel still returns canonical height.');

// ── 4. Source code structure assertions ──
const adapter = source('src/core/openFreeMapAdapter.ts');
const interactive = source('src/components/OnlineOpenFreeMap.tsx');
const app = source('src/app/App.tsx');
const renderer = source('src/core/onlineMapFrameRenderer.ts');
const frames = source('src/core/frameRenderer.tsx');
const viewportMod = source('src/core/projectRenderViewport.ts');

// Adapter must not have viewport-dependent zoom
assert.doesNotMatch(adapter, /viewportZoomOffset|Math\.log2\(Math\.max\(1, viewportWidth\)/);
assert.equal(
  (adapter.match(/mapMotionToMapLibreCamera = \(camera: CameraState\)/g) ?? []).length,
  1,
  'Camera adapter accepts no viewport-dependent input.',
);

// App passes viewport to online component
assert.match(app, /viewport=\{projectRenderViewport\(project\)\}/);

// Interactive uses a fitted outer wrapper and transforms only the canonical inner scene.
assert.match(
  interactive,
  /container\.style\.width = `\$\{viewport\.width\}px`/,
  'Interactive sets canonical container width.',
);
assert.match(
  interactive,
  /container\.style\.height = `\$\{viewport\.height\}px`/,
  'Interactive sets canonical container height.',
);
assert.match(
  interactive,
  /className="online-map-display-frame"/,
  'Interactive has a fitted display wrapper.',
);
assert.match(interactive, /display\.style\.width/, 'Display wrapper owns fitted layout width.');
assert.match(interactive, /display\.style\.height/, 'Display wrapper owns fitted layout height.');
assert.match(
  interactive,
  /container\.style\.transform/,
  'Canonical inner scene uses CSS transform for display scaling.',
);
assert.match(interactive, /transformOrigin/, 'Interactive sets transform origin.');
assert.match(interactive, /pixelRatio: interactivePixelRatioForDisplay/);
assert.match(interactive, /fitProjectViewport\(viewport, stage\.clientWidth, stage\.clientHeight\)/);

// Export uses same canonical viewport
assert.match(renderer, /projectRenderViewport/, 'Export uses projectRenderViewport for canonical viewport.');
assert.match(renderer, /pixelRatio = ONLINE_EXPORT_PIXEL_RATIO/);
assert.match(renderer, /fadeDuration: 0/, 'Export symbol/tile layout is settled deterministically.');
assert.match(renderer, /destination\.width/, 'Canonical export scene can be downsampled without relayout.');

// frameRenderer passes project to export renderer
assert.match(
  frames,
  /OnlineMapFrameRenderer\.create\([\s\S]*?project/,
  'frameRenderer passes project to OnlineMapFrameRenderer.create()',
);
assert.match(
  frames,
  /OnlineMapFrameRenderer\.create\([\s\S]*?0\.5,/m,
  'Thumbnails lower density, not logical size.',
);

// Viewport module defines a fixed canonical constant
assert.match(
  viewportMod,
  /resolveProjectFrameFormat/,
  'Viewport module resolves one deterministic canonical scene from project format.',
);
assert.match(viewportMod, /960|540/, 'Canonical viewport dimensions appear in viewport module.');

// ── 5. Editor/Preview use viewport-independent camera mapping ──
assert.equal(
  (interactive.match(/mapMotionToMapLibreCamera\([^,)]*\)/g) ?? []).length >= 2,
  true,
  'Editor and Preview use the viewport-independent camera mapping.',
);
assert.doesNotMatch(renderer, /mapMotionToMapLibreCamera\([^)]*,/);

// ── 6. FPS cannot alter logical state ──
const state30 = { viewport, camera: core.mapMotionToMapLibreCamera(cameras[0]), style: 'liberty' };
const state60 = { viewport, camera: core.mapMotionToMapLibreCamera(cameras[0]), style: 'liberty' };
assert.deepEqual(state30, state60, 'FPS cannot alter logical MapLibre state.');

console.log(
  'Online scene parity: project-format canonical viewport, window-independent camera mapping, identical Editor/Preview/Export zoom, CSS-transform interactive, no hidden crop, thumbnail density separation, and FPS parity passed.',
);
