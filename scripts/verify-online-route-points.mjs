import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
const root=fileURLToPath(new URL('..',import.meta.url)),out=mkdtempSync(join(tmpdir(),'route-points-')),entry=join(out,'entry.ts');
const p=(v)=>join(root,v).replaceAll('\\','/'); writeFileSync(entry,`export * from '${p('src/core/routePlanner')}'; export * from '${p('src/core/customRoutePath')}';`);
let m; try { await build({configFile:false,logLevel:'silent',build:{outDir:out,emptyOutDir:false,minify:false,lib:{entry,formats:['es'],fileName:()=> 'module.mjs'}}}); m=await import(pathToFileURL(join(out,'module.mjs')).href); } finally { rmSync(out,{recursive:true,force:true}); }
const pt=(id,lng,lat)=>({id,name:id,longitude:lng,latitude:lat});
const a=pt('a',0,0),b=pt('b',10,5),c=pt('c',20,10),d=pt('d',30,15),e=pt('e',40,20);
let draft=m.createRoutePlannerDraft(); draft=m.setRoutePlannerPoint(draft,'source',a); draft=m.setRoutePlannerPoint(draft,'destination',e);
draft=m.addRoutePlannerStop(draft,b); draft=m.addRoutePlannerStop(draft,c); draft=m.addRoutePlannerStop(draft,d);
assert.equal(draft.sections.length,4); assert.deepEqual(draft.stops.map(x=>x.id),['b','c','d']);
const oldId=draft.stops[1].id; draft=m.moveStop(draft,'b','down'); assert.deepEqual(draft.stops.map(x=>x.id),['c','b','d']); assert.equal(draft.stops[0].id,oldId);
draft=m.setRoutePlannerPoint(draft,{id:'b',kind:'stop'},pt('replacement',11,6)); assert.equal(draft.stops.find(x=>x.id==='b').id,'b');
assert.ok(draft.sections.filter(s=>s.startPointId==='b'||s.endPointId==='b').every(s=>s.plans.length===0));

let custom=m.createRoutePlannerDraft(); custom=m.setRoutePlannerPoint(custom,'source',a); custom=m.setRoutePlannerPoint(custom,'destination',e);
const sid=custom.sections[0].id; custom=m.setRoutePlannerSectionPathType(custom,sid,'custom');
const controls=[b,c,d].map(x=>m.createCustomRouteControlPoint(x.longitude,x.latitude,`control-${x.id}`));
custom=m.setCustomRouteSection(custom,sid,m.customRouteSettings('exact',controls));
custom=m.promoteCustomControlsToStops(custom,sid,['control-b','control-d']);
assert.deepEqual(custom.stops.map(x=>x.sourceControlPointId),['control-b','control-d']); assert.equal(custom.sections.length,3);
assert.deepEqual(custom.sections.map(s=>s.customSettings.controlPoints.map(x=>x.id)),[[],['control-c'],[]]);
custom=m.removeStop(custom,custom.stops[0].id); assert.equal(custom.sections.length,2); assert.ok(custom.sections[0].customSettings.controlPoints.some(x=>x.id==='control-b'));

const maritimeGeometry=Array.from({length:501},(_,i)=>[i/10,Math.sin(i/30)*5]);
let maritime=m.createRoutePlannerDraft(); maritime=m.setRoutePlannerPoint(maritime,'source',a); maritime=m.setRoutePlannerPoint(maritime,'destination',e);
maritime={...maritime,sections:[{...maritime.sections[0],pathType:'maritime',status:'ready',plans:[{id:'sea',provider:'mapmotion-maritime',providerVersion:'1',pathType:'maritime',geometry:maritimeGeometry,distanceMeters:1,estimatedDurationSeconds:0,routeSummary:'Maritime — Approximate',legs:[],alternativeRank:0}],selectedPlanId:'sea'}]};
const converted=m.convertMaritimeSectionToCustom(maritime,maritime.sections[0].id); assert.equal(converted.sections[0].id,maritime.sections[0].id); assert.equal(converted.sections[0].pathType,'custom'); assert.ok(converted.sections[0].customSettings.controlPoints.length<=48);

const dubai=pt('dubai',55.27,25.2),la=pt('la',-118.24,34.05); const gc=m.planLocalSection(dubai,la,'air','great-circle')[0],direct=m.planLocalSection(dubai,la,'air','direct')[0];
assert.ok(gc.geometry.length>20); assert.ok(Math.max(...gc.geometry.map(x=>x[1]))>60); assert.notDeepEqual(gc.geometry,direct.geometry); assert.deepEqual(m.planLocalSection(dubai,la,'air','great-circle')[0].geometry,gc.geometry);
const anti=m.planLocalSection(pt('x',179,0),pt('y',-179,1),'air','direct')[0].geometry; assert.ok(Math.max(...anti.map(x=>x[0]))-Math.min(...anti.map(x=>x[0]))<3);
const app=readFileSync(join(root,'src/app/App.tsx'),'utf8'), maritimeSource=readFileSync(join(root,'src/core/maritimeRouting.ts'),'utf8');
for(const token of ['SOURCE','DESTINATION','Add Stops From Path','Convert to Custom Path','Move Stop','Pick on Map']) assert.ok(app.includes(token));
const normalBody=maritimeSource.slice(maritimeSource.indexOf('export const planMaritimeRoute')); assert.ok(!normalBody.includes('requestRefinement('));
console.log(`Online Route Points: stable endpoints/stops, reconciliation, path promotion, raw Maritime conversion, and Air passed; Dubai→LA ${gc.geometry.length} points, ${(gc.distanceMeters/1000).toFixed(0)} km, max latitude ${Math.max(...gc.geometry.map(x=>x[1])).toFixed(2)}°.`);
