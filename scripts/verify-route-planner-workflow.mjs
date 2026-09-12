import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'route-planner-workflow-'));
const entry = join(out, 'entry.ts');
const modulePath = (path) => join(root, path).replaceAll('\\', '/');
writeFileSync(
  entry,
  `export * from '${modulePath('src/core/routePlanner')}'; export * from '${modulePath('src/core/routes')}'; export * from '${modulePath('src/core/customRoutePath')}';`,
);
let route;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: { outDir: out, emptyOutDir: false, minify: false, lib: { entry, formats: ['es'], fileName: () => 'route.mjs' } },
  });
  route = await import(pathToFileURL(join(out, 'route.mjs')).href);
} finally {
  rmSync(out, { recursive: true, force: true });
}

const point = (id, longitude, latitude) => ({ id, name: id, longitude, latitude });
const ready = (section, geometry = [[0, 0], [1, 1]]) => ({
  ...section,
  status: 'ready',
  plans: [{
    id: `plan-${section.id}`,
    provider: 'test',
    providerVersion: '1',
    pathType: section.pathType,
    geometry,
    distanceMeters: 1,
    estimatedDurationSeconds: 0,
    routeSummary: 'test',
    legs: [],
    alternativeRank: 0,
  }],
  selectedPlanId: `plan-${section.id}`,
});

let draft = route.createRoutePlannerDraft();
draft = route.setRoutePlannerPoint(draft, 'source', point('a', 0, 0));
draft = route.setRoutePlannerPoint(draft, 'destination', point('b', 1, 1));
assert.equal(draft.sections[0].status, 'needs-calculation');
assert.equal(route.canUseRoutePlannerDraft(draft), false);
const retainedButInvalid = { ...draft, sections: [ready(draft.sections[0])] };
assert.equal(route.canUseRoutePlannerDraft(retainedButInvalid), true);
const invalidWithGeometry = {
  ...retainedButInvalid,
  sections: [{ ...retainedButInvalid.sections[0], status: 'needs-calculation' }],
};
assert.equal(route.canUseRoutePlannerDraft(invalidWithGeometry), false, 'geometry does not imply readiness');
for (const status of ['calculating', 'error', 'editing'])
  assert.equal(
    route.canUseRoutePlannerDraft({
      ...retainedButInvalid,
      sections: [{ ...retainedButInvalid.sections[0], status }],
    }),
    false,
    `${status} is never committable`,
  );
const cancelledCalculation = route.invalidateRoutePlans({
  ...retainedButInvalid,
  status: 'calculating',
  sections: [{ ...retainedButInvalid.sections[0], status: 'calculating' }],
});
assert.equal(cancelledCalculation.sections[0].status, 'needs-calculation');

const air = route.setRoutePlannerSectionPathType(draft, draft.sections[0].id, 'air');
assert.equal(air.sections[0].status, 'needs-calculation', 'Air requires explicit Calculate');
assert.ok(route.planLocalSection(air.source, air.destination, 'air').length, 'Air remains locally calculable');
const custom = route.setRoutePlannerSectionPathType(draft, draft.sections[0].id, 'custom');
assert.equal(custom.sections[0].status, 'editing');
assert.equal(route.routePlannerSectionsNeedingCalculation(custom).length, 0, 'Custom is excluded from Calculate All');
const customReady = route.setCustomRouteSection(custom, custom.sections[0].id, route.customRouteSettings());
assert.equal(customReady.sections[0].status, 'ready');

for (const pathType of ['road', 'maritime', 'air']) {
  const providerReady = {
    ...retainedButInvalid,
    sections: [{ ...retainedButInvalid.sections[0], pathType }],
  };
  const converted = route.convertCalculatedSectionToCustom(providerReady, providerReady.sections[0].id);
  assert.equal(converted.sections[0].pathType, 'custom');
  assert.equal(converted.sections[0].status, 'ready');
  assert.ok(converted.sections[0].customSettings.controlPoints.length < 100, 'conversion bounds editable controls');
  assert.deepEqual(converted.sections[0].plans[0].geometry[0], providerReady.sections[0].plans[0].geometry[0]);
  assert.deepEqual(converted.sections[0].plans[0].geometry.at(-1), providerReady.sections[0].plans[0].geometry.at(-1));
}

let chain = route.createRoutePlannerDraft();
chain = route.setRoutePlannerPoint(chain, 'source', point('source', 0, 0));
chain = route.addRoutePlannerStop(chain, point('stop-a', 1, 0));
chain = route.addRoutePlannerStop(chain, point('stop-b', 2, 0));
chain = route.setRoutePlannerPoint(chain, 'destination', point('destination', 3, 0));
chain = { ...chain, sections: chain.sections.map((section) => ready(section)) };
const unchangedThird = chain.sections[2];
const moved = route.setRoutePlannerPoint(chain, { id: 'stop-a', kind: 'stop' }, point('replacement', 1, 0.5));
assert.equal(moved.sections[0].status, 'needs-calculation');
assert.equal(moved.sections[1].status, 'needs-calculation');
assert.deepEqual(moved.sections[2], unchangedThird, 'non-adjacent Section remains authoritative');

const preferenceChanged = route.setRoutePlannerPreference(chain, 'shortest');
assert.ok(preferenceChanged.sections.every((section) => section.status === 'needs-calculation'));
assert.ok(preferenceChanged.sections.every((section) => section.plans.length), 'invalidation may retain geometry');

const signature = route.routePlannerSectionInputSignature(retainedButInvalid, retainedButInvalid.sections[0].id);
const changedEndpoint = route.setRoutePlannerPoint(retainedButInvalid, 'destination', point('new-b', 5, 5));
assert.equal(
  route.applyRouteSectionCalculationResult(changedEndpoint, retainedButInvalid.sections[0], signature),
  changedEndpoint,
  'stale async calculation result is ignored',
);

const mixed = {
  ...chain,
  sections: [
    chain.sections[0],
    { ...chain.sections[1], pathType: 'maritime', status: 'needs-calculation' },
    { ...chain.sections[2], pathType: 'air', status: 'error' },
  ],
};
assert.deepEqual(route.routePlannerSectionsNeedingCalculation(mixed).map((section) => section.id), [
  mixed.sections[1].id,
  mixed.sections[2].id,
]);
const partialFailure = {
  ...mixed,
  sections: [
    mixed.sections[0],
    { ...mixed.sections[1], status: 'error', error: 'test failure' },
    ready(mixed.sections[2]),
  ],
};
assert.equal(partialFailure.sections[0], mixed.sections[0], 'Calculate All leaves an existing Ready result untouched');
assert.equal(partialFailure.sections[1].status, 'error');
assert.equal(partialFailure.sections[2].status, 'ready', 'successful sibling result survives partial failure');
assert.equal(route.canUseRoutePlannerDraft(partialFailure), false);

const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
for (const text of ['Needs calculation', 'Calculating…', 'Calculation failed', 'Recalculate', 'Retry', 'Turn to Custom'])
  assert.ok(app.includes(text));
assert.match(app, /disabled=\{!canUseRoutePlannerDraft\(draft\)/);
assert.match(app, /routePlannerSectionsNeedingCalculation\(draft\)\.length > 0/);
console.log('Route Planner workflow: explicit readiness, invalidation, stale-result safety, Calculate All filtering, and commit gating passed.');
