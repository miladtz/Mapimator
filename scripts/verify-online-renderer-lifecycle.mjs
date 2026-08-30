import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (path) => readFileSync(join(root, path), 'utf8');
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-online-lifecycle-'));
const entryFile = join(outDir, 'entry.ts');
writeFileSync(
  entryFile,
  `export * from '${join(root, 'src/core/onlineMapLifecycle').replaceAll('\\', '/')}';`,
  'utf8',
);

let lifecycle;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      lib: { entry: entryFile, formats: ['es'], fileName: () => 'lifecycle.mjs' },
    },
  });
  lifecycle = await import(pathToFileURL(join(outDir, 'lifecycle.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const releaseInteractive = lifecycle.registerOnlineMapInstance('interactive');
const releaseThumbnail = lifecycle.registerOnlineMapInstance('thumbnail');
const releaseExport = lifecycle.registerOnlineMapInstance('export');
assert.deepEqual(lifecycle.onlineMapLifecycleSnapshot(), {
  active: 3,
  interactive: 1,
  thumbnail: 1,
  export: 1,
  created: 3,
  disposed: 0,
});
releaseThumbnail();
releaseExport();
releaseExport();
releaseInteractive();
assert.deepEqual(lifecycle.onlineMapLifecycleSnapshot(), {
  active: 0,
  interactive: 0,
  thumbnail: 0,
  export: 0,
  created: 3,
  disposed: 3,
});

const frameRenderer = source('src/core/frameRenderer.tsx');
const onlineRenderer = source('src/core/onlineMapFrameRenderer.ts');
const interactive = source('src/components/OnlineOpenFreeMap.tsx');
assert.match(frameRenderer, /finally\s*\{[\s\S]*?renderer\.dispose\(\)/, 'Export sequence always disposes.');
assert.match(
  frameRenderer,
  /finally\s*\{[\s\S]*?onlineRenderer\?\.dispose\(\)/,
  'Thumbnail batch always disposes.',
);
assert.match(
  frameRenderer,
  /0\.5,\s*'thumbnail'/,
  'One thumbnail renderer is identified and reused per batch.',
);
assert.match(onlineRenderer, /purpose: OnlineMapPurpose = 'export'/);
assert.match(onlineRenderer, /this\.map\.remove\(\)/);
assert.match(onlineRenderer, /this\.host\.remove\(\)/);
assert.match(onlineRenderer, /this\.releaseLifecycle\(\)/);
assert.match(onlineRenderer, /if \(this\.disposed\) return/);
assert.match(interactive, /resizeObserver\.disconnect\(\)/);
assert.match(interactive, /cancelAnimationFrame\(cameraSyncFrame\)/);
assert.match(interactive, /map\?\.remove\(\)/);
assert.match(interactive, /releaseLifecycle\(\)/);

console.log(
  'Online renderer lifecycle: DEV instance accounting, idempotent release, bounded thumbnail reuse, Export finally disposal, interactive observer/rAF cleanup, MapLibre removal, and DOM cleanup passed.',
);
