import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const [services, maritime, worker, app, native, project, exporter] = await Promise.all([
  readFile(new URL('../src/core/routingServices.ts', import.meta.url), 'utf8'), readFile(new URL('../src/core/maritimeRouting.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/workers/maritimeRouting.worker.ts', import.meta.url), 'utf8'), readFile(new URL('../src/app/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8'), readFile(new URL('../src/core/project.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/core/export.ts', import.meta.url), 'utf8'),
]);
for (const token of ['OpenRouteServicePlanner', 'BuiltInMaritimePlanner', 'plannerForPathType', 'loadRoutingServiceSettings']) assert.match(services, new RegExp(token));
assert.match(services, /plan_open_route_service_route/);
assert.match(native, /api\.heigit\.org/); assert.match(native, /Authorization/);
assert.match(native, /Some\(2004\)/); assert.match(worker, /findOceanPath/); assert.match(worker, /ocean-grid/);
assert.match(maritime, /100_000/); assert.match(maritime, /too far from navigable water/); assert.match(maritime, /Worker/);
for (const source of [services, app, native, project]) assert.doesNotMatch(source, /SeaRoutes|seaRoutes|SEAROUTES/);
assert.match(app, /No API key/); assert.match(app, /Built-in Maritime Engine/);
assert.doesNotMatch(project, /openRouteServiceApiKey/);
console.log('Online Routing Services: native ORS and cached worker-based built-in maritime routing without SeaRoutes credentials passed.');
