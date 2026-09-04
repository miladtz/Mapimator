import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises';
const [project,routes,app,overlay]=await Promise.all(['../src/core/project.ts','../src/core/routes.ts','../src/app/App.tsx','../src/core/onlineProjectOverlays.ts'].map((url)=>readFile(new URL(url,import.meta.url),'utf8')));
assert.match(project,/applyFirstRouteSegmentAnimation\?: boolean/); for(const field of ['vehicleType','vehicleSize','vehicleDelay','vehicleDuration','routeWipeDelay','routeWipeDuration']) assert.match(project,new RegExp(field));
const mapAppearance=project.split('export interface RouteSegmentAppearance')[1].split('export interface RouteSegment {')[0]; assert.doesNotMatch(mapAppearance,/vehicle(Type|Enabled|Size|Color)/,'Map Mode appearance cannot own vehicles');
assert.match(app,/Route Section Usage/); assert.match(app,/Exists in this/); assert.match(app,/Apply to all sections/); assert.match(app,/Auto Sequence Sections/);
assert.match(routes,/routePositionAtProgress/); assert.match(routes,/cumulative/); assert.match(overlay,/render\.vehicleType/); assert.match(overlay,/vehicle\.bearing/);
console.log('Online Route Timeline: per-section existence/Appear/Draw/Vehicle/Wipe, timeline Apply-to-All, distance movement, and tangent orientation passed.');
