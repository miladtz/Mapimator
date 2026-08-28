import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-flat-labels-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/camera').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/mapLabels').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/data/worldMap').replaceAll('\\', '/')}';`,
  ].join('\n'),
);

try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'labels.mjs' },
    },
  });
  const core = await import(`${pathToFileURL(join(outDir, 'labels.mjs')).href}?${Date.now()}`);
  const labels = [
    ...core.COUNTRIES.map((item) => ({ id: item.id, point: item.label, text: (item.nameFa?.length ?? 0) > item.name.length ? item.nameFa : item.name, fontSize: 5.9 })),
    ...core.CITY_LABELS.map((item) => ({ id: item.id, point: item.point, text: `${item.name} ${item.nameFa ?? ''}`, fontSize: item.capital ? 4.3 : 3.8 })),
    ...core.CONTINENT_LABELS.map((item) => ({ id: item.id, point: item.point, text: (item.nameFa?.length ?? 0) > item.name.length ? item.nameFa : item.name, fontSize: 11 })),
    ...core.MARINE_LABELS.map((item) => ({ id: item.id, point: item.point, text: (item.nameFa?.length ?? 0) > item.name.length ? item.nameFa : item.name, fontSize: 5.8 })),
  ];
  assert(labels.some((label) => /[\u0600-\u06ff]/u.test(label.text)), 'Persian labels must be covered');
  const pitches = [-85, -80, -70, -60, -45, 0, 45, 60, 70, 80, 85];
  const zooms = [1, 2, 3, 4, 5, 6];
  const bearings = [-180, -135, -112, -90, -72, -48, -24, 0, 24, 48, 72, 90, 135, 179];
  let rendered = 0;
  let hidden = 0;
  let maximumBasis = 0;
  let maximumEstimatedWidth = 0;
  let legacyMaximumBasis = 0;
  let legacyWorst = '';
  const legacyStarted = performance.now();
  for (const pitch of pitches)
    for (const zoom of zooms)
      for (const bearing of bearings) {
        const camera = { x: 0, y: 0, zoom, pitch, bearing };
        const project = core.createWorldToScreenProjector(camera);
        for (const label of labels) {
          const anchor = project(label.point[0], label.point[1]);
          const tangent = project(label.point[0] + 1, label.point[1]);
          if (!anchor || !tangent) continue;
          const basis = Math.hypot(tangent.x - anchor.x, tangent.y - anchor.y);
          if (basis > legacyMaximumBasis) {
            legacyMaximumBasis = basis;
            legacyWorst = `${label.id} at Pitch ${pitch}, Zoom ${zoom}, Bearing ${bearing}`;
          }
        }
      }
  const legacyElapsed = performance.now() - legacyStarted;
  const started = performance.now();
  for (const pitch of pitches)
    for (const zoom of zooms)
      for (const bearing of bearings) {
        const camera = { x: 0, y: 0, zoom, pitch, bearing };
        for (const label of labels) {
          const projection = core.projectFlatMapLabel(camera, label.point[0], label.point[1]);
          if (!projection) {
            hidden += 1;
            continue;
          }
          rendered += 1;
          const values = [
            projection.x,
            projection.y,
            projection.rotation,
            projection.scale,
            projection.depth,
            projection.basisLength,
          ];
          assert(values.every(Number.isFinite), `${label.id}: non-finite projection`);
          assert(projection.scale >= 1 && projection.scale <= 6, `${label.id}: typography scale escaped bounds`);
          assert(projection.basisLength <= core.LABEL_MAX_BASIS_LENGTH, `${label.id}: unsafe basis accepted`);
          assert(
            projection.verticalBasisLength <= core.LABEL_MAX_BASIS_LENGTH,
            `${label.id}: unsafe vertical basis accepted`,
          );
          assert(projection.rawSigmaMax >= projection.rawSigmaMin, `${label.id}: invalid raw singular values`);
          assert(
            projection.perspectiveSigmaMax <= 1 + 1e-9,
            `${label.id}: perspective magnification escaped normalization (${projection.perspectiveSigmaMax})`,
          );
          assert(
            projection.perspectiveSigmaMin / projection.perspectiveSigmaMax >= core.LABEL_MIN_DETERMINANT - 1e-9,
            `${label.id}: unsafe compressed singular value accepted`,
          );
          assert(Math.abs(projection.determinant) > 0, `${label.id}: degenerate transform accepted`);
          assert(!/NaN|Infinity/.test(projection.transform), `${label.id}: invalid transform`);
          const project = core.createWorldToScreenProjector(camera);
          const tangent = project(label.point[0] + 1, label.point[1]);
          const vertical = project(label.point[0], label.point[1] + 1);
          assert(tangent && vertical);
          const hx = [tangent.x - projection.x, tangent.y - projection.y];
          const hy = [vertical.x - projection.x, vertical.y - projection.y];
          const [a, b, c, d] = projection.matrix;
          const baselineError = Math.abs(a * hx[1] - b * hx[0]) / (Math.hypot(a, b) * Math.hypot(...hx));
          assert(baselineError < 1e-9, `${label.id}: baseline detached from projected map X`);
          assert(
            Math.sign(a * d - b * c) === Math.sign(hx[0] * hy[1] - hx[1] * hy[0]),
            `${label.id}: second axis changed projected-plane handedness`,
          );
          const localWidth = Math.max(18, label.text.length * label.fontSize * 0.7);
          const localHeight = label.fontSize * 1.5;
          const estimatedWidth = Math.abs(a) * localWidth + Math.abs(c) * localHeight;
          const estimatedHeight = Math.abs(b) * localWidth + Math.abs(d) * localHeight;
          assert(estimatedWidth <= 2000, `${label.id}: absurd estimated screen width`);
          assert(estimatedHeight <= 1120, `${label.id}: absurd estimated screen height`);
          maximumBasis = Math.max(maximumBasis, projection.basisLength);
          maximumEstimatedWidth = Math.max(maximumEstimatedWidth, estimatedWidth);
          assert.deepEqual(
            projection,
            core.projectFlatMapLabel(camera, label.point[0], label.point[1]),
            `${label.id}: projection depends on prior frame state`,
          );
        }
      }
  const elapsed = performance.now() - started;
  assert(rendered > 0 && hidden > 0, 'matrix must exercise both safe and horizon-hidden labels');
  let benchmarkChecksum = 0;
  const productionStarted = performance.now();
  for (const pitch of pitches)
    for (const zoom of zooms)
      for (const bearing of bearings) {
        const camera = { x: 0, y: 0, zoom, pitch, bearing };
        for (const label of labels) {
          const projection = core.projectFlatMapLabel(camera, label.point[0], label.point[1]);
          if (projection) benchmarkChecksum += projection.determinant;
        }
      }
  const productionElapsed = performance.now() - productionStarted;
  assert(Number.isFinite(benchmarkChecksum));

  const normal = { x: -500, y: -280, zoom: 2, pitch: 0, bearing: 60 };
  const sample = core.projectFlatMapLabel(normal, 500, 280);
  assert(sample, 'normal-view center label should render');
  assert.equal(sample.scale, normal.zoom, 'Pitch 0 must preserve cartographic zoom scale');
  assert(Math.abs(sample.rotation - 60) < 1e-8, 'Pitch 0 must preserve map bearing');
  assert(Math.abs(sample.shear) < 1e-9, 'Pitch 0 must not introduce shear');
  assert(Math.abs(sample.perspectiveSigmaMax - 1) < 2e-7, 'Pitch 0 must preserve an undistorted plane');
  assert(Math.abs(sample.perspectiveSigmaMin - 1) < 2e-7, 'Pitch 0 must preserve an undistorted plane');

  const suppliedCamera = { x: 0, y: 0, zoom: 6, pitch: -72, bearing: -56 };
  const supplied = labels
    .map((label) => ({ label, projection: core.projectFlatMapLabel(suppliedCamera, label.point[0], label.point[1]) }))
    .filter(({ projection }) => projection);
  const normalExample = supplied.reduce((best, current) =>
    Math.abs(current.projection.rawSigmaMax - 1) < Math.abs(best.projection.rawSigmaMax - 1) ? current : best,
  );
  const magnifiedExample = supplied.reduce((best, current) =>
    current.projection.rawSigmaMax > best.projection.rawSigmaMax ? current : best,
  );
  const describe = ({ label, projection }) =>
    `${label.id}: depth=${projection.depth.toFixed(3)}, rawJ=[${projection.rawMatrix.map((value) => value.toFixed(3)).join(', ')}], ` +
    `rawSigma=${projection.rawSigmaMax.toFixed(3)}/${projection.rawSigmaMin.toFixed(3)}, ` +
    `normalizedSigma=${projection.perspectiveSigmaMax.toFixed(6)}/${projection.perspectiveSigmaMin.toFixed(6)}, ` +
    `cartographicScale=${projection.scale}`;

  for (const [pitch, bearing, zoom] of [
    [-85, -72, 6],
    [-73, -80, 6],
    [-73, -112, 6],
    [-73, 24, 6],
    [85, 72, 6],
  ]) {
    const camera = { x: 0, y: 0, zoom, pitch, bearing };
    for (let frame = 0; frame <= 90; frame += 1) {
      const t = frame / 90;
      const swept = { ...camera, pitch: pitch * t, zoom: 1 + (zoom - 1) * t };
      for (const label of labels) {
        const projection = core.projectFlatMapLabel(swept, label.point[0], label.point[1]);
        if (projection) assert(projection.scale <= 6 && Number.isFinite(projection.rotation));
      }
    }
  }
  const calls = pitches.length * zooms.length * bearings.length * labels.length;
  console.log(
    `Flat label projection: ${labels.length} labels, ${calls} matrix calls, ${rendered} rendered, ${hidden} safely hidden, ` +
      `max basis ${maximumBasis.toFixed(3)}, max estimated width ${maximumEstimatedWidth.toFixed(1)}px, ` +
      `${elapsed.toFixed(2)}ms total (${((elapsed * 1000) / calls).toFixed(3)}us/call).`,
  );
  console.log(
    `Production calculation only: ${productionElapsed.toFixed(2)}ms total ` +
      `(${((productionElapsed * 1000) / calls).toFixed(3)}us/call, ` +
      `${((productionElapsed * labels.length) / calls).toFixed(3)}ms for ${labels.length} labels).`,
  );
  console.log(
    `Legacy full-Jacobian diagnostic: max basis ${legacyMaximumBasis.toFixed(3)} (${legacyWorst}); ` +
      `${legacyElapsed.toFixed(2)}ms total (${((legacyElapsed * 1000) / calls).toFixed(3)}us/call).`,
  );
  console.log(`Same-camera normal example: ${describe(normalExample)}`);
  console.log(`Same-camera formerly magnified example: ${describe(magnifiedExample)}`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
