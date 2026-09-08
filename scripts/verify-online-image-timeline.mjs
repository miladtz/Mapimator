import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (path) => readFileSync(join(root, path), 'utf8');
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-image-timeline-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectPersistence').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/imageLayers').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/onlineImageLayer').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/viewCompiler').replaceAll('\\', '/')}';`,
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
      lib: { entry, formats: ['es'], fileName: () => 'core.mjs' },
    },
  });
  core = await import(pathToFileURL(join(outDir, 'core.mjs')).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const camera = (zoom = 4) => ({ x: 0, y: 0, zoom, bearing: 35, pitch: 45 });
const image = {
  ...core.createLayer('image'),
  id: 'image-timeline-a',
  x: 300,
  y: 180,
  width: 240,
  height: 120,
  opacity: 0.8,
  imageRotation: 27,
  imageAspectLocked: true,
  imageAspectRatio: 2,
  imageFitMode: 'cover',
  assetId: `asset_${'a'.repeat(64)}`,
};

const projectFor = (animation, included = true, zoom = 4) => {
  const project = core.createProject('Image timeline');
  project.layers = [structuredClone(image)];
  project.assets = [
    {
      id: image.assetId,
      kind: 'image',
      filename: 'image.png',
      mediaType: 'image/png',
      sha256: 'a'.repeat(64),
      size: 100,
      width: 800,
      height: 400,
      packagePath: `assets/${'a'.repeat(64)}.png`,
    },
  ];
  const view = core.createView('View', included ? [image] : [], camera(zoom), [image]);
  view.holdDuration = 20;
  view.layerConfigs[image.id] = { included, animation };
  project.views = [view];
  project.transitions = [];
  return project;
};

assert.equal(
  core.evaluateProjectAtTime(projectFor({}, false), 1).layers.length,
  0,
  'Exists=false excludes Image',
);
const fade = projectFor({ appearEnabled: true, appearType: 'fade', appearDelay: 0, appearDuration: 4 });
for (const [time, progress] of [
  [0, 0],
  [1, 0.25],
  [2, 0.5],
  [4, 1],
]) {
  const rendered = core.evaluateProjectAtTime(fade, time).layers[0];
  if (progress === 0) assert.equal(rendered.visible, false);
  else assert.ok(Math.abs(rendered.opacity - image.opacity * progress) < 1e-9);
}

const pop = projectFor({ appearEnabled: true, appearType: 'pop', appearDuration: 4 });
const popLayer = core.evaluateProjectAtTime(pop, 2).layers[0];
assert.deepEqual(
  [popLayer.x, popLayer.y, popLayer.width, popLayer.height],
  [image.x, image.y, image.width, image.height],
);
const popped = core.evaluatedImageLayer(popLayer);
assert.ok(popped.width < image.width && popped.height < image.height);
assert.ok(Math.abs(popped.x + popped.width / 2 - (image.x + image.width / 2)) < 1e-9, 'Pop anchor is fixed');
assert.deepEqual(core.evaluatedImageLayer(core.evaluateProjectAtTime(pop, 4).layers[0]).width, image.width);

const drop = projectFor({ appearEnabled: true, appearType: 'drop', appearDuration: 4 });
const dropped = core.evaluateProjectAtTime(drop, 2).layers[0];
assert.deepEqual([dropped.x, dropped.y], [image.x, image.y], 'Drop never mutates authored placement');
assert.ok(dropped.imageDropOffsetY < 0);
assert.equal(core.evaluateProjectAtTime(drop, 4).layers[0].imageDropOffsetY, 0);

const wipe = projectFor({ wipeEnabled: true, wipeDelay: 1, wipeDuration: 4 });
assert.equal(core.evaluateProjectAtTime(wipe, 1).layers[0].imageWipeProgress, 1);
assert.equal(core.evaluateProjectAtTime(wipe, 3).layers[0].imageWipeProgress, 0.5);
assert.equal(core.evaluateProjectAtTime(wipe, 5).layers[0].visible, false);
assert.equal(
  core.imageRenderSurfaceState(core.evaluateProjectAtTime(wipe, 3).layers[0]).visibleWidth,
  image.width / 2,
);

const scaled = projectFor(
  { imageScaleWithMapZoom: true, imageReferenceZoom: 4, imageOrientation: 'face-camera' },
  true,
  9,
);
const scaledLayer = core.evaluateProjectAtTime(scaled, 1).layers[0];
assert.equal(scaledLayer.imageOrientation, 'face-camera');
assert.equal(scaledLayer.imageScaleWithMapZoom, true);
assert.equal(scaledLayer.imageRenderScale, 1.5);
assert.equal(core.imageMapZoomScale({ imageScaleWithMapZoom: true, imageReferenceZoom: 1 }, 100), 3);
assert.equal(core.imageMapZoomScale({ imageScaleWithMapZoom: true, imageReferenceZoom: 100 }, 1), 0.5);
assert.equal(core.imageMapZoomScale({ imageScaleWithMapZoom: false, imageReferenceZoom: 1 }, 100), 1);

const continuity = core.createProject('Image continuity');
continuity.layers = [structuredClone(image)];
continuity.views = ['A', 'B', 'C'].map((name) => {
  const view = core.createView(name, [image], camera(), [image]);
  view.holdDuration = 5;
  view.layerConfigs[image.id] = { included: true, animation: {} };
  return view;
});
continuity.views[0].layerConfigs[image.id].animation = {
  appearEnabled: true,
  appearType: 'fade',
  appearDelay: 4,
  appearDuration: 10,
};
continuity.transitions = [
  core.createTransition(continuity.views[0].id, continuity.views[1].id, [image], continuity.views[0]),
  core.createTransition(continuity.views[1].id, continuity.views[2].id, [image], continuity.views[1]),
];
continuity.transitions.forEach((transition) => {
  transition.duration = 1;
  transition.layerConfigs[image.id] = { included: true, animation: {} };
});
const atSeven = core.evaluateProjectAtTime(continuity, 7).layers[0];
assert.ok(Math.abs(atSeven.opacity - image.opacity * 0.3) < 1e-9, 'Appear continues into later segments');
assert.deepEqual(core.evaluateProjectAtTime(continuity, 7), core.evaluateProjectAtTime(continuity, 7));
core.evaluateProjectAtTime(continuity, 12);
assert.deepEqual(
  core.evaluateProjectAtTime(continuity, 3),
  core.evaluateProjectAtTime(continuity, 3),
  'reverse seek is stateless',
);

const persisted = core.validateAndMigrateProject(structuredClone(scaled));
assert.deepEqual(
  persisted.views[0].layerConfigs[image.id].animation,
  scaled.views[0].layerConfigs[image.id].animation,
);
assert.equal(
  core.evaluateProjectAtTime(projectFor(undefined), 1).layers[0].imageOrientation,
  undefined,
  '11.3A projects have no forced transient config',
);

// Image.mapmotion reproduction: a 20s Transition enters from an excluded View,
// with independent Wipe 0..4s and delayed Fade 2..5s.
const reproduction = core.createProject('Image.mapmotion reproduction');
reproduction.layers = [structuredClone(image)];
reproduction.assets = projectFor({}).assets;
const view1 = core.createView('View 1', [], camera(), [image]);
const view2 = core.createView('View 2', [image], camera(), [image]);
view1.holdDuration = 0;
view2.holdDuration = 1;
view1.layerConfigs[image.id] = { included: false };
view2.layerConfigs[image.id] = { included: true };
const transition = core.createTransition(view1.id, view2.id, [image], view1);
transition.duration = 20;
transition.layerConfigs[image.id] = {
  included: true,
  animation: {
    appearEnabled: true,
    appearType: 'fade',
    appearDelay: 2,
    appearDuration: 3,
    wipeEnabled: true,
    wipeDelay: 0,
    wipeDuration: 4,
  },
};
reproduction.views = [view1, view2];
reproduction.transitions = [transition];
for (const [time, opacity, visibleFraction] of [
  [0, 0, 1],
  [1, 0, 0.75],
  [2, 0, 0.5],
  [3, image.opacity / 3, 0.25],
  [4, (image.opacity * 2) / 3, 0],
  [5, image.opacity, 0],
  [10, image.opacity, 0],
]) {
  const state = core.evaluateProjectAtTime(reproduction, time).layers[0];
  const surface = core.imageRenderSurfaceState(state);
  assert.ok(Math.abs(surface.opacity - opacity) < 1e-9, `t=${time} Fade reaches rendered opacity`);
  assert.ok(
    Math.abs(surface.visibleFraction - visibleFraction) < 1e-9,
    `t=${time} Wipe reaches rendered mask`,
  );
  assert.ok(
    Math.abs(surface.visibleWidth - image.width * visibleFraction) < 1e-9,
    `t=${time} masked width changes visibly`,
  );
}
assert.deepEqual(core.evaluateProjectAtTime(reproduction, 20).layers[0], image);
for (const time of [0, 1, 2, 3, 4, 5, 10, 20]) {
  const direct = core.evaluateProjectAtTime(reproduction, time);
  core.evaluateProjectAtTime(reproduction, Math.max(0, 20 - time));
  assert.deepEqual(
    core.evaluateProjectAtTime(reproduction, time),
    direct,
    `t=${time} is seek-history independent`,
  );
}
for (const orientation of ['flat-on-map', 'face-camera']) {
  const candidate = structuredClone(reproduction);
  candidate.transitions[0].layerConfigs[image.id].animation.imageOrientation = orientation;
  const surface = core.imageRenderSurfaceState(core.evaluateProjectAtTime(candidate, 3).layers[0]);
  assert.equal(surface.orientation, orientation);
  assert.equal(surface.visibleFraction, 0.25);
  assert.ok(Math.abs(surface.opacity - image.opacity / 3) < 1e-9);
}

const app = source('src/app/App.tsx');
const overlay = source('src/core/onlineProjectOverlays.ts');
const renderer = source('src/core/onlineImageLayer.ts');
assert.match(app, /imageOrientation/);
assert.match(app, /imageScaleWithMapZoom/);
assert.match(overlay, /ensureOnlineImageLayer/, 'all Image modes use the retained renderer');
assert.match(renderer, /uniform float u_wipe_edge/, 'Wipe is a shader clip parameter');
assert.match(renderer, /uniform float u_opacity/, 'Fade is a shader opacity parameter');
assert.match(renderer, /uniform float u_face/, 'Flat and Face Camera share one renderer');
assert.doesNotMatch(
  renderer,
  /createElement\(['"]canvas|toDataURL|drawImage|updateImage|\.loadImage\(|addSource|removeSource/,
);
assert.match(renderer, /const resourceUrls = new Set/, 'invisible Appear frames retain the static asset');
assert.match(
  renderer,
  /if \(resourceUrls\.has\(url\)\) continue/,
  'temporary visibility does not evict textures',
);

const baseParameters = core.onlineImageRenderParameters(image, 800, 400);
const fadeParameters = core.onlineImageRenderParameters({ ...image, opacity: 0.4 }, 800, 400);
assert.equal(fadeParameters.opacity, 0.4, 'Fade reaches the actual shader opacity');
const popParameters = core.onlineImageRenderParameters({ ...image, imageAnimationScale: 0.5 }, 800, 400);
assert.ok(popParameters.offsets[1][0] < baseParameters.offsets[1][0], 'Pop shrinks the rendered quad');
assert.deepEqual(popParameters.anchor, baseParameters.anchor, 'Pop keeps the geographic anchor fixed');
const dropParameters = core.onlineImageRenderParameters({ ...image, imageDropOffsetY: -40 }, 800, 400);
assert.equal(dropParameters.anchor[1], baseParameters.anchor[1] - 40, 'Drop moves the rendered quad');
const wipeParameters = core.onlineImageRenderParameters({ ...image, imageWipeProgress: 0.5 }, 800, 400);
assert.equal(wipeParameters.wipe, 0.5, 'Wipe reaches the actual shader clip boundary');
const combined = core.onlineImageRenderParameters(
  { ...image, opacity: 0.4, imageWipeProgress: 0.25 },
  800,
  400,
);
assert.equal(combined.opacity, 0.4);
assert.equal(combined.wipe, 0.25, 'Fade and Wipe remain independent renderer parameters');

for (const count of [1, 3, 5]) {
  const staticImages = Array.from({ length: count }, (_, index) => ({
    ...image,
    id: `static-${index}`,
    x: image.x + index * 20,
  }));
  const first = staticImages.map((item) => core.onlineImageRenderParameters(item, 800, 400));
  const second = staticImages.map((item) => core.onlineImageRenderParameters(item, 800, 400));
  assert.deepEqual(second, first, `${count} static Images produce stable retained-render parameters`);
}

assert.doesNotMatch(
  source('src/components/OnlineOpenFreeMap.tsx').match(
    /const overlayAssetSignature[\s\S]*?\n\s*useLayoutEffect/,
  )?.[0] ?? '',
  /imageWipeProgress/,
  'animation frames do not schedule async asset preparation',
);

console.log('Online Image timeline regression checks passed.');
