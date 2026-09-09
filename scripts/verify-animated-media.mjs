import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const project = readFileSync('src/core/project.ts', 'utf8');
const assets = readFileSync('src/core/projectAssets.ts', 'utf8');
const decoder = readFileSync('src/core/animatedMedia.ts', 'utf8');
const renderer = readFileSync('src/core/onlineAnimatedMediaLayer.ts', 'utf8');
const overlays = readFileSync('src/core/onlineProjectOverlays.ts', 'utf8');
const app = readFileSync('src/app/App.tsx', 'utf8');
const onlineMap = readFileSync('src/components/OnlineOpenFreeMap.tsx', 'utf8');
const persistence = readFileSync('src/core/projectPersistence.ts', 'utf8');
const compiler = readFileSync('src/core/viewCompiler.ts', 'utf8');
const media = await import('../src/core/animatedMedia.ts');

assert.match(project, /\| 'animated-media'/, 'Animated Media must be a first-class Layer type.');
assert.match(assets, /layer\.type === 'animated-media'/, 'Animated Media assets must remain project-owned.');
assert.match(decoder, /kind === 'ANIM' \|\| kind === 'ANMF'/, 'Static WebP must be rejected.');
assert.match(decoder, /localTimeMs.*% cycle/s, 'Loop selection must derive only from local media time.');
assert.match(decoder, /animatedMediaEffectiveDurationMs/, 'Timeline duration must use one canonical evaluator.');
assert.match(renderer, /completeFramesOnly: true/, 'Decoder must request fully composited frames.');
assert.match(renderer, /MAX_CPU_FRAMES = 4/, 'CPU frame cache must be bounded.');
assert.match(renderer, /texImage2D/, 'Retained renderer must upload decoded frames to its texture.');
assert.match(
  renderer,
  /entry\.uploadedFrame !== index/,
  'Texture uploads must occur only when frames change.',
);
assert.match(
  renderer,
  /gl\.drawArrays\(gl\.TRIANGLES,\s*0,\s*6\)/,
  'Renderer must draw a non-empty quad.',
);
assert.match(renderer, /new OnlineAnimatedMediaLayer\(layer\.id\)/, 'Each media layer needs its own z-orderable retained renderer.');
assert.match(renderer, /map\.moveLayer\(id, before\)/, 'Animated Media must follow canonical project ordering.');
assert.match(
  overlays,
  /ensureOnlineAnimatedMediaLayer/,
  'Animated renderer must participate in overlay lifecycle.',
);
assert.match(app, /\{ name: 'Animated WebP', extensions: \['webp'\] \}/, 'Picker must expose WebP only.');
assert.doesNotMatch(app, /const geoEffectCycle/, 'Legacy Geo Effect catalog must not remain active.');
assert.doesNotMatch(app, /animatedMediaPlayback \?\?/, 'Playback Loop/Once must not remain an active authoring model.');
assert.match(app, /function AnimatedMediaTimingControls/, 'View and Transition must share one timing control path.');
assert.match(app, /Count and Duration/, 'Linked timing mode must be available.');
assert.match(app, /animatedMediaRepeatCount: value \/ cycleSeconds/, 'Duration edits must update Count.');
assert.match(app, /animatedMediaDuration: parsed \* cycleSeconds/, 'Count edits must update Duration.');
assert.match(app, /timingAvailable=\{viewContext\.holdDuration > 0\}/, 'Zero-Hold Views must disable timing.');
assert.match(app, /resizeAnimatedMedia\(/, 'Inspector dimensions must use canonical aspect-aware resizing.');
assert.doesNotMatch(
  app.slice(app.indexOf('{isAnimatedMedia && ('), app.indexOf('{transitionContext &&')),
  />Color\s*</,
  'Animated Media project properties must not expose Color.',
);
assert.match(onlineMap, /layer\.type === 'image' \|\| layer\.type === 'animated-media'/, 'Map hit testing must include Animated Media.');
assert.doesNotMatch(onlineMap, /resizeAnimatedMediaFromScreenSession|resizeImageFromHandle/, 'Map interaction must not expose direct media resizing.');
assert.match(onlineMap, /rotateAnimatedMediaToward/, 'Animated Media must use the map rotation handle.');
assert.match(persistence, /animatedMediaRepeatCountEnabled/, 'Repeat mode must persist per segment.');
assert.match(persistence, /animatedMediaRepeatCount must be positive/, 'Fractional positive Count must be validated.');
assert.match(
  persistence,
  /layer\.type !== 'image' && layer\.type !== 'animated-media'/,
  'Canonical save/package validation must accept Animated Media asset references.',
);
assert.match(
  persistence,
  /value\.type !== 'animated-media' && !isString\(value\.color\)/,
  'Obsolete Animated Media color must not block save validation.',
);
assert.match(
  compiler,
  /animatedMediaActiveIntervals/,
  'Playback must resolve canonical project-time intervals.',
);
assert.match(decoder, /interval\.start <= previous\.end/, 'Touching windows must merge.');
assert.match(overlays, /ONLINE_PROJECT_IMAGE_SELECTION_LAYER_ID/, 'Editor must render explicit media bounds.');
assert.match(overlays, /animatedMediaScreenOffsets/, 'Selection handles must share billboard screen geometry.');

assert.equal(media.animatedMediaEffectiveDurationMs(undefined, 2000), Number.POSITIVE_INFINITY);
assert.equal(
  media.animatedMediaEffectiveDurationMs(
    { animatedMediaRepeatCountEnabled: true, animatedMediaRepeatCount: 2.5 },
    2000,
  ),
  5000,
  'Fractional Count must produce linked intrinsic-cycle duration.',
);
assert.deepEqual(
  media.mergeAnimatedMediaIntervals([
    { start: 0, end: 13 },
    { start: 5, end: 10 },
    { start: 10, end: 14 },
  ]),
  [{ start: 0, end: 14 }],
  'The human 13/5/4 example must union to one 14-second interval.',
);
assert.deepEqual(
  media.mergeAnimatedMediaIntervals([
    { start: 0, end: 5 },
    { start: 7, end: 10 },
  ]),
  [
    { start: 0, end: 5 },
    { start: 7, end: 10 },
  ],
  'A real gap must create a new playback run.',
);
assert.deepEqual(
  media.animatedMediaIntervalsForRun(
    [
      { start: 0, end: 5 },
      { start: 5, end: 10 },
      { start: 10, end: 15 },
    ],
    0,
    15,
    2000,
  ),
  [{ start: 0, end: 15 }],
  'Default mode must create one continuous Exists-run clock.',
);
const timed = (duration) => ({
  animatedMediaRepeatCountEnabled: true,
  animatedMediaRepeatCount: duration / 2,
});
assert.deepEqual(
  media.animatedMediaIntervalsForRun(
    [
      { start: 0, end: 5, animation: timed(13) },
      { start: 5, end: 10, animation: timed(5) },
      { start: 10, end: 15, animation: timed(4) },
    ],
    0,
    15,
    2000,
  ),
  [{ start: 0, end: 14 }],
  'Adjacent authored events must resolve as project-time interval union.',
);
const mediaLayer = {
  id: 'media', type: 'animated-media', name: 'Media', visible: true, locked: false,
  opacity: 1, color: '#fff', x: 100, y: 100, width: 160, height: 80,
  animatedMediaRotation: 30, animatedMediaAspectLocked: false,
};
const offsets = media.animatedMediaScreenOffsets(mediaLayer);
assert.ok(Math.abs(Math.hypot(offsets[1][0] - offsets[0][0], offsets[1][1] - offsets[0][1]) - 160) < 1e-9);
assert.ok(Math.abs(Math.hypot(offsets[2][0] - offsets[1][0], offsets[2][1] - offsets[1][1]) - 80) < 1e-9);
const radians = Math.PI / 6;
assert.equal(
  media.pointInAnimatedMediaScreenQuad(mediaLayer, { x: 500, y: 300 }, {
    x: 500 + 79 * Math.cos(radians), y: 300 + 79 * Math.sin(radians),
  }),
  true,
  'A point just inside the rotated quad must hit.',
);
assert.equal(
  media.pointInAnimatedMediaScreenQuad(mediaLayer, { x: 500, y: 300 }, {
    x: 500 + 81 * Math.cos(radians), y: 300 + 81 * Math.sin(radians),
  }),
  false,
  'A point immediately outside the rotated quad must pass through.',
);
assert.deepEqual(
  media.resizeAnimatedMedia({ ...mediaLayer, animatedMediaAspectLocked: true, animatedMediaAspectRatio: 800 / 450 }, 400, 1),
  { width: 400, height: 225, animatedMediaAspectRatio: 800 / 450 },
  'Boat source canvas ratio must produce 400×225.',
);
assert.deepEqual(
  media.resizeAnimatedMedia({ ...mediaLayer, animatedMediaAspectLocked: true, animatedMediaAspectRatio: 1 }, 300, 1),
  { width: 300, height: 300, animatedMediaAspectRatio: 1 },
  'Explosion source canvas must remain a stable 300×300 quad.',
);
const canvasHeader = (width, height) => {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
  for (const [value, offset] of [[width - 1, 24], [height - 1, 27]]) {
    bytes[offset] = value & 255;
    bytes[offset + 1] = (value >> 8) & 255;
    bytes[offset + 2] = (value >> 16) & 255;
  }
  return bytes;
};
assert.deepEqual(media.animatedWebPCanvasSize(canvasHeader(800, 450)), { width: 800, height: 450 });
assert.deepEqual(media.animatedWebPCanvasSize(canvasHeader(512, 512)), { width: 512, height: 512 });
assert.match(renderer, /new OffscreenCanvas\(asset\.info\.canvasWidth, asset\.info\.canvasHeight\)/, 'Every decoded frame must use the fixed source canvas.');
const info = {
  frameCount: 2,
  cycleDurationMs: 2000,
  repetitionCount: 0,
  frames: [
    { index: 0, startMs: 0, durationMs: 1000 },
    { index: 1, startMs: 1000, durationMs: 1000 },
  ],
};
assert.equal(media.animatedMediaFrameAtTime(info, 10_500, 'loop'), 0);
assert.equal(media.animatedMediaFrameAtTime(info, 5_500, 'loop'), 1);
assert.equal(media.animatedMediaFrameAtTime(info, 10_500, 'loop'), 0, 'Reverse/direct seek must be history-free.');

// Static Image remains on its protected, dedicated renderer path.
assert.match(overlays, /ensureOnlineImageLayer/, 'Static Image renderer must remain installed.');
assert.match(
  renderer,
  /layer\.type !== 'animated-media'/,
  'Animated renderer must not consume Image layers.',
);
const staticRenderer = readFileSync('src/core/onlineImageLayer.ts', 'utf8');
assert.match(staticRenderer, /layer\.type === 'image'/, 'Static Image drawable path must remain intact.');
assert.match(
  staticRenderer,
  /gl\.drawArrays\(gl\.TRIANGLES, 0, 6\)/,
  'Static Image must still draw its quad.',
);

console.log('Animated Media architecture, timing, cache, renderer, and static isolation checks passed.');
