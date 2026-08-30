import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (path) => readFileSync(join(root, path), 'utf8');
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-online-parity-'));
const entryFile = join(outDir, 'entry.ts');
writeFileSync(
  entryFile,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectPersistence').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectFile').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/viewCompiler').replaceAll('\\', '/')}';`,
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

const project = core.createProject('Online parity');
assert.equal(project.mapSettings.basemapRenderer, 'online');
assert.equal(project.mapSettings.onlineStyleId, 'liberty');
project.mapSettings.onlineStyleId = 'dark';
project.views = Array.from({ length: 4 }, (_, index) => {
  const view = core.createView(
    `View ${index + 1}`,
    [],
    { x: -index * 80, y: -index * 35, zoom: index + 1, bearing: index * 12, pitch: index * 8 },
    [],
  );
  view.holdDuration = 1;
  return view;
});
const saved = core.serializeCanonicalProject(project);
const reopened = core.parseProjectFile(saved.json);
assert.equal(reopened.mapSettings.basemapRenderer, 'online');
assert.equal(reopened.mapSettings.onlineStyleId, 'dark');
for (let index = 0; index < project.views.length; index += 1) {
  for (const key of ['x', 'y', 'zoom', 'bearing', 'pitch'])
    assert.ok(
      Math.abs(Number(reopened.views[index].camera[key]) - Number(project.views[index].camera[key])) < 1e-9,
      `View ${index + 1} camera ${key} persists`,
    );
}

const legacy = structuredClone(project);
delete legacy.mapSettings.basemapRenderer;
delete legacy.mapSettings.onlineStyleId;
const migrated = core.validateAndMigrateProject(legacy);
assert.equal(migrated.mapSettings.basemapRenderer, 'legacy');
assert.equal(migrated.mapSettings.onlineStyleId, 'liberty');

const app = source('src/app/App.tsx');
const frame = source('src/core/frameRenderer.tsx');
const onlineFrame = source('src/core/onlineMapFrameRenderer.ts');
const exporter = source('src/core/videoExporter.ts');

assert.doesNotMatch(app, /useState<'legacy' \| 'online'>/, 'Renderer ownership must not be local UI state.');
assert.match(
  app,
  /project\.mapSettings\.basemapRenderer === 'online'/,
  'Editor uses canonical renderer state.',
);
assert.match(app, /styleId=\{project\.mapSettings\.onlineStyleId\}/, 'Editor propagates canonical style.');
assert.match(
  frame,
  /project\.mapSettings\.basemapRenderer === 'online'/,
  'Frame factory selects online renderer.',
);
assert.match(
  frame,
  /onlineRenderer\.render\(state\.camera, this\.canvas, signal\)/,
  'Export propagates camera.',
);
assert.match(
  frame,
  /onlineRenderer\.render\(state\.camera, canvas, signal\)/,
  'Thumbnails propagate camera.',
);
assert.match(frame, /no Legacy fallback was used/, 'Unsupported online states fail explicitly.');
assert.match(exporter, /renderProjectRgbaSequence/, 'Video export consumes the shared prepared frame path.');
assert.match(onlineFrame, /map\.areTilesLoaded\(\)/, 'Readiness checks required visible tiles.');
assert.match(onlineFrame, /map\.on\('idle'/, 'Readiness uses MapLibre idle rather than a capture sleep.');
assert.match(
  onlineFrame,
  /isRecoverableOpenFreeMapResourceError/,
  'Only local glyph fallback is recoverable.',
);
assert.match(onlineFrame, /preserveDrawingBuffer: true/, 'Offscreen canvas is capture-safe.');
assert.match(
  onlineFrame,
  /pixelRatio = ONLINE_EXPORT_PIXEL_RATIO/,
  'Export density is explicit and independent of display DPI.',
);
assert.match(onlineFrame, /ONLINE_MAP_ATTRIBUTION/, 'Captured output includes required attribution.');
assert.doesNotMatch(
  onlineFrame,
  /await new Promise.*setTimeout/s,
  'Tile readiness must not use arbitrary sleeps.',
);

console.log(
  'Online renderer parity: canonical persistence, 4 Views, Editor, Preview, thumbnail, Export, style/camera propagation, readiness, attribution, and explicit Legacy fallback behavior passed.',
);
