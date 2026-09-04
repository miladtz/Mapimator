import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (path) => readFileSync(join(root, path), 'utf8');
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-online-text-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectFile').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/openFreeMapAdapter').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/onlineProjectOverlays').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/textLayers').replaceAll('\\', '/')}';`,
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
      lib: { entry, formats: ['es'], fileName: () => 'core.mjs' },
    },
  });
  core = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const text = core.createLayer('text');
text.id = 'text-tehran';
text.text = 'ایران ۱۴۰۵\nIran 2026';
text.x = 654.25;
text.y = 231.75;
text.fontFamily = 'vazirmatn';
text.fontSize = 44;
text.fontWeight = 600;
text.fontStyle = 'normal';
text.textDirection = 'rtl';
text.textAlign = 'right';
text.lineHeight = 1.35;
text.color = '#f4e9d5';
text.opacity = 0.72;

const style = core.resolveTextLayerStyle(text);
assert.equal(style.content, text.text);
assert.deepEqual(style.lines, ['ایران ۱۴۰۵', 'Iran 2026']);
assert.equal(style.direction, 'rtl');
assert.equal(style.cssFontFamily, '"Vazirmatn Variable", "Inter Variable", sans-serif');
assert.equal(style.alignment, 'right');
assert.equal(style.lineHeight, 1.35);
assert.equal(core.textLayerImageId(text), core.textLayerImageId(structuredClone(text)));
assert.notEqual(core.textLayerImageId(text), core.textLayerImageId({ ...text, text: `${text.text}!` }));

const feature = core.onlineTextFeatureCollection([text], text.id).features[0];
assert.equal(feature.id, text.id);
assert.equal(feature.properties.layerId, text.id);
assert.equal(feature.properties.selected, true);
assert.equal(feature.properties.anchor, 'right');
assert.equal(feature.properties.opacity, 0.72);
assert.deepEqual(feature.geometry.coordinates, core.mapMotionWorldToLngLat(text.x, text.y));

const project = core.createProject('Text persistence');
project.layers = [text];
const reopened = core.parseProjectFile(core.serializeCanonicalProject(project).json);
assert.deepEqual(reopened.layers[0], text, 'Text Unicode, anchor, and typography round-trip exactly');

const overlay = source('src/core/onlineProjectOverlays.ts');
assert.match(overlay, /ONLINE_PROJECT_TEXT_SOURCE_ID/);
assert.match(overlay, /waitForTextLayerFonts/);
assert.match(overlay, /icon-pitch-alignment': 'viewport'/);
assert.match(overlay, /style\.load|ensureOnlineProjectOverlays/);
const app = source('src/app/App.tsx');
assert.match(app, /type === 'pin' \|\| type === 'text'/);
assert.match(app, /placing === 'pin' \|\| placing === 'text'/);
assert.match(app, /Vazirmatn/);
assert.match(app, /Line spacing/);

console.log('Online Text Layer checks passed.');
