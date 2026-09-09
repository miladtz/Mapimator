import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { createLayer, createProject, createView } = await server.ssrLoadModule('/src/core/project.ts');
  const { parseProjectFile, serializeCanonicalProject } = await server.ssrLoadModule(
    '/src/core/projectFile.ts',
  );
  const { animatedMediaActiveIntervals } = await server.ssrLoadModule('/src/core/viewCompiler.ts');
  const sha256 = 'a'.repeat(64);
  const asset = {
    id: `asset_${sha256}`,
    kind: 'image',
    filename: 'review.webp',
    mediaType: 'image/webp',
    sha256,
    size: 128,
    width: 160,
    height: 90,
    packagePath: `assets/${sha256}.webp`,
  };
  const media = createLayer('animated-media');
  delete media.color;
  Object.assign(media, {
    assetId: asset.id,
    animatedMediaCycleDurationMs: 2000,
    animatedMediaRotation: 30,
    animatedMediaAspectLocked: true,
    animatedMediaAspectRatio: 16 / 9,
  });
  const project = createProject('Animated Media save regression');
  project.assets = [asset];
  project.layers = [media, createLayer('image'), createLayer('route'), createLayer('shape'), createLayer('text')];
  project.views = [createView('View 1', project.layers, { x: 0, y: 0, zoom: 1 }, project.layers)];
  project.views[0].layerConfigs[media.id] = {
    included: true,
    animation: {
      animatedMediaRepeatCountEnabled: true,
      animatedMediaRepeatCount: 2.5,
      animatedMediaDuration: 5,
      animatedMediaStartDelay: 0.25,
    },
  };
  const serialized = serializeCanonicalProject(project);
  const reopened = parseProjectFile(serialized.json);
  const savedMedia = reopened.layers.find((layer) => layer.id === media.id);
  assert.equal(savedMedia?.assetId, asset.id);
  assert.equal(savedMedia?.animatedMediaRotation, 30);
  assert.equal(savedMedia?.animatedMediaAspectRatio, 16 / 9);
  assert.equal(reopened.views[0].layerConfigs[media.id].animation?.animatedMediaRepeatCount, 2.5);
  assert.equal(reopened.views[0].layerConfigs[media.id].animation?.animatedMediaDuration, 5);
  const segment = (id, start, end, included, animation) => ({
    kind: 'view', id, start, end, duration: end - start,
    view: {
      id, name: id, holdDuration: end - start, camera: { x: 0, y: 0, zoom: 1 }, mapMode: 'flat',
      layerConfigs: { [media.id]: { included, animation } }, thumbnailColor: '#000000',
    },
  });
  assert.deepEqual(
    animatedMediaActiveIntervals(
      [segment('a', 0, 5, true), segment('gap', 5, 7, false), segment('b', 7, 12, true)],
      media.id,
      2000,
    ),
    [{ start: 0, end: 5 }, { start: 7, end: 12 }],
    'Positive-duration exclusion must restart the media clock.',
  );
  assert.deepEqual(
    animatedMediaActiveIntervals(
      [
        segment('t1', 0, 5, true, { animatedMediaRepeatCountEnabled: true, animatedMediaRepeatCount: 6.5 }),
        segment('t2', 5, 10, true, { animatedMediaRepeatCountEnabled: true, animatedMediaRepeatCount: 2.5 }),
        segment('t3', 10, 15, true, { animatedMediaRepeatCountEnabled: true, animatedMediaRepeatCount: 2 }),
      ],
      media.id,
      2000,
    ),
    [{ start: 0, end: 14 }],
    'Runtime segment resolver must union the human 13/5/4 scenario.',
  );
  console.log('Animated Media canonical Save/reopen regression passed.');
} finally {
  await server.close();
}
