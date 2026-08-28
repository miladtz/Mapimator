import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-flat-surface-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from '${join(root, 'src/core/camera').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/perspectiveGeometry').replaceAll('\\', '/')}';`,
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
      lib: { entry, formats: ['es'], fileName: () => 'surface.mjs' },
    },
  });
  const core = await import(`${pathToFileURL(join(outDir, 'surface.mjs')).href}?${Date.now()}`);

  const safeCamera = { x: 0, y: 0, zoom: 1, bearing: 0, pitch: 0 };
  assert.match(core.projectSvgPath('M400 200L600 200L600 360L400 360Z', safeCamera), /Z$/);

  const crossingCamera = { x: -1000, y: -560, zoom: 3, bearing: -120, pitch: -79 };
  const project = core.createWorldToScreenProjector(crossingCamera);
  let crossingPath = null;
  for (let y = -200; y <= 760 && !crossingPath; y += 20) {
    const path = `M300 ${y}L700 ${y}L700 ${y + 120}L300 ${y + 120}Z`;
    const visibility = [
      project(300, y),
      project(700, y),
      project(700, y + 120),
      project(300, y + 120),
    ].map(Boolean);
    if (visibility.some(Boolean) && visibility.some((value) => !value)) crossingPath = path;
  }
  assert(crossingPath, 'diagnostic must find a finite ring crossing the camera plane');
  const clippedCrossing = core.projectSvgPath(crossingPath, crossingCamera);
  assert.match(clippedCrossing, /^M.*Z$/);
  assert(!/NaN|Infinity|undefined/.test(clippedCrossing));
  const mixedStats = core.perspectiveGeometryCacheStats();
  assert.equal(mixedStats.lastMixedClosedRings, 1, 'mixed ring must enter targeted clipping');
  assert.equal(mixedStats.lastHiddenClosedRings, 0);

  const fullyVisiblePath = 'M400 240L600 240L600 320L400 320Z';
  core.projectSvgPath(fullyVisiblePath, safeCamera);
  const visibleStats = core.perspectiveGeometryCacheStats();
  assert.equal(visibleStats.lastMixedClosedRings, 0, 'Pitch 0 must retain the affine fast path');

  let hiddenPath = null;
  for (let y = -1000; y <= 1600 && !hiddenPath; y += 20) {
    const path = `M300 ${y}L700 ${y}L700 ${y + 20}L300 ${y + 20}Z`;
    const visibility = [project(300, y), project(700, y), project(700, y + 20), project(300, y + 20)];
    if (visibility.every((point) => !point)) hiddenPath = path;
  }
  assert(hiddenPath, 'diagnostic must find a fully hidden ring');
  assert.equal(core.projectSvgPath(hiddenPath, crossingCamera), '');
  assert.equal(core.perspectiveGeometryCacheStats().lastHiddenClosedRings, 1);

  const pitches = [-60, -65, -70, -72, -74, -76, -78, -79, -80, -81, -82, -83, -84, -85];
  const bearings = [-180, -150, -120, -90, -60, 0, 60, 120, 179];
  const zooms = [1, 2, 3, 4, 5, 6];
  let rejectedRings = 0;
  let visibleRings = 0;
  let hiddenRings = 0;
  let mixedRings = 0;
  let outputs = 0;
  let firstMixedCountry = '';
  for (const pitch of pitches)
    for (const bearing of bearings)
      for (const zoom of zooms) {
        const camera = { x: -500 * (zoom - 1), y: -280 * (zoom - 1), zoom, bearing, pitch };
        for (const country of core.COUNTRIES) {
          const path = core.projectSvgPath(country.path, camera);
          const stats = core.perspectiveGeometryCacheStats();
          rejectedRings += stats.lastCulledSubpaths;
          visibleRings += stats.lastVisibleClosedRings;
          hiddenRings += stats.lastHiddenClosedRings;
          mixedRings += stats.lastMixedClosedRings;
          if (!firstMixedCountry && stats.lastMixedClosedRings > 0)
            firstMixedCountry = `${country.id} (${country.name}) at Pitch ${pitch}, Bearing ${bearing}, Zoom ${zoom}`;
          if (path) {
            outputs += 1;
            assert(!/NaN|Infinity|undefined/.test(path), `${country.id}: invalid projected path`);
          }
        }
      }
  assert(rejectedRings > 0, 'high-pitch matrix must exercise rejected horizon-crossing rings');
  assert(visibleRings > 0 && hiddenRings > 0 && mixedRings > 0, 'matrix must exercise all ring branches');
  assert(outputs > 0, 'high-pitch matrix must retain safe geography');
  assert(firstMixedCountry, 'matrix must identify a real mixed country ring');

  const source = await import('node:fs').then(({ readFileSync }) =>
    readFileSync(join(root, 'src/components/OfflineMap.tsx'), 'utf8'),
  );
  assert.match(source, /<rect width="1000" height="560" fill=\{style\.waterColor\}/);
  assert(!source.match(/flatPerspectiveCamera[\s\S]{0,200}<rect width="1000" height="560"/));
  assert.match(source, /fill=\{[\s\S]*style\.landColor/);
  const geometrySource = await import('node:fs').then(({ readFileSync }) =>
    readFileSync(join(root, 'src/core/perspectiveGeometry.ts'), 'utf8'),
  );
  assert(!/Liang|clipScreen|SCREEN_MIN|SCREEN_MAX/.test(geometrySource));
  console.log(
    `Flat finite-surface bounds: ${pitches.length} pitches, ${bearings.length} bearings, ${zooms.length} zooms, ` +
      `${visibleRings} visible, ${hiddenRings} hidden, ${mixedRings} targeted mixed-ring clips, ` +
      `${rejectedRings} culled subpaths, ${outputs} country projections retained. First mixed: ${firstMixedCountry}.`,
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
