import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'route-path-stops-'));
const entry = join(out, 'entry.ts');
const source = (path) => join(root, path).replaceAll('\\', '/');
writeFileSync(
  entry,
  `export * from '${source('src/core/routePlanner')}'; export * from '${source('src/core/customRoutePath')}';`,
);
let route;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: out,
      emptyOutDir: false,
      minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'module.mjs' },
    },
  });
  route = await import(pathToFileURL(join(out, 'module.mjs')).href);
} finally {
  rmSync(out, { recursive: true, force: true });
}

const point = (id, longitude, latitude) => ({ id, name: id, longitude, latitude });
const sourcePoint = point('source', 0, 0);
const destinationPoint = point('destination', 10, 5);
const controls = Array.from({ length: 9 }, (_, index) =>
  route.createCustomRouteControlPoint(index + 1, (index + 1) / 2, `control-${index + 1}`),
);
let draft = route.createRoutePlannerDraft();
draft = route.setRoutePlannerPoint(draft, 'source', sourcePoint);
draft = route.setRoutePlannerPoint(draft, 'destination', destinationPoint);
draft = route.setRoutePlannerSectionPathType(draft, draft.sections[0].id, 'custom');
draft = route.setCustomRouteSection(draft, draft.sections[0].id, route.customRouteSettings('exact', controls));

const wholeGeometry = (value) =>
  value.sections.flatMap((section, index) => {
    const geometry = section.plans.find((plan) => plan.id === section.selectedPlanId).geometry;
    return index ? geometry.slice(1) : geometry;
  });
const originalGeometry = wholeGeometry(draft);
const initial = route.routePathStopCandidateGroups(draft);
assert.equal(initial.length, 1);
assert.equal(new Set(initial[0].candidates.map((candidate) => candidate.id)).size, controls.length);
assert.deepEqual(initial[0].candidates.map((candidate) => candidate.displayNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9]);

let boundaryDraft = route.setCustomRouteSection(
  draft,
  draft.sections[0].id,
  route.customRouteSettings('exact', [
    route.createCustomRouteControlPoint(sourcePoint.longitude, sourcePoint.latitude, 'source-duplicate'),
    route.createCustomRouteControlPoint(5, 2.5, 'valid-interior'),
    route.createCustomRouteControlPoint(destinationPoint.longitude, destinationPoint.latitude, 'destination-duplicate'),
  ]),
);
const boundaryCandidates = route.routePathStopCandidateGroups(boundaryDraft)[0].candidates;
assert.deepEqual(boundaryCandidates.map((candidate) => candidate.localPointId), ['valid-interior']);
assert.equal(boundaryCandidates[0].displayNumber, 1, 'Source exclusion starts the first Section at Point 1');

const snappedSourceDraft = route.setCustomRouteSection(
  draft,
  draft.sections[0].id,
  route.customRouteSettings('exact', [
    route.createCustomRouteControlPoint(0.0001, 0.0001, 'snapped-source'),
    route.createCustomRouteControlPoint(5, 2.5, 'normal-interior'),
    route.createCustomRouteControlPoint(destinationPoint.longitude, destinationPoint.latitude, 'destination-duplicate'),
  ]),
);
const snappedSourceCandidates = route.routePathStopCandidateGroups(snappedSourceDraft)[0].candidates;
assert.deepEqual(
  snappedSourceCandidates.map((candidate) => candidate.localPointId),
  ['normal-interior'],
  'provider-snapped Source A is excluded while a normal interior point remains available',
);
assert.equal(snappedSourceCandidates[0].displayNumber, 1, 'the first Section starts candidate numbering at 1');

let selected = [];
selected = route.toggleRoutePathStopCandidate(selected, initial[0].candidates[1].id);
selected = route.toggleRoutePathStopCandidate(selected, initial[0].candidates[5].id);
assert.deepEqual(selected, [initial[0].candidates[1].id, initial[0].candidates[5].id]);
selected = route.toggleRoutePathStopCandidate(selected, initial[0].candidates[1].id);
assert.deepEqual(selected, [initial[0].candidates[5].id]);
selected = route.toggleRoutePathStopCandidate(selected, initial[0].candidates[5].id);
assert.deepEqual(selected, []);

draft = route.promoteSelectedCustomControlsToStops(draft, [
  initial[0].candidates[5].id,
  initial[0].candidates[1].id,
  initial[0].candidates[3].id,
]);
assert.equal(draft.sections.length, 4);
assert.ok(draft.sections.every((section) => section.pathType === 'custom' && section.status === 'ready'));
assert.deepEqual(wholeGeometry(draft), originalGeometry, 'first segmentation preserves exact geometry');
const afterFirst = route.routePathStopCandidateGroups(draft);
assert.equal(afterFirst.length, 4, 'all current children with interior controls contribute candidates');
assert.equal(new Set(afterFirst.flatMap((group) => group.candidates.map((candidate) => candidate.id))).size,
  afterFirst.flatMap((group) => group.candidates).length, 'candidate IDs are unique across Sections');
assert.ok(afterFirst.every((group) => group.candidates[0].localPointIndex === 0), 'numbering restarts per Section');

const untouched = draft.sections[1];
const reverseSelection = [afterFirst[3].candidates[0].id, afterFirst[0].candidates[0].id];
const afterSecond = route.promoteSelectedCustomControlsToStops(draft, reverseSelection);
assert.deepEqual(wholeGeometry(afterSecond), originalGeometry, 'cross-Section reverse selection preserves Route order');
assert.equal(afterSecond.sections.find((section) => section.id === untouched.id), untouched, 'unselected Section is untouched');
assert.ok(afterSecond.sections.every((section) => section.pathType === 'custom' && section.status === 'ready'));
assert.ok(route.routePathStopCandidateGroups(afterSecond).every((group) =>
  afterSecond.sections.some((section) => section.id === group.sectionId)), 'repeated candidates derive only from current children');

const mixed = {
  ...afterSecond,
  sections: afterSecond.sections.map((section, index) => index === 1 ? { ...section, pathType: 'air' } : section),
};
assert.ok(route.routePathStopCandidateGroups(mixed).every((group) => group.sectionId !== mixed.sections[1].id));

const mapSource = readFileSync(join(root, 'src/components/OnlineOpenFreeMap.tsx'), 'utf8');
assert.match(mapSource, /kind: 'stop-candidate'/);
assert.match(mapSource, /candidateId: stopCandidate\.id/);
assert.match(mapSource, /index: `\$\{stopCandidate\.displayNumber\}`/);
assert.match(mapSource, /'stop-candidate'\]\]/, 'existing map number layer includes Add Stops candidates');
assert.match(mapSource, /queryRenderedFeatures[\s\S]*onToggleRouteStopCandidateRef\.current\(stopCandidateId\)/);
const appSource = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
assert.match(appSource, /routePathStopCandidateGroups\(draft\)\.map/);
assert.match(appSource, /toggleRoutePathStopCandidate\(drawer\.selectedIds, candidateId\)/);

console.log('Add Stops From Path: all-Section candidates, shared toggles, map identity, cross-Section and repeated geometry-preserving segmentation passed.');
