import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-timeline-geometry-'));
writeFileSync(
  join(outDir, 'entry.ts'),
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/timelineGeometry').replaceAll('\\', '/')}';`,
  ].join('\n'),
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

const makeProject = (holds, durations) => {
  const project = core.createProject('Timeline geometry');
  project.views = holds.map((hold, index) => {
    const view = core.createView(`View ${index + 1}`, [], { x: index * 10, y: 0, zoom: 1 }, []);
    view.id = `view-${index + 1}`;
    view.holdDuration = hold;
    return view;
  });
  project.transitions = durations.map((duration, index) => {
    const transition = core.createTransition(project.views[index].id, project.views[index + 1].id, []);
    transition.id = `transition-${index + 1}`;
    transition.duration = duration;
    return transition;
  });
  return project;
};

for (const viewCount of [2, 5, 6, 12]) {
  const layout = core.buildTimelineLayout(
    makeProject(Array(viewCount).fill(1), Array(viewCount - 1).fill(2.5)),
  );
  assert.ok(layout.items.filter((item) => item.kind === 'view').every((item) => item.width === 160));
  assert.ok(layout.items.filter((item) => item.kind === 'transition').every((item) => item.width === 90));
  if (viewCount >= 6) assert.ok(layout.width > 960, 'long timeline grows beyond the viewport');
}
assert.equal(core.buildTimelineLayout(makeProject([0, 0], [5])).items[1].width, 90);
const zoomedLayout = core.buildTimelineLayout(makeProject([0, 0], [2.5]), 0.5);
assert.deepEqual(
  zoomedLayout.items.map((item) => item.width),
  [80, 45, 80],
  'timeline zoom scales stable card tokens without duration-based sizing',
);

const zeroHolds = makeProject([0, 0, 0], [2.5, 2.5]);
const zeroLayout = core.buildTimelineLayout(zeroHolds);
assert.equal(zeroLayout.duration, 5);
assert.equal(core.resolveTimelineAtTime(zeroLayout, 2.499999).item.id, 'transition-1');
const exactBoundary = core.resolveTimelineAtTime(zeroLayout, 2.5);
assert.equal(exactBoundary.item.id, 'transition-2');
assert.equal(exactBoundary.localProgress, 0);
assert.equal(core.resolveTimelineAtTime(zeroLayout, 2.500001).item.id, 'transition-2');
assert.equal(core.timelinePosition(zeroHolds, 2.5), exactBoundary.item.x);

const positiveHold = makeProject([0, 5, 0], [2.5, 2.5]);
const positiveLayout = core.buildTimelineLayout(positiveHold);
assert.equal(positiveLayout.duration, 10);
assert.equal(core.resolveTimelineAtTime(positiveLayout, 1.25).localProgress, 0.5);
assert.equal(core.resolveTimelineAtTime(positiveLayout, 2.5).item.id, 'view-2');
assert.equal(core.resolveTimelineAtTime(positiveLayout, 5).localProgress, 0.5);
assert.equal(core.resolveTimelineAtTime(positiveLayout, 7.5).item.id, 'transition-2');
assert.equal(core.resolveTimelineAtTime(positiveLayout, 8.75).localProgress, 0.5);

const mixed = makeProject([0, 1, 0, 2, 3, 0, 1], [2.5, 5, 2.5, 5, 2.5, 5]);
const mixedLayout = core.buildTimelineLayout(mixed);
for (const boundary of [2.5, 3.5, 8.5, 11, 13, 18, 21, 23.5, 28.5]) {
  for (const offset of [-0.000001, 0, 0.000001]) {
    assert.ok(
      core.resolveTimelineAtTime(mixedLayout, Math.max(0, Math.min(mixedLayout.duration, boundary + offset))),
    );
  }
  if (boundary < 28.5)
    assert.notEqual(core.resolveTimelineAtTime(mixedLayout, boundary).item.id, mixed.views.at(-1).id);
}
assert.equal(core.resolveTimelineAtTime(mixedLayout, 28.5).item.id, 'view-7');

for (const item of positiveLayout.items) {
  assert.equal(
    core.timelineTimeAtPosition(positiveHold, item.x + item.width / 2),
    (item.projectStartTime + item.projectEndTime) / 2,
  );
}
const zeroView = zeroLayout.items.find((item) => item.id === 'view-2');
assert.equal(core.timelineTimeAtPosition(zeroHolds, zeroView.x + zeroView.width * 0.8), 2.5);
const transition = positiveLayout.items.find((item) => item.id === 'transition-2');
const fullX = transition.x + transition.width * 0.25;
const scrollLeft = 420;
assert.equal(
  core.timelineTimeAtPosition(positiveHold, fullX - scrollLeft + scrollLeft),
  transition.projectStartTime + 0.25 * (transition.projectEndTime - transition.projectStartTime),
);

const css = readFileSync(join(root, 'src/styles/views.css'), 'utf8');
const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
assert.match(css, /\.timeline-scroll[\s\S]*?overflow-x: auto/);
assert.match(css, /\.view-transition[\s\S]*?flex-shrink: 0/);
assert.match(css, /\.view-card[\s\S]*?flex-shrink: 0/);
assert.match(css, /\.scrub-playhead::after/);
assert.match(css, /cursor: ew-resize/);
assert.equal(
  (app.match(/className="timeline-duration-input"/g) ?? []).length,
  2,
  'View Hold and Transition duration use the same native number-input wheel path',
);
const durationWheelBypass = app.indexOf("event.target.closest('.timeline-duration-input')");
const timelineWheelPrevention = app.indexOf('event.preventDefault()', durationWheelBypass);
assert.ok(durationWheelBypass >= 0 && timelineWheelPrevention > durationWheelBypass);
assert.doesNotMatch(
  app,
  /className="timeline-duration-input"[\s\S]{0,240}onWheel=/,
  'duration inputs rely on the working native wheel behavior rather than a React approximation',
);
assert.match(
  app,
  /className="timeline-duration-input"[\s\S]{0,120}min="0"[\s\S]{0,120}max="60"[\s\S]{0,120}step="0\.5"/,
);
assert.match(
  app,
  /className="timeline-duration-input"[\s\S]{0,120}min="0"[\s\S]{0,120}max="30"[\s\S]{0,120}step="0\.5"/,
);

console.log(
  'Timeline geometry verification: fixed cards through 12 Views, horizontal growth, piecewise zero/positive-Hold timing, exact boundaries, scroll-safe inverse scrubbing, native duration-input wheel ownership, and visible playhead handle passed.',
);
