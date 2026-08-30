import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (path) => readFileSync(join(root, path), 'utf8');
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-frame-format-'));
const entryFile = join(outDir, 'entry.ts');
writeFileSync(
  entryFile,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectFrameFormat').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectRenderViewport').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectPersistence').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/exportPresets').replaceAll('\\', '/')}';`,
  ].join('\n'),
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

const expected = {
  landscape: [960, 540, 1920, 1080],
  portrait: [540, 960, 1080, 1920],
  square: [720, 720, 1080, 1080],
  'portrait-4-5': [648, 810, 1080, 1350],
  'classic-4-3': [800, 600, 1440, 1080],
};
for (const [id, dimensions] of Object.entries(expected)) {
  const project = core.createProject(id);
  const preset = core.CANVAS_LAYOUTS.find((candidate) => candidate.id === id);
  project.canvas = { ...project.canvas, layoutId: id, width: preset.width, height: preset.height };
  const format = core.resolveProjectFrameFormat(project);
  assert.deepEqual(
    [format.logicalWidth, format.logicalHeight, format.exportWidth, format.exportHeight],
    dimensions,
    `${id} resolves exact logical and export dimensions`,
  );
  assert.deepEqual(core.projectRenderViewport(project), {
    width: dimensions[0],
    height: dimensions[1],
    aspectRatio: dimensions[2] / dimensions[3],
  });
  assert.deepEqual(core.projectExportSettings(project), {
    width: dimensions[2],
    height: dimensions[3],
    fps: 30,
  });
  const fit = core.fitProjectViewport(core.projectRenderViewport(project), 1000, 700);
  assert.ok(fit.displayWidth <= 1000 && fit.displayHeight <= 700, `${id} fits without overflow`);
  assert.ok(Math.abs(fit.displayWidth / fit.displayHeight - format.aspectRatio) < 1e-12);
  const thumbnail = core.projectThumbnailViewport(project);
  assert.ok(Math.abs(thumbnail.width / thumbnail.height - format.aspectRatio) < 0.01);
}

const empty = core.createProject('Unlocked');
assert.equal(core.isProjectFrameFormatLocked(empty), false);
empty.views.push(core.createView('First', [], { x: 0, y: 0, zoom: 1 }, []));
assert.equal(core.isProjectFrameFormatLocked(empty), true);

const legacy = core.createProject('Legacy');
const camera = { x: -321.25, y: -98.5, zoom: 3.2, bearing: 450, pitch: 18 };
legacy.views = [core.createView('Legacy view', [], camera, [])];
delete legacy.canvas.layoutId;
legacy.canvas.width = 1080;
legacy.canvas.height = 1920;
const migrated = core.validateAndMigrateProject(legacy);
assert.equal(migrated.canvas.layoutId, 'landscape');
assert.equal(migrated.canvas.width, 1920);
assert.equal(migrated.canvas.height, 1080);
assert.deepEqual(migrated.views[0].camera, camera, 'legacy migration never rewrites camera values');

const custom = core.createProject('Custom');
custom.canvas = { ...custom.canvas, layoutId: 'custom', width: 1200, height: 1500 };
const customFormat = core.resolveProjectFrameFormat(custom);
assert.equal(customFormat.exportWidth, 1200);
assert.equal(customFormat.exportHeight, 1500);
assert.ok(Math.abs(customFormat.logicalWidth / customFormat.logicalHeight - 0.8) < 1e-12);
assert.ok(Math.abs(customFormat.logicalWidth * customFormat.logicalHeight - 960 * 540) < 1e-6);
assert.notEqual(customFormat.logicalWidth, customFormat.exportWidth);
assert.deepEqual(
  core.resolveProjectFrameFormat(structuredClone(custom)),
  customFormat,
  'custom resolution is stable',
);
const reopenedCustom = core.validateAndMigrateProject(structuredClone(custom));
assert.equal(reopenedCustom.canvas.layoutId, 'custom');
assert.equal(reopenedCustom.canvas.width, 1200);
assert.equal(reopenedCustom.canvas.height, 1500);
assert.deepEqual(core.projectExportSettings(custom), { width: 1200, height: 1500, fps: 30 });
for (const [width, height] of [
  [0, 1080],
  [1081, 1920],
  [4000, 2000],
  [2160, 2160],
])
  assert.throws(() => core.validateCustomFrameDimensions(width, height));

const app = source('src/app/App.tsx');
const frames = source('src/core/frameRenderer.tsx');
const online = source('src/core/onlineMapFrameRenderer.ts');
const rust = source('src-tauri/src/lib.rs');
assert.ok((app.match(/disabled=\{frameFormatLocked\}/g) ?? []).length >= 2);
assert.match(app, /Frame size is locked after the first View is created\./);
assert.match(app, /projectThumbnailViewport\(latestProject\)/);
assert.match(app, /exportProjectVideo\(project, outputPath, \{[\s\S]*?mapMode,/);
assert.doesNotMatch(app, /settings: exportPreset/, 'Export has no independent hidden resolution preset');
assert.match(frames, /projectSceneViewBox\(projectRenderViewport\(this\.project\)\)/);
assert.match(frames, /projectSceneViewBox\(projectRenderViewport\(project\)\)/);
assert.match(online, /const viewport = projectRenderViewport\(project\)/);
assert.match(rust, /width % 2 == 0[\s\S]*height % 2 == 0/);
assert.match(rust, /2_500_000/);

console.log(
  'Project frame formats: five exact presets, legacy migration, first-View lock, fitted scenes, project-owned Export, aspect-correct thumbnails, deterministic custom viewport, and native H.264 bounds passed.',
);
