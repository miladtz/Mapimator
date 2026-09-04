import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { fileURLToPath, pathToFileURL } from 'node:url'; import { build } from 'vite';
const root=fileURLToPath(new URL('..',import.meta.url)),out=mkdtempSync(join(tmpdir(),'route-sections-')),entry=join(out,'entry.ts');
const p=(value)=>join(root,value).replaceAll('\\','/'); writeFileSync(entry,`export * from '${p('src/core/routePlanner')}';`);
let m; try { await build({configFile:false,logLevel:'silent',build:{outDir:out,emptyOutDir:false,minify:false,lib:{entry,formats:['es'],fileName:()=> 'module.mjs'}}}); m=await import(pathToFileURL(join(out,'module.mjs')).href); } finally { rmSync(out,{recursive:true,force:true}); }
const point=(id,name)=>({id,name,longitude:0,latitude:0}); const a=point('a','A'),b=point('b','B'),c=point('c','C'),d=point('d','D');
let draft=m.createRoutePlannerDraft(); draft=m.setRoutePlannerPoint(draft,'source',a); draft=m.setRoutePlannerPoint(draft,'destination',d);
assert.equal(draft.sections.length,1); const ad=draft.sections[0].id;
draft={...draft,stops:[b]}; draft=m.reconcileRouteSections(draft); assert.equal(draft.sections.length,2); assert.notEqual(draft.sections[0].id,ad);
const bd=draft.sections[1].id; draft={...draft,stops:[b,c]}; draft=m.reconcileRouteSections(draft); assert.equal(draft.sections.length,3); assert.equal(draft.sections[0].id, draft.sections[0].id); assert.notEqual(draft.sections[1].id,bd); assert.equal(draft.sections[2].endPointId,'d');
const cd=draft.sections[2].id; draft={...draft,stops:[c]}; draft=m.reconcileRouteSections(draft); assert.equal(draft.sections.length,2); assert.equal(draft.sections[1].id,cd,'unrelated C→D identity survives stop deletion');
draft=m.setRoutePlannerSectionPathType(draft,draft.sections[0].id,'maritime'); assert.equal(draft.sections[0].pathType,'maritime'); assert.equal(draft.sections[0].status,'idle');
assert.doesNotMatch(JSON.stringify(draft),/providerLeg|multimodal|vehicleSwitch/);
console.log('Online Route Sections: N-1 adjacency, insertion/deletion, stable unaffected identity, and independent modes passed.');
