import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
const root=fileURLToPath(new URL('..',import.meta.url));
const out=mkdtempSync(join(tmpdir(),'region-parity-')); const entry=join(out,'entry.ts');
writeFileSync(entry,[
  `export * from '${join(root,'src/core/project').replaceAll('\\','/')}';`,
  `export * from '${join(root,'src/core/regions').replaceAll('\\','/')}';`,
  `export * from '${join(root,'src/core/viewCompiler').replaceAll('\\','/')}';`,
].join('\n'));
let m;
try { await build({configFile:false,logLevel:'silent',build:{outDir:out,emptyOutDir:false,minify:false,lib:{entry,formats:['es'],fileName:()=> 'm.mjs'}}}); m=await import(pathToFileURL(join(out,'m.mjs')).href); }
finally { rmSync(out,{recursive:true,force:true}); }
const geometry=m.customRegionGeometry([[50,30],[55,30],[52,35]]);
const region=m.createRegionLayer('Region A',geometry,{regionAnimationEnabled:true,regionEffect:'draw-border'});
const pin=m.createLayer('pin'); let p=m.createProject('Parity'); p=m.addProjectLayer(p,region); p=m.addProjectLayer(p,pin);
const v1=m.createView('View 1',[],{x:0,y:0,zoom:1},p.layers); const v2=m.createView('View 2',[],{x:0,y:0,zoom:1},p.layers);
p={...p,views:[v1,v2],transitions:[m.createTransition(v1.id,v2.id,p.layers,v1)]}; const tr=p.transitions[0];
p=m.setViewLayerIncluded(p,v1.id,region.id,true); p=m.setTransitionLayerIncluded(p,tr.id,region.id,true);
p=m.setTransitionLayerIncluded(p,tr.id,pin.id,true); p=m.setViewLayerIncluded(p,v2.id,pin.id,true);
assert.deepEqual(m.viewLayersOf(p,p.views[0]).map(x=>x.id),[region.id]);
assert.deepEqual(m.transitionLayersOf(p,p.transitions[0]).map(x=>x.id),[region.id,pin.id]);
assert.deepEqual(m.viewLayersOf(p,p.views[1]).map(x=>x.id),[pin.id]);
const globalBefore=structuredClone(p.layers); p=m.setViewLayerIncluded(p,v2.id,region.id,false);
assert.deepEqual(p.layers,globalBefore,'timeline membership never mutates global layers');
p.transitions[0].layerConfigs[region.id].animation={appearEnabled:true,appearType:'fade',appearDelay:0,appearDuration:p.transitions[0].duration};
const seq=m.compileTimeline(p); const segment=seq.segments.find(s=>s.kind==='transition');
const at=t=>m.evaluateProjectAtTime(p,t).layers.find(x=>x.id===region.id);
const start=at(segment.start+1e-6), mid=at(segment.start+segment.duration/2), end=at(segment.end-1e-6);
assert.ok(start.regionEffectProgress < mid.regionEffectProgress && mid.regionEffectProgress < end.regionEffectProgress);
assert.deepEqual(m.evaluateProjectAtTime(p,segment.start+1),m.evaluateProjectAtTime(p,segment.start+1));
assert.ok(m.revealRegionGeometry(region.regionGeometry,.5).coordinates[0].length>=2);
let allOff=m.setTransitionLayerIncluded(p,tr.id,region.id,false); allOff=m.setTransitionLayerIncluded(allOff,tr.id,pin.id,false);
assert.equal(m.transitionLayersOf(allOff,allOff.transitions[0]).length,0);
console.log('Pin/Region parity: membership isolation, all-off validity, deterministic evaluation, and progressive border passed.');
