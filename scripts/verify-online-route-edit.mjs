import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'route-edit-'));
const entry = join(out, 'entry.ts');
const source = (value) => join(root, value).replaceAll('\\', '/');
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
const a = point('a', 0, 0);
const b = point('b', 10, 5);
const c = point('c', 20, 10);
let draft = route.createRoutePlannerDraft();
draft = route.setRoutePlannerPoint(draft, 'source', a);
draft = route.setRoutePlannerPoint(draft, 'destination', c);
draft = route.addRoutePlannerStop(draft, b);
draft = {
  ...draft,
  sections: draft.sections.map((section, index) => ({
    ...section,
    pathType: index ? 'air' : 'custom',
    airModel: index ? 'direct' : 'great-circle',
    customSettings: index
      ? undefined
      : route.customRouteSettings('smooth', [route.createCustomRouteControlPoint(5, 4, 'control-1')]),
    status: 'ready',
    plans: [
      {
        id: `plan-${index}`,
        provider: 'test',
        providerVersion: '1',
        pathType: index ? 'air' : 'custom',
        geometry: index
          ? [
              [10, 5],
              [15, 9],
              [20, 10],
            ]
          : [
              [0, 0],
              [5, 4],
              [10, 5],
            ],
        distanceMeters: 100,
        estimatedDurationSeconds: 0,
        routeSummary: index ? 'Built-in Direct' : 'Custom Smooth',
        legs: [],
        alternativeRank: 0,
      },
    ],
    selectedPlanId: `plan-${index}`,
  })),
  status: 'ready',
};
const accepted = route.routeLayerFromSections(draft);
accepted.id = 'route-layer-stable';
accepted.opacity = 0.72;
accepted.routeSegments[0].appearance = { lineColor: '#123456', lineWidth: 9 };
const canonicalBefore = JSON.stringify(accepted);

let edit = route.routePlannerDraftFromLayer(accepted);
assert.equal(JSON.stringify(accepted), canonicalBefore, 'opening Edit Route must not mutate canonical JSON');
assert.notEqual(edit.source, accepted.routeDefinition.source, 'RoutePoints must be draft copies');
assert.equal(edit.sections[0].customSettings.pathShape, 'smooth');
assert.equal(edit.sections[1].airModel, 'direct');
edit = route.setRoutePlannerPoint(edit, { kind: 'stop', id: 'b' }, point('replacement', 11, 6));
assert.equal(JSON.stringify(accepted), canonicalBefore, 'draft edits must remain isolated');
assert.deepEqual(
  edit.sections.map((section) => section.id),
  accepted.routeSegments.map((segment) => segment.id),
);

edit = {
  ...edit,
  sections: edit.sections.map((section) =>
    section.plans.length
      ? section
      : {
          ...section,
          status: 'ready',
          plans: [{ ...draft.sections[0].plans[0], id: `updated-${section.id}` }],
          selectedPlanId: `updated-${section.id}`,
        },
  ),
};
const updated = route.routeLayerFromSections(edit, accepted);
assert.equal(updated.id, accepted.id);
assert.equal(updated.opacity, accepted.opacity);
assert.deepEqual(updated.routeSegments[0].appearance, accepted.routeSegments[0].appearance);
assert.equal(updated.routeSegments[1].id, accepted.routeSegments[1].id);
assert.equal(updated.routeDefinition.sectionDefinitions[1].generatorSettings.airModel, 'direct');
const sibling = { ...accepted, id: 'unrelated-route' };
const replaced = route.replaceAcceptedRouteLayer([sibling, accepted], accepted.id, updated);
assert.deepEqual(
  replaced.map((layer) => layer.id),
  ['unrelated-route', accepted.id],
);
assert.equal(replaced.filter((layer) => layer.id === accepted.id).length, 1);
assert.equal(replaced[0], sibling, 'unrelated layer identity and ordering must be preserved');
const invalid = { ...edit, sections: edit.sections.map((section) => ({ ...section, plans: [] })) };
assert.throws(() => route.routeLayerFromSections(invalid, accepted), /Calculate every Route Section/);
assert.equal(
  JSON.stringify(accepted),
  canonicalBefore,
  'failed acceptance must leave canonical JSON unchanged',
);

const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
for (const token of [
  'Edit Route',
  'routePlannerDraftFromLayer',
  'editingRouteLayerId',
  'accepted Route unchanged',
  'replaceAcceptedRouteLayer(current.layers, accepted.id, layer)',
])
  assert.ok(app.includes(token), `missing Edit Route lifecycle token: ${token}`);

console.log(
  'Online Edit Route: isolated reopen, stable Layer/Section identity, metadata preservation, Cancel wording, and same-layer atomic replacement passed.',
);
