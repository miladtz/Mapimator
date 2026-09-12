import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-view-reorder-'));
const source = (path) => join(root, path).replaceAll('\\', '/');
writeFileSync(
  join(outDir, 'entry.ts'),
  `export * from '${source('src/core/project')}'; export * from '${source('src/core/viewReorder')}'; export * from '${source('src/core/viewCompiler')}'; export * from '${source('src/core/projectFile')}';`,
);
let core;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      lib: { entry: join(outDir, 'entry.ts'), formats: ['es'], fileName: () => 'core.mjs' },
    },
  });
  core = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
const fixture = (withDormant = true) => {
  const project = core.createProject('Reorder');
  project.views = [1, 2, 5, 4].map((hold, index) => {
    const view = core.createView(`V${index + 1}`, [], { x: index * 10, y: index, zoom: 1 }, []);
    view.id = `V${index + 1}`;
    view.holdDuration = hold;
    return view;
  });
  project.transitions = project.views.slice(0, -1).map((view, index) => {
    const transition = core.createTransition(view.id, project.views[index + 1].id, [], view);
    transition.id = `T${index + 1}`;
    transition.duration = index + 2;
    transition.preset = index === 2 ? 'ease-in-out' : 'smooth';
    transition.layerConfigs = { distinctive: { included: index === 2 } };
    return transition;
  });
  if (withDormant) {
    const transition = core.createTransition('V4', 'V1', [], project.views[3]);
    transition.id = 'T4';
    transition.duration = 9;
    project.transitions.push(transition);
  }
  return project;
};
const order = (p) => p.views.map((view) => view.id);
const outgoing = (p, id) => p.transitions.find((transition) => transition.fromViewId === id);
let p = core.reorderProjectView(fixture(), 'V3', 0);
assert.deepEqual(order(p), ['V3', 'V1', 'V2', 'V4']);
assert.deepEqual([outgoing(p, 'V3').id, outgoing(p, 'V3').toViewId], ['T3', 'V1']);
assert.equal(outgoing(p, 'V3').duration, 4);
assert.equal(outgoing(p, 'V3').preset, 'ease-in-out');
assert.equal(p.views[0].holdDuration, 5);
p = core.reorderProjectView(fixture(), 'V1', 2);
assert.deepEqual(order(p), ['V2', 'V3', 'V1', 'V4']);
assert.deepEqual(
  ['V2', 'V3', 'V1'].map((id) => outgoing(p, id).id),
  ['T2', 'T3', 'T1'],
);
p = core.reorderProjectView(fixture(), 'V2', 3);
assert.deepEqual(order(p), ['V1', 'V3', 'V4', 'V2']);
assert.equal(outgoing(p, 'V2').id, 'T2');
assert.deepEqual(core.resolveSelectionAfterViewReorder(p, { kind: 'transition', id: 'T2' }), {
  kind: 'view',
  id: 'V2',
});
p = core.reorderProjectView(fixture(), 'V4', 0);
assert.deepEqual(order(p), ['V4', 'V1', 'V2', 'V3']);
assert.equal(outgoing(p, 'V4').id, 'T4');
p = core.reorderProjectView(fixture(false), 'V4', 0);
assert.equal(outgoing(p, 'V4').toViewId, 'V1');
assert.ok(outgoing(p, 'V4').id.startsWith('transition-'));
const unchanged = fixture();
assert.equal(core.reorderProjectView(unchanged, 'V2', 1), unchanged);
p = core.reorderProjectView(fixture(), 'V3', 0);
const compiled = core.compileTimeline(p);
assert.deepEqual(
  compiled.segments.map((segment) => `${segment.kind}:${segment.id}`),
  ['view:V3', 'transition:T3', 'view:V1', 'transition:T1', 'view:V2', 'transition:T2', 'view:V4'],
);
assert.equal(compiled.duration, 21);
const reopened = core.parseProjectFile(core.serializeCanonicalProject(p).json);
assert.deepEqual(order(reopened), order(p));
assert.equal(outgoing(reopened, 'V3').id, 'T3');
assert.equal(outgoing(reopened, 'V2').id, 'T2');
console.log('View reorder model, timeline, selection, and persistence regression passed.');
