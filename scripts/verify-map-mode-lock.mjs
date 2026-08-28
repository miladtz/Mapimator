import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-mode-lock-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(entry, [`export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`, `export * from '${join(root, 'src/core/projectPersistence').replaceAll('\\', '/')}';`, `export * from '${join(root, 'src/core/viewCompiler').replaceAll('\\', '/')}';`].join('\n'));
let m;
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir, emptyOutDir: false, minify: false, lib: { entry, formats: ['es'], fileName: () => 'core.mjs' } } });
  m = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally { rmSync(outDir, { recursive: true, force: true }); }

const project = m.createProject('Mode lock');
assert.equal(m.sequenceMapMode(project), undefined, 'zero Views is unlocked');
const flat = m.createView('Flat', [], { x: 0, y: 0, zoom: 1 }, [], 'flat');
project.views = [flat];
assert.equal(m.sequenceMapMode(project), 'flat');
assert.ok(m.hasConsistentViewMapMode(project.views));
const duplicate = structuredClone(flat); duplicate.id = 'duplicate'; project.views.push(duplicate);
assert.equal(m.sequenceMapMode(project), 'flat', 'duplicate preserves lock');
project.views.shift(); assert.equal(m.sequenceMapMode(project), 'flat', 'deleting some Views preserves lock');
project.views = []; assert.equal(m.sequenceMapMode(project), undefined, 'deleting all Views unlocks');
const globe = m.createView('Globe', [], { x: 0, y: 0, zoom: 1 }, [], 'globe');
project.views = [globe]; assert.equal(m.sequenceMapMode(project), 'globe');
const restored = m.validateAndMigrateProject(JSON.parse(m.canonicalProjectJson(project)));
assert.equal(m.sequenceMapMode(restored), 'globe', 'Save/Open preserves lock');
project.views.push(flat);
assert.ok(!m.hasConsistentViewMapMode(project.views));
assert.throws(() => m.compileTimeline(project), /same map mode/);
assert.throws(() => m.validateAndMigrateProject(project), /same map mode/);
const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
assert.match(app, /const lockedMapMode = sequenceMapMode\(project\)/);
assert.match(app, /disabled=\{lockedMapMode === 'globe'\}/);
assert.match(app, /disabled=\{lockedMapMode === 'flat'\}/);
assert.match(app, /Delete all Views to choose another map mode/);
console.log('Map-mode lock verification passed.');
