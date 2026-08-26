import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'mapmotion-map-mode-'));
const entry = join(out, 'entry.ts');
const source = (name) => join(root, 'src/core', name).replaceAll('\\', '/');
writeFileSync(
  entry,
  [
    `export * from '${source('project')}';`,
    `export * from '${source('editingScene')}';`,
    `export * from '${source('editorPreviewModes')}';`,
  ].join('\n'),
);
let m;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: out,
      emptyOutDir: false,
      minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'core.mjs' },
    },
  });
  m = await import(pathToFileURL(join(out, 'core.mjs')).href);
} finally {
  rmSync(out, { recursive: true, force: true });
}

const project = m.createProject('Map Mode');
const a = m.createLayer('pin');
const b = m.createLayer('text');
a.id = 'a';
b.id = 'b';
project.layers = [a, b];
const v1 = m.createView('V1', [a], { x: 12, y: 8, zoom: 2 }, project.layers);
const v2 = m.createView('V2', [b], { x: 30, y: 20, zoom: 3 }, project.layers);
v1.id = 'v1';
v2.id = 'v2';
const transition = m.createTransition('v1', 'v2', project.layers);
transition.id = 't1';
transition.layerConfigs.a.included = false;
transition.layerConfigs.b.included = true;
project.views = [v1, v2];
project.transitions = [transition];

const membershipsBefore = JSON.stringify({
  view: v1.layerConfigs,
  transition: transition.layerConfigs,
});
const projectScene = m.resolveEditingScene(project, null, { x: 90, y: 40, zoom: 1.5 });
const viewScene = m.resolveEditingScene(project, { kind: 'view', id: 'v1' });
const transitionScene = m.resolveEditingScene(project, { kind: 'transition', id: 't1' });
assert.deepEqual(projectScene.layers.map((layer) => layer.id), ['a', 'b']);
assert.deepEqual(viewScene.layers.map((layer) => layer.id), ['a', 'b']);
assert.deepEqual(transitionScene.layers.map((layer) => layer.id), ['a', 'b']);
assert.deepEqual(projectScene.camera, { x: 90, y: 40, zoom: 1.5 });
assert.equal(JSON.stringify({ view: v1.layerConfigs, transition: transition.layerConfigs }), membershipsBefore);

let state = {
  selectedTimelineEntity: { kind: 'transition', id: 't1' },
  previewTime: 1,
  playbackState: 'paused',
};
assert.equal(m.resolveEditorInteractionMode(state), 'preview');
state = m.stopPreviewMode(state);
assert.equal(m.resolveEditorInteractionMode(state), 'project');
assert.equal(state.selectedTimelineEntity, null);
state = m.leaveProjectMode(state, 'v1');
assert.deepEqual(state.selectedTimelineEntity, { kind: 'view', id: 'v1' });
assert.equal(m.resolveEditorInteractionMode(state), 'timeline');
state = m.enterProjectMode(state);
assert.equal(state.selectedTimelineEntity, null);
state = m.selectEditingEntity(state, { kind: 'transition', id: 't1' });
assert.deepEqual(state.selectedTimelineEntity, { kind: 'transition', id: 't1' });

assert.deepEqual(m.membershipCheckboxPresentation(true, false, false), {
  checked: true,
  disabled: true,
});
assert.deepEqual(m.membershipCheckboxPresentation(false, false, true), {
  checked: false,
  disabled: false,
});
assert.equal(m.allocationCheckboxDisabled('stopped', { kind: 'view', id: 'v1' }), false);
assert.equal(m.allocationCheckboxDisabled('stopped', null), true);
assert.equal(m.allocationCheckboxDisabled('paused', { kind: 'view', id: 'v1' }), true);
assert.equal(JSON.stringify({ view: v1.layerConfigs, transition: transition.layerConfigs }), membershipsBefore);

console.log('Map Mode: mode transitions, presentation-only membership, and edit-canvas independence passed.');
