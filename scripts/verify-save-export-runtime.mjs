import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-save-export-runtime-'));
const entryFile = join(outDir, 'entry.ts');
writeFileSync(
  entryFile,
  [
    "export * from '" + join(root, 'src/core/project').replaceAll('\\', '/') + "';",
    "export * from '" + join(root, 'src/core/projectFile').replaceAll('\\', '/') + "';",
    "export * from '" + join(root, 'src/core/exportRuntime').replaceAll('\\', '/') + "';",
    "export * from '" + join(root, 'src/core/exportProgress').replaceAll('\\', '/') + "';",
    "export * from '" + join(root, 'src/core/viewCompiler').replaceAll('\\', '/') + "';",
    "export * from '" + join(root, 'src/core/transitionTiming').replaceAll('\\', '/') + "';",
  ].join('\n'),
  'utf8',
);

let mod;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      lib: { entry: entryFile, formats: ['es'], fileName: () => 'core.mjs' },
    },
  });
  mod = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const {
  createProject,
  createView,
  createTransition,
  serializeCanonicalProject,
  parseProjectFile,
  normalizeDialogPath,
  createProjectExportPlan,
  encoderFallbackOrder,
  verifyNativeExportResult,
  ExportProgressEstimator,
  exportPercentage,
  evaluateProjectAtTime,
  setTransitionDuration,
} = mod;

// Canonical Save round-trip preserves zero-Hold Views and standalone Transitions.
const project = createProject('Runtime acceptance');
const first = createView('First', [], { x: 0, y: 0, zoom: 1 }, []);
const zeroHold = createView('Zero Hold', [], { x: -180.25, y: -90.5, zoom: 2.25 }, []);
const last = createView('Last', [], { x: -400.5, y: -180.75, zoom: 4 }, []);
first.holdDuration = 1;
zeroHold.holdDuration = 0;
last.holdDuration = 2;
const firstTransition = setTransitionDuration(createTransition(first.id, zeroHold.id, [], first), 2);
const secondTransition = setTransitionDuration(createTransition(zeroHold.id, last.id, [], zeroHold), 3);
project.views = [first, zeroHold, last];
project.transitions = [firstTransition, secondTransition];
const saved = serializeCanonicalProject(project);
const reopened = parseProjectFile(saved.json);
assert.deepEqual(reopened, saved.project, 'normal Project Save must round-trip canonical content');
assert.equal(reopened.views[1].holdDuration, 0, 'zero Hold must persist exactly');
assert.deepEqual(reopened.transitions, project.transitions, 'standalone Transitions must persist exactly');
assert.equal(normalizeDialogPath(null), null, 'dialog cancellation is not a failure');
assert.equal(normalizeDialogPath(['bad']), null, 'non-string dialog results must not reach native writes');
assert.throws(
  () => serializeCanonicalProject({ ...project, views: [{ ...first, holdDuration: Infinity }] }),
  /invalid timing/,
  'non-finite persisted timing must be rejected',
);

// Canonical timeline owns duration, frame count, and raw byte contract.
const settings = { width: 1920, height: 1080, fps: 30, layoutId: 'landscape' };
const plan = createProjectExportPlan(project, settings);
assert.equal(plan.duration, 8);
assert.equal(plan.totalFrames, 240);
assert.equal(plan.bytesPerFrame, 1920 * 1080 * 4);
const transitionOnly = createProject('Standalone transition duration');
const transitionStart = createView('Start', [], { x: 0, y: 0, zoom: 1 }, []);
const transitionEnd = createView('End', [], { x: -100, y: -50, zoom: 2 }, []);
const standalone = createTransition(transitionStart.id, transitionEnd.id, [], transitionStart);
standalone.duration = 4;
transitionOnly.views = [transitionStart, transitionEnd];
transitionOnly.transitions = [standalone];
assert.equal(createProjectExportPlan(transitionOnly, settings).totalFrames, 120);
const empty = createProject('Zero duration');
assert.throws(() => createProjectExportPlan(empty, settings), /duration is 0 seconds/);
assert.deepEqual(encoderFallbackOrder('h264_nvenc'), ['h264_nvenc', 'libx264']);
assert.deepEqual(encoderFallbackOrder('libx264'), ['libx264']);
assert.doesNotThrow(() => verifyNativeExportResult({ framesWritten: 240, outputBytes: 1024, exitCode: 0 }));
assert.throws(() => verifyNativeExportResult({ framesWritten: 0, outputBytes: 0, exitCode: 1 }), /code 1/);

// ETA is hidden during startup, frame-derived afterwards, and resettable.
const estimator = new ExportProgressEstimator();
estimator.start(1000);
assert.deepEqual(estimator.measure('rendering', 4, 100, 1800), { elapsedMs: 800 });
assert.deepEqual(estimator.measure('rendering', 20, 100, 3000), { elapsedMs: 2000, etaSeconds: 8 });
assert.deepEqual(estimator.measure('finalizing', 100, 100, 3500), { elapsedMs: 2500 });
estimator.reset();
assert.deepEqual(estimator.measure('rendering', 0, 100, 5000), { elapsedMs: 0 });
assert.equal(exportPercentage('rendering', 75, 100), 75);
assert.equal(exportPercentage('finalizing', 100, 100), 99);
assert.equal(exportPercentage('completed', 100, 100), 100);

// Zero-Hold camera is an endpoint anchor, never a hold frame.
assert.deepEqual(evaluateProjectAtTime(project, 3).camera, zeroHold.camera);
assert.deepEqual(evaluateProjectAtTime(project, 3 + 1 / 30).camera.x < zeroHold.camera.x, true);

const exporterSource = readFileSync(join(root, 'src/core/videoExporter.ts'), 'utf8');
const nativeSource = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8');
const layoutSource = readFileSync(join(root, 'src/styles/global.css'), 'utf8');
assert.ok(!exporterSource.includes('compileViews('), 'runtime export must not use the deprecated View-only compiler');
assert.ok(exporterSource.includes('Frame ${index} at ${time.toFixed(6)}s failed'));
assert.ok(nativeSource.includes('Invalid RGBA frame size'));
assert.ok(nativeSource.includes('output_bytes == 0'));
assert.ok(nativeSource.includes('write_project_file'));
assert.ok(layoutSource.includes('grid-template-rows: 43px minmax(0, 1fr) auto'));

console.log('Save/export runtime verification passed');
