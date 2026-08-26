import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-export-stability-'));
const entryFile = join(outDir, 'entry.ts');
writeFileSync(
  entryFile,
  [
    `export * from '${join(root, 'src/core/mapLabels').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/camera').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/exportPresets').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/data/worldMap').replaceAll('\\', '/')}';`,
  ].join('\n'),
  'utf8',
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

const { selectMapLabels, interpolateCamera, EXPORT_PRESETS, COUNTRY_BORDER_PATH } = mod;
const ids = (selection) =>
  ['continents', 'oceans', 'countries', 'capitals', 'cities'].flatMap((group) =>
    selection[group].map(({ item }) => `${group}:${item.id}`),
  );

// Same absolute camera always produces identical label selection and ordering.
const stableCamera = { x: -300.125, y: -115.875, zoom: 2.5 };
const stableA = selectMapLabels(stableCamera);
const stableB = selectMapLabels({ ...stableCamera });
assert.deepEqual(stableB, stableA);
assert.deepEqual(ids(stableB), ids(stableA));
for (const group of ['continents', 'oceans', 'countries', 'capitals', 'cities'])
  for (const label of stableA[group]) {
    const point = label.item.point ?? label.item.label;
    assert.ok(point?.every(Number.isFinite), `${group}/${label.item.id} must have finite coordinates`);
  }

// Slow linear movement remains monotonic for a stable label and a border vertex.
const source = { x: -100.25, y: -80.5, zoom: 2 };
const destination = { x: -260.75, y: -80.5, zoom: 2 };
const displacement30 = Math.abs(destination.x - source.x) / (10 * 30);
const displacement60 = Math.abs(destination.x - source.x) / (10 * 60);
assert.ok(Math.abs(displacement30 / 2 - displacement60) < 1e-12);
const selectedHistory = new Map();
let previousLabelX = Number.POSITIVE_INFINITY;
const stableCountry = stableA.countries[0]?.item;
assert.ok(stableCountry, 'fixture must expose a country label');
const labelPoint = stableCountry.label;
const borderNumbers = COUNTRY_BORDER_PATH.match(/-?\d+(?:\.\d+)?/g).map(Number);
const borderPoint = [borderNumbers[0], borderNumbers[1]];
let previousBorderX = Number.POSITIVE_INFINITY;
let previousLabelDelta;
let previousBorderDelta;
for (let frame = 0; frame <= 600; frame++) {
  const camera = interpolateCamera(source, destination, frame / 600, 'linear', 'smooth');
  const labelX = labelPoint[0] * camera.zoom + camera.x;
  const borderX = borderPoint[0] * camera.zoom + camera.x;
  assert.ok(labelX <= previousLabelX + 1e-9, 'label motion must not reverse');
  assert.ok(borderX <= previousBorderX + 1e-9, 'border motion must not reverse');
  if (frame > 0) {
    const labelDelta = labelX - previousLabelX;
    const borderDelta = borderX - previousBorderX;
    if (previousLabelDelta !== undefined)
      assert.ok(Math.abs(labelDelta - previousLabelDelta) < 1e-9, 'label velocity must remain constant');
    if (previousBorderDelta !== undefined)
      assert.ok(Math.abs(borderDelta - previousBorderDelta) < 1e-9, 'border velocity must remain constant');
    previousLabelDelta = labelDelta;
    previousBorderDelta = borderDelta;
  }
  previousLabelX = labelX;
  previousBorderX = borderX;
  for (const id of ids(selectMapLabels(camera))) {
    const history = selectedHistory.get(id) ?? [];
    history.push(frame);
    selectedHistory.set(id, history);
  }
}
for (const frames of selectedHistory.values()) {
  let gaps = 0;
  for (let index = 1; index < frames.length; index++) if (frames[index] !== frames[index - 1] + 1) gaps++;
  assert.ok(gaps <= 1, 'a label must not rapidly alternate during a monotonic pan');
}

assert.ok(EXPORT_PRESETS.some(({ width, height }) => width === 1920 && height === 1080));
const renderer = readFileSync(join(root, 'src/core/frameRenderer.tsx'), 'utf8');
const labels = readFileSync(join(root, 'src/core/mapLabels.ts'), 'utf8');
const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
const globalCss = readFileSync(join(root, 'src/styles/global.css'), 'utf8');
const timelineCss = readFileSync(join(root, 'src/styles/views.css'), 'utf8');
assert.ok(renderer.includes('class PreparedFrameRenderer'));
assert.ok(!renderer.includes('inlineComputedStyles'));
assert.ok(renderer.includes('text-rendering: geometricPrecision'));
assert.ok(renderer.includes('shape-rendering: geometricPrecision'));
assert.ok(renderer.includes('renderProjectPngFrameRange'));
assert.ok(renderer.includes('evaluateProjectAtTime(this.project, time)'));
assert.ok(renderer.includes('canvas.width = width'));
assert.ok(renderer.includes('canvas.height = height'));
assert.ok(!renderer.includes('devicePixelRatio'));
assert.ok(!renderer.match(/(?:Math\.(?:round|floor|ceil)|toFixed|parseInt).*camera/));
assert.equal((renderer.match(/canvas\.width = width/g) ?? []).length, 2, 'export and thumbnail canvases size once');
assert.ok(labels.includes('COUNTRY_CAPACITIES'));
assert.ok(!labels.match(/Math\.(?:round|floor|ceil)|toFixed|parseInt/));
assert.ok(app.includes("extensions: [PROJECT_FILE_EXTENSION]"));
assert.ok(app.includes("extensions: ['mapmotionpack']"));
assert.ok(globalCss.includes('max-width: 100vw'));
assert.ok(globalCss.includes('overflow: hidden'));
assert.ok(timelineCss.includes('overflow-x: auto'));
assert.ok(timelineCss.includes('max-width: 100%'));

console.log('Export render stability verification passed');
