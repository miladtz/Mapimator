import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-shapes-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectPersistence').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/shapes').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/openFreeMapAdapter').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/onlineProjectOverlays').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/viewCompiler').replaceAll('\\', '/')}';`,
  ].join('\n'),
);
let core;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: { outDir, emptyOutDir: false, minify: false, lib: { entry, formats: ['es'], fileName: () => 'core.mjs' } },
  });
  core = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const kinds = ['rectangle', 'square', 'ellipse', 'circle', 'triangle', 'regular-polygon', 'polyline', 'polygon', 'free-draw', 'arrow'];
for (const kind of kinds)
  assert.equal(core.supportsDrawShape(kind), true, `${kind} exposes Draw Shape`);
const optionValues = (kind) =>
  core.getAppearOptionsForLayer(core.createShapeLayerAt(kind, 480, 270)).map(({ value }) => value);
for (const kind of kinds)
  assert.deepEqual(
    optionValues(kind),
    ['fade', 'pop', 'drop', 'draw-shape'],
    `the rendered ${kind} selector receives Draw Shape`,
  );
const shapes = kinds.map((kind, index) => core.createShapeLayerAt(kind, 300 + index * 50, 240));
assert.equal(new Set(shapes.map((shape) => shape.id)).size, kinds.length);
assert.ok(shapes.every((shape) => shape.shapePoints.length >= 2));
assert.ok(shapes.every((shape) => new Set(shape.shapePoints.map((point) => point.id)).size === shape.shapePoints.length));

const polygon = shapes[7];
const authored = structuredClone(polygon.shapePoints);
const exact = core.renderedShapeCoordinates({ ...polygon, shapeRoundness: 0 }).coordinates;
assert.deepEqual(exact, authored.map(({ x, y }) => [x, y]));
const rounded = core.renderedShapeCoordinates({ ...polygon, shapeRoundness: 75 }).coordinates;
assert.ok(rounded.length > exact.length, 'Roundness derives a visibly smoother sampled path');
assert.deepEqual(polygon.shapePoints, authored, 'Roundness never mutates authored points');
assert.deepEqual(core.renderedShapeCoordinates({ ...polygon, shapeRoundness: 0 }).coordinates, exact);

const line = shapes[6];
const firstId = line.shapePoints[0].id;
const inserted = core.insertShapePoint(line, firstId);
assert.equal(inserted.shapePoints.length, line.shapePoints.length + 1);
assert.deepEqual(line.shapePoints, shapes[6].shapePoints, 'editing is immutable');
const movedPoint = core.updateShapePoint(inserted, firstId, 12, 34);
assert.deepEqual(movedPoint.shapePoints.find((point) => point.id === firstId), { id: firstId, x: 12, y: 34 });
assert.equal(core.deleteShapePoint(movedPoint, inserted.shapePoints[1].id).shapePoints.length, line.shapePoints.length);
const movedShape = core.moveShape(line, 10, -5);
assert.equal(movedShape.shapePoints[0].x, line.shapePoints[0].x + 10);

const arrow = shapes[9];
const arrowAuthored = structuredClone(arrow.shapePoints);
const straight = core.renderedShapeCoordinates({ ...arrow, shapeRoundness: 0 }).coordinates;
assert.equal(arrow.shapePoints.length, 2);
assert.deepEqual(straight[0], [arrowAuthored[0].x, arrowAuthored[0].y]);
assert.deepEqual(straight.at(-1), [arrowAuthored.at(-1).x, arrowAuthored.at(-1).y]);
assert.equal(straight.length, 65);
assert.deepEqual(arrow.shapePoints, arrowAuthored);
assert.equal(core.insertShapePoint(arrow, arrow.shapePoints.at(-1).id), arrow, 'nothing can follow the head');
assert.equal(core.deleteShapePoint(arrow, arrow.shapePoints[0].id), arrow, 'tail cannot be deleted');
assert.equal(core.deleteShapePoint(arrow, arrow.shapePoints.at(-1).id), arrow, 'head cannot be deleted');
const reshapedArrow = core.updateShapePoint(arrow, arrow.shapePoints[1].id, 710, 180);
assert.notDeepEqual(core.renderedShapeCoordinates(reshapedArrow).coordinates, straight);
const positiveArc = core.parabolicArrowCoordinates({ ...arrow, shapeArrowStartAngle: 35 });
const negativeArc = core.parabolicArrowCoordinates({ ...arrow, shapeArrowStartAngle: -35 });
const chordStart = core.shapeWorldToMercatorMeters(...straight[0]);
const chordEnd = core.shapeWorldToMercatorMeters(...straight.at(-1));
const chordDx = chordEnd[0] - chordStart[0];
const chordDy = chordEnd[1] - chordStart[1];
const chordLength = Math.hypot(chordDx, chordDy);
const normal = [-chordDy / chordLength, chordDx / chordLength];
const signedOffset = (coordinate) => { const metric = core.shapeWorldToMercatorMeters(...coordinate); return (metric[0] - chordStart[0]) * normal[0] + (metric[1] - chordStart[1]) * normal[1]; };
assert.ok(signedOffset(positiveArc[32]) * signedOffset(negativeArc[32]) < 0);
assert.ok(Math.abs(signedOffset(straight[32])) < 1e-5);
const head = core.arrowHeadCoordinates(arrow);
assert.deepEqual(head[0], straight.at(-1), 'arrowhead tip is the final path point');
assert.notDeepEqual(
  core.arrowHeadCoordinates({ ...arrow, shapeArrowHeadSize: 8, shapeArrowHeadAngle: 25 }),
  core.arrowHeadCoordinates({ ...arrow, shapeArrowHeadSize: 30, shapeArrowHeadAngle: 80 }),
);
assert.deepEqual(core.arrowHeadCoordinates({ ...arrow, shapeArrowheadEnabled: false }), []);
const arrowOutput = core.onlineShapeFeatureCollection([arrow], null);
assert.equal(arrowOutput.features.length, 2, 'canonical Arrow is one parabola plus one optional head');
assert.equal(arrowOutput.features.filter((feature) => feature.geometry.type === 'LineString').length, 1);

const square = core.resizeExactShape(shapes[1], { widthKm: 1000 });
assert.equal(square.shapeWidthKm, square.shapeHeightKm);
const squareProjected = square.shapePoints.map((item) => core.shapeWorldToMercatorMeters(item.x, item.y));
assert.ok(Math.abs(Math.abs(squareProjected[1][0] - squareProjected[0][0]) - Math.abs(squareProjected[1][1] - squareProjected[0][1])) < 1e-5);
const circle = core.updateShapePoint(shapes[3], shapes[3].shapePoints[0].id, 100, 120);
assert.ok(Math.abs(circle.shapeWidthKm - circle.shapeHeightKm) < 1e-9);
assert.ok(Math.abs(circle.shapeRadiusKm - circle.shapeWidthKm / 2) < 1e-9);
const triangle = shapes[4];
assert.equal(triangle.shapePoints.length, 3);
const triangleCenter = core.shapeWorldToMercatorMeters(triangle.x, triangle.y);
const triangleRadii = triangle.shapePoints.map((item) => { const projected = core.shapeWorldToMercatorMeters(item.x, item.y); return Math.hypot(projected[0] - triangleCenter[0], projected[1] - triangleCenter[1]); });
assert.ok(triangleRadii.every((radius) => Math.abs(radius - triangleRadii[0]) < 1e-5));
const heptagon = core.resizeExactShape(shapes[5], { sides: 7, radiusKm: 700, rotation: 15 });
assert.equal(heptagon.shapePoints.length, 7);
assert.equal(heptagon.shapeRegularSides, 7);

const duplicate = core.duplicateShapeIdentity(polygon);
assert.deepEqual(duplicate.shapePoints.map(({ x, y }) => [x, y]), polygon.shapePoints.map(({ x, y }) => [x, y]));
assert.equal(new Set([...duplicate.shapePoints, ...polygon.shapePoints].map((point) => point.id)).size, polygon.shapePoints.length * 2);
const noisy = [
  { id: 'a', x: 0, y: 0 },
  { id: 'b', x: 1, y: 0.01 },
  { id: 'c', x: 2, y: 0 },
];
assert.deepEqual(core.simplifyShapePoints(noisy, 0.1).map((point) => point.id), ['a', 'c']);

const project = core.createProject('Shape persistence');
project.layers = shapes;
const reopened = core.validateAndMigrateProject(JSON.parse(JSON.stringify(project)));
assert.deepEqual(reopened.layers, project.layers);
const legacyArrowProject = core.createProject('Legacy Arrow endpoints');
const legacyArrow = structuredClone(arrow);
legacyArrow.shapePoints = [
  legacyArrow.shapePoints[0],
  { id: 'obsolete-a', x: 450, y: 210 },
  { id: 'obsolete-b', x: 500, y: 270 },
  legacyArrow.shapePoints.at(-1),
];
delete legacyArrow.shapeArrowStartAngle;
legacyArrow.shapeArrowBend = 25;
legacyArrowProject.layers = [legacyArrow];
const normalizedArrow = core.validateAndMigrateProject(legacyArrowProject).layers[0];
assert.deepEqual(normalizedArrow.shapePoints.map(({ id }) => id), [legacyArrow.shapePoints[0].id, legacyArrow.shapePoints.at(-1).id]);
assert.equal(normalizedArrow.shapeArrowStartAngle, 20);
const data = core.onlineShapeFeatureCollection(shapes, polygon.id);
assert.equal(data.features.filter((feature) => feature.properties.featureKind === 'handle').length, polygon.shapePoints.length);
assert.equal(data.features.filter((feature) => feature.properties.featureKind !== 'handle').length, kinds.length + 1);
const arrowLine = data.features.find((feature) => feature.id === `${arrow.id}-geometry`);
assert.equal(arrowLine.properties.strokeWidth, arrow.shapeStrokeWidth);
assert.equal(data.features.find((feature) => feature.id === `${arrow.id}-arrowhead`).properties.featureKind, 'arrowhead');
assert.equal(core.onlineShapeFeatureCollection([{ ...arrow, shapeArrowheadEnabled: false }], null).features.length, 1);
assert.deepEqual(core.onlineShapeFeatureCollection(shapes, null), core.onlineShapeFeatureCollection(shapes, null));

const timelineProject = core.createProject('Shape timeline');
const timelineArrow = { ...structuredClone(arrow), id: 'shape-timeline-arrow', visible: true };
const timelineCircle = { ...structuredClone(shapes[3]), id: 'shape-timeline-circle', visible: true };
timelineProject.layers = [timelineArrow, timelineCircle];
const timelineCamera = { x: 0, y: 0, zoom: 4, bearing: 35, pitch: 55 };
const timelineViewA = core.createView('Shape A', timelineProject.layers, timelineCamera, timelineProject.layers);
const timelineViewB = core.createView('Shape B', [timelineCircle], timelineCamera, timelineProject.layers);
timelineViewA.holdDuration = 3;
timelineViewB.holdDuration = 2;
timelineViewA.layerConfigs[timelineArrow.id].animation = {
  appearEnabled: true,
  appearType: 'draw-shape',
  appearDelay: 0,
  appearDuration: 2,
  wipeDelay: 0.25,
  shapeOrientation: 'face-camera',
};
timelineProject.views = [timelineViewA, timelineViewB];
const timelineTransition = core.createTransition(
  timelineViewA.id,
  timelineViewB.id,
  timelineProject.layers,
);
timelineTransition.duration = 2;
timelineTransition.layerConfigs[timelineArrow.id] = {
  included: true,
  animation: { shapeOrientation: 'flat-on-map' },
};
timelineProject.transitions = [timelineTransition];

const halfDraw = core
  .evaluateProjectAtTime(timelineProject, 1)
  .layers.find((layer) => layer.id === timelineArrow.id);
assert.equal(halfDraw.shapePathProgress, 0.5, 'Draw Shape uses exact linear timeline progress');
assert.equal(halfDraw.shapeOrientation, 'face-camera');
assert.equal(halfDraw.opacity, timelineArrow.opacity, 'Draw Shape reveals geometry without fading it');
assert.ok(core.evaluatedShapeCoordinates(halfDraw).coordinates.length > 1);
assert.deepEqual(core.arrowHeadCoordinates(halfDraw), [], 'the directional head waits for the path');
const repeatedHalfDraw = core.evaluateProjectAtTime(timelineProject, 1);
assert.deepEqual(
  repeatedHalfDraw,
  core.evaluateProjectAtTime(timelineProject, 1),
  'Shape timeline seek is deterministic',
);
assert.ok(
  !core.evaluateProjectAtTime(timelineProject, 5.5).layers.some((layer) => layer.id === timelineArrow.id),
  'Shape existence is independently scoped to each View',
);
assert.ok(
  core.evaluateProjectAtTime(timelineProject, 3.5).layers.some((layer) => layer.id === timelineArrow.id),
  'Transition Shape membership is independent from the destination View',
);

const unequalPath = [
  [core.lngLatToMapMotionWorld(0, 0).x, core.lngLatToMapMotionWorld(0, 0).y],
  [core.lngLatToMapMotionWorld(1, 0).x, core.lngLatToMapMotionWorld(1, 0).y],
  [core.lngLatToMapMotionWorld(9, 0).x, core.lngLatToMapMotionWorld(9, 0).y],
];
const halfDistance = core.shapePathPrefixByDistance(unequalPath, 0.5);
const halfDistanceLng = core.mapMotionWorldToLngLat(...halfDistance.at(-1))[0];
assert.ok(Math.abs(halfDistanceLng - 4.5) < 1e-6, 'Draw/Wipe path progress uses distance, not vertex index');

timelineViewA.layerConfigs[timelineArrow.id].animation = {
  wipeEnabled: true,
  wipeDelay: 0,
  wipeDuration: 2,
  shapeOrientation: 'flat-on-map',
};
const halfWipe = core
  .evaluateProjectAtTime(timelineProject, 1)
  .layers.find((layer) => layer.id === timelineArrow.id);
assert.equal(halfWipe.shapePathProgress, 0.5);
assert.equal(halfWipe.opacity, timelineArrow.opacity, 'path Wipe removes distance without a second fade');
timelineViewA.layerConfigs[timelineCircle.id].animation = {
  wipeEnabled: true,
  wipeDelay: 0,
  wipeDuration: 2,
};
const circleWipe = core
  .evaluateProjectAtTime(timelineProject, 1)
  .layers.find((layer) => layer.id === timelineCircle.id);
assert.equal(circleWipe.shapePathProgress, 1, 'filled primitives retain complete geometry during Wipe');
assert.ok(circleWipe.opacity > 0 && circleWipe.opacity < timelineCircle.opacity);

for (const appearType of ['fade', 'pop', 'drop']) {
  timelineViewA.layerConfigs[timelineArrow.id].animation = {
    appearEnabled: true,
    appearType,
    appearDuration: 2,
  };
  const evaluated = core
    .evaluateProjectAtTime(timelineProject, 1)
    .layers.find((layer) => layer.id === timelineArrow.id);
  assert.ok(evaluated.opacity > 0 && evaluated.opacity < timelineArrow.opacity);
  if (appearType === 'pop') assert.ok(evaluated.shapeAnimationScale > 0.85 && evaluated.shapeAnimationScale < 1);
  if (appearType === 'drop') assert.ok(evaluated.shapeDropOffsetY < 0);
}

timelineViewA.layerConfigs[timelineArrow.id].animation = {
  appearEnabled: true,
  appearType: 'draw-shape',
  appearDuration: 2,
  shapeOrientation: 'face-camera',
};
const reopenedTimeline = core.validateAndMigrateProject(JSON.parse(JSON.stringify(timelineProject)));
assert.deepEqual(
  reopenedTimeline.views[0].layerConfigs[timelineArrow.id].animation,
  timelineViewA.layerConfigs[timelineArrow.id].animation,
  'Shape timeline usage persists by stable Shape ID',
);
assert.equal(timelineProject.layers[0].shapePathProgress, undefined, 'evaluation never mutates project Shapes');

for (const kind of kinds) {
  const pathLayer = { ...core.createShapeLayerAt(kind, 480, 270), id: `draw-${kind}` };
  const drawProject = core.createProject(`Draw ${kind}`);
  drawProject.layers = [pathLayer];
  const drawView = core.createView('Draw', [pathLayer], timelineCamera, drawProject.layers);
  drawView.holdDuration = 3;
  drawView.layerConfigs[pathLayer.id].animation = {
    appearEnabled: true,
    appearType: 'draw-shape',
    appearDuration: 2,
  };
  drawProject.views = [drawView];
  const partial = core.evaluateProjectAtTime(drawProject, 1).layers[0];
  const complete = core.evaluateProjectAtTime(drawProject, 2.1).layers[0];
  assert.equal(partial.shapePathProgress, 0.5, `${kind} receives Draw Shape progress`);
  assert.ok(
    core.evaluatedShapeCoordinates(partial).coordinates.length <=
      core.evaluatedShapeCoordinates(complete).coordinates.length,
  );
  if (
    ['rectangle', 'square', 'ellipse', 'circle', 'triangle', 'regular-polygon', 'polygon'].includes(
      kind,
    )
  ) {
    assert.equal(core.evaluatedShapeCoordinates(partial).closed, false);
    assert.equal(core.evaluatedShapeCoordinates(complete).closed, true);
    assert.deepEqual(
      core.evaluatedShapeCoordinates(partial).coordinates[0],
      core.renderedShapeCoordinates(pathLayer).coordinates[0],
      `${kind} begins at deterministic rendered coordinate zero`,
    );
  }
  if (kind === 'arrow') assert.deepEqual(core.arrowHeadCoordinates(partial), []);
}

const flatFeatures = core.onlineShapeFeatureCollection(
  [{ ...timelineArrow, shapeOrientation: 'flat-on-map' }],
  null,
);
const fakeMap = {
  getZoom: () => 4,
  project: ({ lng, lat }) => ({ x: 800 + lng * 8, y: 450 - lat * 3 }),
  unproject: ([x, y]) => ({ lng: (x - 800) / 8, lat: (450 - y) / 3 }),
};
const faceFeatures = core.onlineShapeFeatureCollection(
  [{ ...timelineArrow, shapeOrientation: 'face-camera' }],
  null,
  fakeMap,
);
assert.equal(flatFeatures.features.filter((feature) => feature.id.endsWith('-geometry')).length, 1);
assert.equal(faceFeatures.features.filter((feature) => feature.id.endsWith('-geometry')).length, 1);
assert.notDeepEqual(
  faceFeatures.features.find((feature) => feature.id.endsWith('-geometry')).geometry.coordinates,
  flatFeatures.features.find((feature) => feature.id.endsWith('-geometry')).geometry.coordinates,
  'Face Camera and Flat on Map are exclusive render transforms, not duplicate features',
);

for (const latitude of [0, 35, 60]) {
  const center = core.lngLatToMapMotionWorld(20, latitude);
  const centerMeters = core.shapeWorldToMercatorMeters(center.x, center.y);
  const exactCircle = core.createShapeLayerAt('circle', center.x, center.y);
  const circleRadii = core.renderedShapeCoordinates(exactCircle).coordinates.map(([x, y]) => { const projected = core.shapeWorldToMercatorMeters(x, y); return Math.hypot(projected[0] - centerMeters[0], projected[1] - centerMeters[1]); });
  assert.ok(Math.max(...circleRadii) - Math.min(...circleRadii) < 1e-5, `circle at ${latitude} degrees`);
  const exactSquare = core.createShapeLayerAt('square', center.x, center.y);
  const squareMeters = core.renderedShapeCoordinates(exactSquare).coordinates.map(([x, y]) => core.shapeWorldToMercatorMeters(x, y));
  const sideLengths = squareMeters.map((point, index) => { const next = squareMeters[(index + 1) % squareMeters.length]; return Math.hypot(next[0] - point[0], next[1] - point[1]); });
  assert.ok(Math.max(...sideLengths) - Math.min(...sideLengths) < 1e-5, `square at ${latitude} degrees`);
  const hexagon = core.resizeExactShape(core.createShapeLayerAt('regular-polygon', center.x, center.y), { sides: 6, radiusKm: 300 });
  const hexRadii = hexagon.shapePoints.map((item) => { const projected = core.shapeWorldToMercatorMeters(item.x, item.y); return Math.hypot(projected[0] - centerMeters[0], projected[1] - centerMeters[1]); });
  assert.ok(Math.max(...hexRadii) - Math.min(...hexRadii) < 1e-5, `hexagon at ${latitude} degrees`);
}

const overlay = readFileSync(join(root, 'src/core/onlineProjectOverlays.ts'), 'utf8');
assert.match(overlay, /shapeRenderLayerIds/);
assert.match(overlay, /orderShapeRenderLayers/);
const ordered = core.orderedShapeRenderLayerIds([shapes[0], shapes[9]]);
assert.deepEqual(ordered.slice(0, 3), Object.values(core.shapeRenderLayerIds(shapes[0].id)));
assert.deepEqual(ordered.slice(3), Object.values(core.shapeRenderLayerIds(shapes[9].id)));
assert.match(overlay, /shapeSource\.setData\(shapeData/);
const offline = readFileSync(join(root, 'src/components/OfflineMap.tsx'), 'utf8');
assert.match(offline, /evaluatedShapeCoordinates\(layer\)/);
const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
assert.doesNotMatch(app, /function ShapeTimelineControls/, 'Shape has no duplicate Timeline component');
assert.equal(
  app.match(/data-shape-timeline-settings=/g)?.length,
  2,
  'the existing View and Transition branches are the only Shape timeline presentation paths',
);
assert.match(app, /const appearOptions = getAppearOptionsForLayer\(layer\)/);
assert.equal(
  app.match(/appearOptions\.map\(\(option\) =>/g)?.length,
  2,
  'both actual View and Transition selectors consume the shared final option list',
);
assert.match(app, /layer\.type === 'shape' && layer\.shapeKind === 'arrow'[\s\S]*Orientation/);
assert.ok(
  app.indexOf('className="pin-section shape-properties"') <
    app.indexOf('data-shape-timeline-settings='),
  'canonical Shape properties are declared before View/Transition usage controls',
);
assert.match(app, /map-frame[\s\S]*shape-authoring-actions/);
assert.match(app, /Drawing Polygon/);
for (const action of ['Finish', 'Undo', 'Cancel']) assert.match(app, new RegExp(`>\\s*${action}\\s*<`));
assert.match(app, /shapeDraft\.length === 0/);
assert.match(app, /shapeKindToPlace === 'polygon' && shapeDraft\.length > 1/);
assert.match(app, /shapeDraftKind=\{placing === 'shape'/);
assert.match(app, /shapeDraft=\{/);
assert.match(app, /Arrow Start added/);
const styles = readFileSync(join(root, 'src/styles/global.css'), 'utf8');
assert.match(styles, /\.shape-authoring-actions\s*\{[\s\S]*position: absolute;[\s\S]*z-index: 40;/);
const onlineMap = readFileSync(join(root, 'src/components/OnlineOpenFreeMap.tsx'), 'utf8');
assert.match(onlineMap, /shapeDraftKindRef/);
assert.match(onlineMap, /mapmotion-shape-draft/);
assert.match(onlineMap, /shapeDraftFeatureCollection\(shapeDraft, shapeKind, pointer\)/);

console.log('Online Shapes: editable arrows, exact primitives, ordering, persistence, and render parity passed.');
