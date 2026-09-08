import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (path) => readFileSync(join(root, path), 'utf8');
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-images-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectPersistence').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/imageLayers').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/onlineProjectOverlays').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/onlineImageLayer').replaceAll('\\', '/')}';`,
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

const asset = {
  id: `asset_${'a'.repeat(64)}`,
  kind: 'image',
  filename: 'map.webp',
  mediaType: 'image/webp',
  sha256: 'a'.repeat(64),
  size: 100,
  width: 800,
  height: 400,
  packagePath: `assets/${'a'.repeat(64)}.webp`,
};
const image = {
  ...core.createLayer('image'),
  id: 'image-a',
  assetId: asset.id,
  x: 500,
  y: 250,
  width: 200,
  height: 100,
  imageAspectRatio: 2,
  imageAspectLocked: true,
  imageRotation: 30,
  imageFitMode: 'cover',
};
assert.equal(image.type, 'image');
assert.deepEqual(core.resizeImageLayer(image, 300, 60, asset), {
  width: 300,
  height: 150,
  imageAspectRatio: 2,
});
assert.deepEqual(core.resizeImageLayer({ ...image, imageAspectLocked: false }, 300, 60, asset), {
  width: 300,
  height: 60,
  imageAspectRatio: 5,
});
assert.equal(core.imageWorldCorners(image).length, 4);
assert.equal(core.imageGeographicCorners(image).length, 4);
assert.deepEqual(core.imageWorldCorners(image), core.imageWorldCorners(image), 'geometry is deterministic');
assert.equal(core.onlineImageHandleFeatureCollection([image], image.id).features.length, 5);
assert.equal(
  core.onlineImageHandleFeatureCollection([image], null).features.length,
  0,
  'output has no editor handles',
);

const project = core.createProject('Image persistence');
project.assets = [asset];
project.layers = [image];
const reopened = core.validateAndMigrateProject(structuredClone(project));
assert.deepEqual(reopened.layers[0], image);
assert.deepEqual(reopened.assets, [asset]);
const duplicate = { ...image, id: 'image-b', name: 'Image copy' };
const withDuplicate = core.addProjectLayer(project, duplicate);
assert.equal(withDuplicate.assets.length, 1, 'duplicates reuse one project-owned asset');
const oneDeleted = core.deleteProjectLayer(withDuplicate, image.id);
assert.equal(oneDeleted.assets.length, 1, 'shared asset survives deletion of one duplicate');
const allDeleted = core.deleteProjectLayer(oneDeleted, duplicate.id);
assert.equal(allDeleted.assets.length, 0, 'unreferenced image metadata is removed');

const second = { ...image, id: 'image-c' };
const imageRenderer = source('src/core/onlineImageLayer.ts');
assert.match(imageRenderer, /ONLINE_PROJECT_IMAGE_RENDER_LAYER_ID/);
assert.doesNotMatch(imageRenderer, /toDataURL|clearRect|drawImage|updateImage|loadImage/);

const app = source('src/app/App.tsx');
const online = source('src/core/onlineProjectOverlays.ts');
const frame = source('src/core/onlineMapFrameRenderer.ts');
assert.match(app, /extensions: \['png', 'jpg', 'jpeg', 'webp'\]/, 'creation accepts PNG/JPEG/WebP');
assert.match(app, /imageAspectLocked/);
assert.match(app, /Fit \/ Contain/);
assert.match(app, /Fill \/ Crop/);
assert.match(online, /ensureOnlineImageLayer/, 'MapLibre uses the retained Image custom layer');
assert.match(online, /'mapmotion:editor-only': true/, 'handles are editor-only');
assert.match(frame, /loadOnlineProjectOverlayAssets/, 'export uses the shared overlay asset preparation');

console.log('Online Image layer regression checks passed.');
