import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const [planner, app, map, search, project, exporter] = await Promise.all([
  readFile(new URL('../src/core/routePlanner.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/OnlineOpenFreeMap.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/SearchPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/core/project.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/core/export.ts', import.meta.url), 'utf8'),
]);
for (const token of [
  'RoutePlannerSection',
  'startPointId',
  'endPointId',
  'reconcileRouteSections',
  'setRoutePlannerSectionPathType',
  'routeLayerFromSections',
])
  assert.match(planner, new RegExp(token));
assert.match(planner, /pathType: 'road' as const/);
assert.match(planner, /pathType !== 'air' && pathType !== 'custom'/);
assert.match(planner, /Built-in Great Circle/);
assert.match(planner, /Calculate every Route Section/);
assert.doesNotMatch(planner, /GraphHopper|automaticMultimodal|providerLeg/);
assert.match(app, /Route Sections/);
assert.match(app, /Calculate All/);
assert.match(app, /Built-in Maritime/);
assert.match(app, /Custom path required/);
assert.match(app, /Draw Path/);
assert.match(app, /Use Route/);
assert.match(search, /Set as Source/);
assert.match(search, /Set as Destination/);
assert.match(search, /Add Stop/);
assert.match(map, /routeCandidate/);
assert.match(project, /routePoints\?: RoutePoint\[\]/);
assert.match(planner, /convertCalculatedSectionToCustom/);
assert.match(planner, /\['road', 'maritime'\]\.includes\(section\.pathType\)/);
assert.match(app, /Turn to Custom/);
assert.match(map, /editorOverlayRevision/, 'draft overlays are restored after style reload');
assert.match(app, /routeCandidates=\{/);
assert.match(app, /plannerRouteCandidate/);
assert.match(app, /routePlannerDraftGeometries\(routePlanner\)/);
assert.match(map, /candidates[\s\S]*sectionIndex/);
const editorLayerBlockStart = app.indexOf('editingScene.layers');
assert.ok(editorLayerBlockStart >= 0);
const editorLayerBlock = app.slice(editorLayerBlockStart, editorLayerBlockStart + 500);
assert.doesNotMatch(
  editorLayerBlock,
  /layer\.id === editingRouteLayerId/,
  'Edit Route must neither remove nor dim the canonical accepted Route in editor rendering',
);
assert.match(
  editorLayerBlock,
  /\.filter\(\(layer\) => !eyeHidden\[layer\.id\]\)/,
  'normal per-layer eye visibility remains the only editor-layer filter',
);
assert.match(planner, /id: `accepted-\$\{section\.id\}`/);
assert.match(planner, /geometry: cloneGeometry\(accepted\.geometry\)/);
assert.doesNotMatch(
  exporter,
  /planRoute\(|OpenRouteServicePlanner|BuiltInMaritimePlanner/,
  'Export never routes',
);
console.log(
  'Online Route Planner: per-section modes, explicit engines, Search/pick, canonical Use Route, and output isolation passed.',
);
