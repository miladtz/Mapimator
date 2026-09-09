import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createRichProductionBasemapProject } from './fixtures/production-basemap-project.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (path) => readFileSync(join(root, path), 'utf8');
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const projectCore = await server.ssrLoadModule('/src/core/project.ts');
  const routeCore = await server.ssrLoadModule('/src/core/routes.ts');
  const persistence = await server.ssrLoadModule('/src/core/projectFile.ts');
  const basemaps = await server.ssrLoadModule('/src/core/basemaps.ts');
  const labels = await server.ssrLoadModule('/src/core/onlineMapLabelPolicy.ts');
  const adapter = await server.ssrLoadModule('/src/core/openFreeMapAdapter.ts');
  const viewportCore = await server.ssrLoadModule('/src/core/projectRenderViewport.ts');
  const evaluator = await server.ssrLoadModule('/src/core/viewCompiler.ts');

  const productionIds = ['liberty', 'minimal-navy', 'minimal-light', 'satellite'];
  assert.deepEqual(
    productionIds.map((id) => basemaps.basemapById(id).id),
    productionIds,
  );
  const fixture = createRichProductionBasemapProject(projectCore, routeCore);
  const invariant = structuredClone(fixture);
  delete invariant.mapSettings.onlineStyleId;
  const editorState = {
    project: fixture,
    selectedLayerId: 'fixture-route',
    selectedTimelineId: 'fixture-transition-1',
    time: 4.25,
  };
  for (let index = 0; index < 20; index += 1) {
    const id = productionIds[index % productionIds.length];
    const beforeLayers = editorState.project.layers;
    const beforeViews = editorState.project.views;
    const beforeTransitions = editorState.project.transitions;
    editorState.project = projectCore.setProjectBasemap(editorState.project, id);
    assert.equal(editorState.project.layers, beforeLayers);
    assert.equal(editorState.project.views, beforeViews);
    assert.equal(editorState.project.transitions, beforeTransitions);
    assert.equal(editorState.selectedLayerId, 'fixture-route');
    assert.equal(editorState.selectedTimelineId, 'fixture-transition-1');
    assert.equal(editorState.time, 4.25);
    const comparable = structuredClone(editorState.project);
    delete comparable.mapSettings.onlineStyleId;
    assert.deepEqual(comparable, invariant);
  }

  const viewport = viewportCore.projectRenderViewport(fixture);
  for (const camera of fixture.views.map(({ camera }) => camera)) {
    const expected = adapter.mapMotionToMapLibreCamera(camera, viewport);
    for (const id of productionIds) {
      const switched = projectCore.setProjectBasemap(fixture, id);
      assert.deepEqual(adapter.mapMotionToMapLibreCamera(camera, viewport), expected);
      assert.deepEqual(
        switched.views.map(({ camera }) => camera),
        fixture.views.map(({ camera }) => camera),
      );
    }
  }

  for (const id of productionIds) {
    const definition = basemaps.basemapById(id);
    assert.equal(definition.capabilities.flat, true);
    const credentials = { maptilerApiKey: id === 'satellite' ? 'fixture-key' : '' };
    assert.equal(basemaps.resolveBasemapStyle(definition, credentials).status, 'available');
    const saved = persistence.serializeCanonicalProject(projectCore.setProjectBasemap(fixture, id)).json;
    assert.doesNotMatch(saved, /fixture-key|maptilerApiKey/i);
    const reopened = persistence.parseProjectFile(saved);
    assert.equal(reopened.mapSettings.onlineStyleId, id);
    assert.deepEqual(
      reopened.layers.map(({ id: layerId }) => layerId),
      fixture.layers.map(({ id: layerId }) => layerId),
    );
    assert.deepEqual(
      reopened.views.map(({ holdDuration }) => holdDuration),
      [3, 0, 4],
    );
  }

  assert.equal(
    basemaps.resolveBasemapStyle(basemaps.basemapById('satellite'), { maptilerApiKey: '' }).status,
    'missing-credential',
  );
  assert.doesNotMatch(basemaps.sanitizeBasemapError('failed https://host/x?key=SECRET'), /SECRET/);
  assert.equal(basemaps.basemapById('satellite').capabilities.globe, false);
  for (const mode of ['en', 'fa', 'both', 'none']) {
    assert.notEqual(labels.mapLabelTextField(['get', 'name'], mode), undefined);
    for (const id of productionIds)
      assert.equal(basemaps.basemapById(id).capabilities.labelLanguageSwitching, true);
  }

  for (const zoom of [20, 40, 50, 100, 500, 1000]) {
    const mapLibreZoom = Math.log2(zoom) + Math.log2(540 / 512);
    assert.equal(Math.round(mapLibreZoom + Math.log2(512 / 512)), Math.round(mapLibreZoom));
  }
  const evaluated = evaluator.evaluateProjectAtTime(fixture, 4.25);
  assert.deepEqual(
    evaluated.layers.map(({ id }) => id),
    fixture.layers.map(({ id }) => id),
  );
  assert.ok(evaluated.layers.find(({ id }) => id === 'fixture-route')?.routeRenderState?.length);
  assert.ok(Number.isFinite(evaluated.layers.find(({ id }) => id === 'fixture-media')?.animatedMediaTimeMs));

  const serialized = persistence.serializeCanonicalProject(fixture).json;
  assert.equal(
    persistence.serializeCanonicalProject(persistence.parseProjectFile(serialized)).json,
    serialized,
  );
  const interactive = source('src/components/OnlineOpenFreeMap.tsx');
  const renderer = source('src/core/onlineMapFrameRenderer.ts');
  const overlaySource = source('src/core/onlineProjectOverlays.ts');
  assert.match(interactive, /BasemapSwitchGeneration/);
  assert.match(interactive, /styleGenerationRef\.current\.isCurrent\(generation\)/);
  assert.doesNotMatch(
    interactive,
    /if \(loadedStyleRef\.current === styleId\)[\s\S]{0,900}(?:fitBounds|jumpTo)/,
    'basemap switching must not move the camera',
  );
  assert.match(renderer, /map\.loaded\(\) && map\.areTilesLoaded\(\) && !map\.isMoving\(\)/);
  assert.match(renderer, /ONLINE_MAP_READY_TIMEOUT_MS/);
  assert.match(renderer, /resolveBasemapStyle\(basemap, mapServiceSettings\)/);
  assert.match(renderer, /applyBasemapBoundaryPolicy\(map, basemap\)/);
  assert.match(renderer, /applyBasemapLabelLanguage\(map, basemap, labelLanguage, true\)/);
  assert.doesNotMatch(renderer, /maptilerApiKey.*console|console.*maptilerApiKey/i);
  for (const type of ['region', 'route', 'shape', 'image', 'animated-media', 'pin', 'text'])
    assert.match(overlaySource, new RegExp(`layer\\.type === ['"]${type}['"]`));

  console.log(
    'Production basemap matrix: rich project, 20-switch state/camera/timeline/overlay stress, labels, credentials, persistence, deep zoom, readiness, and Editor/Export policy parity passed.',
  );
} finally {
  await server.close();
}
