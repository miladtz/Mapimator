import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'online-route-'));
const entry = join(out, 'entry.ts');
const modulePath = (path) => join(root, path).replaceAll('\\', '/');
writeFileSync(entry, `export * from '${modulePath('src/core/routes')}';\nexport * from '${modulePath('src/core/project')}';`);
let core;
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: out, emptyOutDir: false, minify: false, lib: { entry, formats: ['es'], fileName: () => 'module.mjs' } } });
  core = await import(pathToFileURL(join(out, 'module.mjs')).href);
} finally { rmSync(out, { recursive: true, force: true }); }

const a = core.createRoutePoint(51.389, 35.689, 'Tehran');
const b = core.createRoutePoint(56.267, 27.183, 'Bandar Abbas');
const c = core.createRoutePoint(55.271, 25.205, 'Dubai');
const route = core.createRouteLayer([a, b, c]);
assert.equal(route.routePoints.length, 3);
assert.equal(route.routeSegments.length, 2);
assert.deepEqual(route.routeSegments.map((segment) => [segment.startPointId, segment.endPointId]), [[a.id, b.id], [b.id, c.id]]);
const retained = route.routeSegments[1].id;
const x = core.createRoutePoint(53, 30, 'Stop X');
const inserted = core.createRouteLayer([a, x, b, c]);
inserted.routeSegments[2].id = retained;
assert.equal(inserted.routeSegments.length, 3);
const routed = { ...route, routeSegments: route.routeSegments.map((segment, index) => index ? segment : { ...segment, mode: 'car', geometrySource: 'provider', geometryMode: 'provider', routingStatus: 'routed', geometry: [[51,35],[52,34],[56,27]] }) };
const stale = core.setRouteSectionPathType(routed, routed.routeSegments[0].id, 'maritime');
assert.equal(stale.routeSegments[0].routingStatus, 'ready', 'maritime generates locally');
assert.deepEqual(stale.routeSegments[0].geometry, routed.routeSegments[0].geometry, 'physical geometry is retained, never replaced by a straight fallback');
const plane = core.setRouteSectionPathType(routed, routed.routeSegments[0].id, 'air');
assert.equal(plane.routeSegments[0].routingStatus, 'ready');
assert.ok(plane.routeSegments[0].geometry.length > 8);
assert.doesNotMatch(JSON.stringify(route), /vehicleType|vehicleEnabled|automaticMultimodal|providerLeg/);
console.log('Online Route: canonical adjacent-point sections, stable identity fields, stale physical geometry, and local Plane passed.');
