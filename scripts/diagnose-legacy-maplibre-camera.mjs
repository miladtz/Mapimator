import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-renderer-semantics-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/cameraContinuity').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/openFreeMapAdapter').replaceAll('\\', '/')}';`,
  ].join('\n'),
);
let m;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'diagnostic.mjs' },
    },
  });
  m = await import(pathToFileURL(join(outDir, 'diagnostic.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const viewport = { width: 1000, height: 560 };
const cameraAt = (centerX, centerY, zoom, bearing, pitch) => ({
  x: viewport.width / 2 - centerX * zoom,
  y: viewport.height / 2 - centerY * zoom,
  zoom,
  bearing,
  pitch,
});
const cameras = [
  cameraAt(250, 300, 2, 0, 10),
  cameraAt(400, 260, 5, 60, 45),
  cameraAt(600, 180, 2.5, 140, 65),
  cameraAt(750, 320, 5.5, 220, 30),
];
const project = m.createProject('Legacy versus MapLibre diagnostic');
project.views = cameras.map((camera, index) => {
  const view = m.createView(`Diagnostic ${index + 1}`, [], camera);
  view.holdDuration = 0;
  return view;
});
project.transitions = project.views.slice(0, -1).map((view, index) => {
  const transition = m.createTransition(view.id, project.views[index + 1].id, [], view);
  transition.duration = 3;
  return transition;
});

const samples = [];
for (let percent = 0; percent <= 100; percent += 5) {
  const source = m.interpolateCameraChainTransition(project, 1, percent / 100);
  const online = m.mapMotionToMapLibreCamera(source);
  const legacyCenterWorld = {
    x: (viewport.width / 2 - source.x) / source.zoom,
    y: (viewport.height / 2 - source.y) / source.zoom,
  };
  samples.push({
    percent,
    mapMotion: source,
    legacy: {
      centerWorld: legacyCenterWorld,
      scale: source.zoom,
      bearing: source.bearing,
      pitch: source.pitch,
    },
    jumpTo: online,
    isolation: {
      centerOnly: { center: online.center },
      centerZoom: { center: online.center, zoom: online.zoom },
      centerBearing: { center: online.center, bearing: online.bearing },
      centerPitch: { center: online.center, pitch: online.pitch },
      full: online,
    },
  });
}

const zoomPairs = [
  [1, 2],
  [2, 4],
  [3, 6],
].map(([from, to]) => {
  const legacyScaleRatio = to / from;
  const fromOnline = m.mapMotionToMapLibreCamera(cameraAt(400, 260, from, 0, 0)).zoom;
  const toOnline = m.mapMotionToMapLibreCamera(cameraAt(400, 260, to, 0, 0)).zoom;
  const mapLibreScaleRatio = 2 ** (toOnline - fromOnline);
  return { from, to, legacyScaleRatio, mapLibreZoomDelta: toOnline - fromOnline, mapLibreScaleRatio };
});
assert.equal(zoomPairs[1].legacyScaleRatio, 2);
assert.equal(zoomPairs[1].mapLibreScaleRatio, 2);

const sameCenter = {
  zoom: [2, 3, 4, 5].map((zoom) => m.mapMotionToMapLibreCamera(cameraAt(400, 260, zoom, 60, 45)).center),
  bearing: [0, 90, 180, 270].map(
    (bearing) => m.mapMotionToMapLibreCamera(cameraAt(400, 260, 3, bearing, 45)).center,
  ),
  pitch: [0, 30, 60, 85].map((pitch) => m.mapMotionToMapLibreCamera(cameraAt(400, 260, 3, 60, pitch)).center),
};
for (const values of Object.values(sameCenter))
  assert.ok(values.every((center) => center[0] === values[0][0] && center[1] === values[0][1]));

const interactive = readFileSync(join(root, 'src/components/OnlineOpenFreeMap.tsx'), 'utf8');
const exporter = readFileSync(join(root, 'src/core/onlineMapFrameRenderer.ts'), 'utf8');
const deterministicPath = `${interactive}\n${exporter}`;
const animationCalls = [
  ...deterministicPath.matchAll(/map(?:Ref\.current)?\?*\.(flyTo|panTo|rotateTo|setLocationAtPoint)\(/g),
].map((match) => match[1]);
assert.deepEqual(animationCalls, []);
assert.match(interactive, /map\.jumpTo\(next\)/);
assert.match(exporter, /this\.map\.jumpTo\(resolvedCamera\)/);
assert.doesNotMatch(deterministicPath, /setPadding\(|fitBounds\(|cameraForBounds\(|around:/);

const legacyVerticalFovDegrees = (2 * Math.atan(viewport.height / 2 / 700) * 180) / Math.PI;
const mapLibreDefaultFovDegrees = (0.6435011087932844 * 180) / Math.PI;
console.log(
  JSON.stringify(
    {
      transition: 'Diagnostic 2 -> Diagnostic 3',
      zoomPairs,
      sameCenterInvariant: { zoom: true, bearing: true, pitch: true },
      padding: 'No padding authored or applied; DEV runtime telemetry records map.getPadding().',
      animationApis: { playbackAndExport: animationCalls, compassOnlyEaseTo: true },
      feedback:
        'Canonical jumpTo is guarded by applyingCanonicalCamera; DEV telemetry records nativeSyncs/externalApplications.',
      fov: { legacyVerticalFovDegrees, mapLibreDefaultFovDegrees },
      flatVsGlobe:
        'Online MapLibre adapter is the Flat online path; Globe uses the separate WebGL globe renderer.',
      strongestCause:
        'The calibrated mapping converts a 2x Legacy scale change into one MapLibre level / 2x visual scale. Center, bearing, and pitch remain independently observable without zoom amplification.',
      samples,
    },
    null,
    2,
  ),
);
