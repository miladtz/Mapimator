import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-online-smooth-zoom-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/camera').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/cameraContinuity').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/cameraZoomPolicy').replaceAll('\\', '/')}';`,
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
      lib: { entry, formats: ['es'], fileName: () => 'core.mjs' },
    },
  });
  m = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const worldCenters = [
  { x: 420, y: 300 },
  { x: 500, y: 220 },
  { x: 590, y: 300 },
];
const cameraAt = (center, zoom, bearing = 0, pitch = 0) => ({
  x: m.CAMERA_VIEWPORT.width / 2 - center.x * zoom,
  y: m.CAMERA_VIEWPORT.height / 2 - center.y * zoom,
  zoom,
  bearing,
  pitch,
});
const centerOf = (camera) => ({
  x: (m.CAMERA_VIEWPORT.width / 2 - camera.x) / camera.zoom,
  y: (m.CAMERA_VIEWPORT.height / 2 - camera.y) / camera.zoom,
});
const buildChain = (zooms, renderer = 'online', bearing = 0, pitch = 0) => {
  const project = m.createProject('Zoom-aware Smooth chain');
  project.mapSettings.basemapRenderer = renderer;
  project.views = worldCenters.map((center, index) => {
    const view = m.createView(
      `View ${index + 1}`,
      [],
      cameraAt(center, zooms[index], bearing * index, pitch * index),
    );
    view.holdDuration = index === 2 ? 1 : 0;
    return view;
  });
  project.transitions = project.views.slice(0, -1).map((view, index) => {
    const transition = m.createTransition(view.id, project.views[index + 1].id, [], view);
    transition.duration = 2;
    transition.type = 'smooth';
    transition.preset = 'smooth';
    return transition;
  });
  return project;
};
const maxScreenDeviation = (project, transitionIndex) => {
  const fromCenter = worldCenters[transitionIndex];
  const toCenter = worldCenters[transitionIndex + 1];
  const chord = { x: toCenter.x - fromCenter.x, y: toCenter.y - fromCenter.y };
  const chordLength = Math.hypot(chord.x, chord.y);
  let maximum = 0;
  for (let step = 0; step <= 1000; step++) {
    const t = step / 1000;
    const camera = m.interpolateCameraChainTransition(project, transitionIndex, t);
    const center = centerOf(camera);
    const perpendicularWorldDistance =
      Math.abs(chord.y * (center.x - fromCenter.x) - chord.x * (center.y - fromCenter.y)) / chordLength;
    maximum = Math.max(maximum, perpendicularWorldDistance * camera.zoom);
  }
  return maximum;
};

const mapLibreLevels = [6, 10, 14, 18, 22];
const equalZoomMeasurements = mapLibreLevels.map((level) => {
  const authoredZoom = m.mapLibreZoomToMapMotionZoom(level);
  const project = buildChain([authoredZoom, authoredZoom, authoredZoom]);
  const legacyAssumptionProject = buildChain([authoredZoom, authoredZoom, authoredZoom], 'legacy');
  return {
    level,
    authoredZoom,
    beforeDeviation: maxScreenDeviation(legacyAssumptionProject, 0),
    deviation: maxScreenDeviation(project, 0),
  };
});
const deviations = equalZoomMeasurements.map((measurement) => measurement.deviation);
console.log('Online Smooth equal-zoom diagnostic:', JSON.stringify(equalZoomMeasurements));
assert.ok(Math.min(...deviations) > 1, 'Smooth remains visibly curved rather than becoming linear.');
assert.ok(
  Math.max(...deviations) / Math.min(...deviations) < 1.001,
  'Canonical screen deviation remains zoom-invariant through source and overzoom levels.',
);

const changingLevels = [8, 14, 18].map(m.mapLibreZoomToMapMotionZoom);
const changingProject = buildChain(changingLevels, 'online', 70, 25);
const changingZoomDeviations = [];
for (let transitionIndex = 0; transitionIndex < 2; transitionIndex++) {
  assert.deepEqual(
    m.interpolateCameraChainTransition(changingProject, transitionIndex, 0),
    changingProject.views[transitionIndex].camera,
    'Changing-zoom transition preserves its exact source endpoint.',
  );
  assert.deepEqual(
    m.interpolateCameraChainTransition(changingProject, transitionIndex, 1),
    changingProject.views[transitionIndex + 1].camera,
    'Changing-zoom transition preserves its exact destination endpoint.',
  );
  const changingDeviation = maxScreenDeviation(changingProject, transitionIndex);
  changingZoomDeviations.push(changingDeviation);
  assert.ok(
    Number.isFinite(changingDeviation) && changingDeviation < 200,
    'Changing-zoom curvature remains finite with strong Bearing and Pitch.',
  );
}
const incomingNear = centerOf(m.interpolateCameraChainTransition(changingProject, 0, 1 - 1e-5));
const outgoingNear = centerOf(m.interpolateCameraChainTransition(changingProject, 1, 1e-5));
const waypoint = worldCenters[1];
const incomingDirection = { x: waypoint.x - incomingNear.x, y: waypoint.y - incomingNear.y };
const outgoingDirection = { x: outgoingNear.x - waypoint.x, y: outgoingNear.y - waypoint.y };
assert.ok(
  incomingDirection.x * outgoingDirection.x + incomingDirection.y * outgoingDirection.y > 0,
  'Zero-Hold waypoint retains a compatible shared center tangent.',
);

const worldFromLngLat = (longitude, latitude) => ({
  x: ((longitude + 180) / 360) * m.CAMERA_VIEWPORT.width,
  y: ((90 - latitude) / 180) * m.CAMERA_VIEWPORT.height,
});
const lngLatFromWorld = ({ x, y }) => ({
  longitude: (x / m.CAMERA_VIEWPORT.width) * 360 - 180,
  latitude: 90 - (y / m.CAMERA_VIEWPORT.height) * 180,
});
const sampleProgress = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
const southeastAsiaCenters = [
  worldFromLngLat(101.5, 8.5),
  worldFromLngLat(104.9282, 11.5564),
  worldFromLngLat(106.7, 10.8),
];
const southeastAsiaProject = buildChain(
  [6, 16, 12].map(m.mapLibreZoomToMapMotionZoom),
  'online',
  18,
  25,
);
southeastAsiaProject.views.forEach((view, index) => {
  view.camera = cameraAt(southeastAsiaCenters[index], view.camera.zoom, 18 * index, 25 * index);
});
const southeastAsiaSamples = sampleProgress.map((progress) => {
  const camera = m.interpolateCameraChainTransition(southeastAsiaProject, 0, progress);
  const center = centerOf(camera);
  const geographic = lngLatFromWorld(center);
  assert.ok(Number.isFinite(geographic.longitude) && Number.isFinite(geographic.latitude));
  assert.ok(
    geographic.longitude >= 100 && geographic.longitude <= 106 && geographic.latitude >= 7 && geographic.latitude <= 13,
    'Wide Southeast Asia to zoomed Cambodia remains on the geographically continuous local world copy.',
  );
  return { progress, ...geographic, zoom: camera.zoom, world: center };
});
const rejectedSoutheastAsiaSamples = southeastAsiaSamples.map((sample) => {
  const linear = {
    x: southeastAsiaCenters[0].x + (southeastAsiaCenters[1].x - southeastAsiaCenters[0].x) * sample.progress,
    y: southeastAsiaCenters[0].y + (southeastAsiaCenters[1].y - southeastAsiaCenters[0].y) * sample.progress,
  };
  const interior = 4 * sample.progress * (1 - sample.progress);
  const referenceZoom = Math.min(
    southeastAsiaProject.views[0].camera.zoom,
    southeastAsiaProject.views[1].camera.zoom,
  );
  const magnification = Math.max(1, sample.zoom / referenceZoom);
  const rejectedWorld = {
    x: linear.x + (sample.world.x - linear.x) / (1 + interior * (magnification - 1)),
    y: linear.y + (sample.world.y - linear.y) / (1 + interior * (magnification - 1)),
  };
  return { progress: sample.progress, ...lngLatFromWorld(rejectedWorld), world: rejectedWorld };
});

// Lock the accepted evaluator: geographic/world-space Hermite interpolation
// with its existing visually calibrated endpoint tangents, and no interior
// zoom-dependent normalization or movement clamp.
const hermiteReference = (start, end, startVelocity, endVelocity, duration, t) =>
  (2 * t ** 3 - 3 * t ** 2 + 1) * start +
  (t ** 3 - 2 * t ** 2 + t) * duration * startVelocity +
  (-2 * t ** 3 + 3 * t ** 2) * end +
  (t ** 3 - t ** 2) * duration * endVelocity;
const referenceVelocity = (index, component) => {
  if (!m.isPassThroughCameraWaypoint(southeastAsiaProject, index)) return 0;
  const previous = southeastAsiaCenters[index - 1];
  const next = southeastAsiaCenters[index + 1];
  const waypointZoom = southeastAsiaProject.views[index].camera.zoom;
  return ((next[component] - previous[component]) / 4) * (m.SMOOTH_VISUAL_REFERENCE_ZOOM / waypointZoom);
};
for (const sample of southeastAsiaSamples) {
  const expected = {
    x: hermiteReference(
      southeastAsiaCenters[0].x,
      southeastAsiaCenters[1].x,
      referenceVelocity(0, 'x'),
      referenceVelocity(1, 'x'),
      2,
      sample.progress,
    ),
    y: hermiteReference(
      southeastAsiaCenters[0].y,
      southeastAsiaCenters[1].y,
      referenceVelocity(0, 'y'),
      referenceVelocity(1, 'y'),
      2,
      sample.progress,
    ),
  };
  assert.ok(Math.abs(sample.world.x - expected.x) < 1e-5 && Math.abs(sample.world.y - expected.y) < 1e-5);
}

const wrappedCenters = [
  worldFromLngLat(179, 5),
  worldFromLngLat(181, 6),
  worldFromLngLat(183, 7),
];
const wrappedProject = buildChain([10, 10, 10].map(m.mapLibreZoomToMapMotionZoom));
wrappedProject.views.forEach((view, index) => {
  view.camera = cameraAt(wrappedCenters[index], view.camera.zoom);
});
const wrappedLongitudes = sampleProgress.map((progress) =>
  lngLatFromWorld(centerOf(m.interpolateCameraChainTransition(wrappedProject, 0, progress))).longitude,
);
assert.ok(
  wrappedLongitudes.every((longitude, index) => index === 0 || longitude >= wrappedLongitudes[index - 1]),
  'Smooth interpolation preserves the authored continuous world copy across the antimeridian.',
);
assert.ok(
  wrappedLongitudes.every((longitude) => longitude >= 179 && longitude <= 181),
  'Longitude is not normalized to a distant wrapped copy during interpolation.',
);

const overlayInvariantProject = buildChain(changingLevels, 'online', 70, 25);
const baselineSamples = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map((progress) =>
  m.interpolateCameraChainTransition(overlayInvariantProject, 1, progress),
);
for (const layers of [
  [],
  [{ ...m.createLayer('text'), textScaleWithMapZoom: false, textOrientation: 'face-camera' }],
  [{ ...m.createLayer('text'), textScaleWithMapZoom: true, textOrientation: 'flat-on-map' }],
  [{ ...m.createLayer('shape'), shapeKind: 'rectangle' }],
  [{ ...m.createLayer('shape'), shapeKind: 'arrow', shapeOrientation: 'face-camera' }],
  [
    { ...m.createLayer('text'), textScaleWithMapZoom: true, textOrientation: 'face-camera' },
    { ...m.createLayer('shape'), shapeKind: 'arrow', shapeOrientation: 'face-camera' },
  ],
]) {
  overlayInvariantProject.layers = layers;
  assert.deepEqual(
    [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map((progress) =>
      m.interpolateCameraChainTransition(overlayInvariantProject, 1, progress),
    ),
    baselineSamples,
    'Text/Shape presence, map scaling, and orientation cannot affect the evaluated camera path.',
  );
}

const legacyProject = buildChain([3, 3, 3], 'legacy');
const legacyActual = m.interpolateCameraChainTransition(legacyProject, 0, 0.37);
const legacyExpectedX = (() => {
  const t = 0.37;
  const duration = 2;
  const velocity = (legacyProject.views[2].camera.x - legacyProject.views[0].camera.x) / 4;
  return (
    (2 * t ** 3 - 3 * t ** 2 + 1) * legacyProject.views[0].camera.x +
    (-2 * t ** 3 + 3 * t ** 2) * legacyProject.views[1].camera.x +
    (t ** 3 - t ** 2) * duration * velocity
  );
})();
assert.equal(
  legacyActual.x,
  m.roundCamera({ x: legacyExpectedX, y: 0, zoom: 1 }).x,
  'Legacy x path is unchanged.',
);

console.log(
  'Online Smooth zoom invariance:',
  JSON.stringify({
    equalZoomMeasurements,
    changingZoomDeviations,
    southeastAsiaSamples,
    rejectedSoutheastAsiaSamples,
    wrappedLongitudes,
  }),
);
