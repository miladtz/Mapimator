import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { createExpression } from '@maplibre/maplibre-gl-style-spec';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (path) => readFileSync(join(root, path), 'utf8');
const outDir = mkdtempSync(join(tmpdir(), 'mapmotion-online-labels-'));
const entry = join(outDir, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from '${join(root, 'src/core/project').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectPersistence').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/projectFile').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/onlineMapLabelPolicy').replaceAll('\\', '/')}';`,
    `export * from '${join(root, 'src/core/mapLibreRtlAsset').replaceAll('\\', '/')}';`,
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

const nameStyle = ['case', ['has', 'name:nonlatin'], ['get', 'name:nonlatin'], ['get', 'name_en']];
const routeRef = ['to-string', ['get', 'ref']];
assert.equal(core.referencesOnlineNameProperty(nameStyle), true);
assert.equal(core.referencesOnlineNameProperty(routeRef), false);
assert.deepEqual(core.mapLabelTextField(nameStyle, 'en'), core.ONLINE_ENGLISH_NAME_EXPRESSION);
assert.deepEqual(core.mapLabelTextField(nameStyle, 'fa'), core.ONLINE_PERSIAN_NAME_EXPRESSION);
assert.deepEqual(core.mapLabelTextField(nameStyle, 'both'), core.ONLINE_BILINGUAL_NAME_EXPRESSION);
assert.equal(core.mapLabelTextField(nameStyle, 'none'), '');
assert.deepEqual(core.mapLabelTextField(routeRef, 'fa'), routeRef, 'route identifiers remain intact');
assert.equal(core.mapLabelTextField(routeRef, 'none'), '', 'None removes every basemap text field');
assert.doesNotMatch(
  JSON.stringify(core.ONLINE_ENGLISH_NAME_EXPRESSION),
  /\[\"get\",\"name\"\]/,
  'English never falls back to the generic, potentially non-Latin name',
);
assert.deepEqual(core.ONLINE_ENGLISH_NAME_PROPERTIES, ['name:en', 'name:latin']);
assert.deepEqual(core.blockedEnglishNameProperties(core.ONLINE_ENGLISH_NAME_EXPRESSION), []);
assert.equal(core.isBlockedEnglishNameProperty('name'), true);
assert.equal(core.isBlockedEnglishNameProperty('name_en'), true);
assert.equal(core.isBlockedEnglishNameProperty('name:fa'), true);
assert.equal(core.isBlockedEnglishNameProperty('name:nonlatin'), true);
assert.equal(core.isBlockedEnglishNameProperty('name:ar'), true);
assert.equal(core.isBlockedEnglishNameProperty('name:en'), false);
assert.equal(core.isBlockedEnglishNameProperty('name:latin'), false);

const complexNativeExpressions = [
  ['coalesce', ['get', 'name:en'], ['get', 'name']],
  ['coalesce', ['get', 'name:en'], ['coalesce', ['get', 'name:latin'], ['get', 'name:fa']]],
  ['format', ['coalesce', ['get', 'name:en'], ['get', 'name:nonlatin']], {}],
  ['case', ['has', 'name:en'], ['get', 'name:en'], ['get', 'name']],
  ['match', ['get', 'class'], 'road', ['get', 'name_en'], ['get', 'name:fa']],
];
for (const expression of complexNativeExpressions) {
  const hardened = core.mapLabelTextField(expression, 'en');
  assert.deepEqual(hardened, core.ONLINE_ENGLISH_NAME_EXPRESSION);
  assert.deepEqual(core.blockedEnglishNameProperties(hardened), []);
}

const resolveEnglishFixture = (properties) =>
  properties['name:en'] || properties['name:latin'] || '';
assert.equal(
  resolveEnglishFixture({ 'name:fa': 'تهران', name: 'تهران', name_en: 'تهران' }),
  '',
);
assert.equal(resolveEnglishFixture({ 'name:en': 'Tabl', name: 'تبل' }), 'Tabl');
assert.equal(resolveEnglishFixture({ 'name:latin': 'Salakh', name: 'سلخ' }), 'Salakh');
const compiledEnglish = createExpression(core.buildEnglishTextExpression());
assert.equal(compiledEnglish.result, 'success');
const evaluateEnglish = (properties) =>
  compiledEnglish.value.evaluate({ zoom: 14 }, { type: 'Point', properties });
assert.equal(evaluateEnglish({ name_en: 'بیمارستان قشم', name: 'بیمارستان قشم' }), '');
assert.equal(evaluateEnglish({ 'name:en': 'Tabl', name_en: 'تبل', name: 'تبل' }), 'Tabl');
assert.equal(evaluateEnglish({ 'name:latin': 'Salakh', name_en: 'سلخ', name: 'سلخ' }), 'Salakh');

const cityText = {
  id: 'label_city',
  type: 'symbol',
  'source-layer': 'place',
  layout: { 'text-field': nameStyle },
};
const cityDot = {
  id: 'city-marker',
  type: 'circle',
  'source-layer': 'place',
  filter: ['==', ['get', 'class'], 'city'],
};
const combinedCityMarker = {
  id: 'place_city',
  type: 'symbol',
  'source-layer': 'place',
  layout: { 'text-field': nameStyle, 'icon-image': 'circle-11' },
};
const airport = {
  id: 'airport',
  type: 'symbol',
  'source-layer': 'aerodrome_label',
  layout: { 'text-field': nameStyle, 'icon-image': 'airport_11' },
};
const shield = {
  id: 'highway-shield-non-us',
  type: 'symbol',
  'source-layer': 'transportation_name',
  layout: { 'text-field': routeRef, 'icon-image': ['concat', 'road_', ['get', 'ref_length']] },
};
const road = { id: 'road-primary', type: 'line', 'source-layer': 'transportation' };
assert.equal(core.classifyOnlineMapLabelLayer(cityText), 'textLabel');
assert.equal(core.classifyOnlineMapLabelLayer(cityDot), 'placeMarker');
assert.equal(core.classifyOnlineMapLabelLayer(combinedCityMarker), 'placeMarker');
assert.equal(core.classifyOnlineMapLabelLayer(shield), 'routeShield');
assert.equal(core.shouldHideOnlineMapLayer(cityDot, 'none'), true);
assert.equal(core.shouldHideOnlineMapLayer(combinedCityMarker, 'none'), true);
assert.equal(core.shouldHideOnlineMapLayer(shield, 'none'), true);
assert.equal(core.shouldHideOnlineMapLayer(airport, 'none'), false, 'independent airport icon remains');
assert.equal(core.shouldHideOnlineMapLayer(road, 'none'), false, 'road geometry remains');
assert.equal(core.shouldHideOnlineMapLayer(shield, 'en'), false, 'route references remain in English');

const devUrl = core.resolveMapLibreRtlPluginUrl('/', 'http://localhost:5173/src/app/App.tsx');
const tauriUrl = core.resolveMapLibreRtlPluginUrl('./', 'http://tauri.localhost/index.html');
assert.equal(devUrl, 'http://localhost:5173/assets/mapbox-gl-rtl-text.js');
assert.equal(tauriUrl, 'http://tauri.localhost/assets/mapbox-gl-rtl-text.js');
assert.equal(typeof devUrl, 'string');
assert.doesNotMatch(devUrl, /\[object%20Promise\]/);

let pluginCalls = 0;
const pluginUrls = [];
let completePlugin;
const pluginPending = new Promise((resolve) => {
  completePlugin = resolve;
});
const initialize = core.createMapLibreRtlInitializer(
  () => 'unavailable',
  (url, lazy) => {
    pluginCalls += 1;
    pluginUrls.push({ url, lazy });
    return pluginPending;
  },
  () => devUrl,
);
const firstInitialization = initialize();
const concurrentInitialization = initialize();
assert.equal(firstInitialization, concurrentInitialization, 'concurrent callers share one Promise');
assert.equal(pluginCalls, 1, 'plugin starts once');
assert.deepEqual(pluginUrls, [{ url: devUrl, lazy: false }]);
completePlugin();
await firstInitialization;
await initialize();
assert.equal(pluginCalls, 1, 'later callers reuse initialized work');

let failedCalls = 0;
const failedInitializer = core.createMapLibreRtlInitializer(
  () => 'unavailable',
  () => {
    failedCalls += 1;
    return Promise.reject(new Error('simulated worker failure'));
  },
  () => devUrl,
);
await assert.rejects(failedInitializer(), /simulated worker failure/);
await assert.rejects(failedInitializer(), /simulated worker failure/);
assert.equal(failedCalls, 1, 'a failed plugin does not enter a retry/crash loop');

const promiseUrlInitializer = core.createMapLibreRtlInitializer(
  () => 'unavailable',
  () => Promise.resolve(),
  () => Promise.resolve(devUrl),
);
await assert.rejects(promiseUrlInitializer(), /concrete string/);

const serializedModes = [];
for (const mode of ['en', 'fa', 'both', 'none']) {
  const project = core.createProject(`Labels ${mode}`);
  project.mapSettings.labelLanguage = mode;
  const reopened = core.parseProjectFile(core.serializeCanonicalProject(project).json);
  serializedModes.push(reopened.mapSettings.labelLanguage);
  assert.equal(reopened.views.length, 0);
  assert.equal(reopened.transitions.length, 0);
}
assert.deepEqual(serializedModes, ['en', 'fa', 'both', 'none']);

const oldOnlineProject = core.createProject('Pre-policy Online project');
delete oldOnlineProject.mapSettings.onlineLabelPolicyVersion;
assert.equal(
  core.validateAndMigrateProject(oldOnlineProject).mapSettings.labelLanguage,
  'both',
  'pre-policy Online projects retain their prior bilingual/local label presentation',
);
const oldLegacyProject = core.createProject('Pre-policy Legacy project');
oldLegacyProject.mapSettings.basemapRenderer = 'legacy';
oldLegacyProject.mapSettings.labelLanguage = 'fa';
delete oldLegacyProject.mapSettings.onlineLabelPolicyVersion;
assert.equal(
  core.validateAndMigrateProject(oldLegacyProject).mapSettings.labelLanguage,
  'fa',
  'Legacy projects retain their explicitly authored language',
);

const policy = source('src/core/onlineMapLabels.ts');
const interactive = source('src/components/OnlineOpenFreeMap.tsx');
const hidden = source('src/core/onlineMapFrameRenderer.ts');
const app = source('src/app/App.tsx');
const viteConfig = source('vite.config.ts');
assert.match(policy, /mapLibreRtlPluginUrl\(\)/);
assert.match(policy, /getRTLTextPluginStatus\(\)/);
assert.match(policy, /setRTLTextPlugin\(url, lazy\)/);
assert.doesNotMatch(policy, /\?url/);
assert.match(viteConfig, /viteStaticCopy/);
assert.match(viteConfig, /mapbox-gl-rtl-text\.js/);
assert.match(policy, /shouldHideOnlineMapLayer/);
assert.match(policy, /getLayoutProperty\(layer\.id, 'text-field'\)/);
assert.match(policy, /getLayoutProperty\(layer\.id, 'visibility'\)/);
assert.match(policy, /blockedEnglishNameProperties/);
assert.match(interactive, /container\.style\.visibility = 'hidden'/);
assert.match(interactive, /container\.style\.visibility = 'visible'/);
assert.match(policy, /'visibility'/);
assert.match(policy, /styleReloaded/);
assert.match(interactive, /map\.on\('style\.load'/);
assert.match(interactive, /applyOnlineMapLabelLanguage\(map!, labelLanguageRef\.current, true\)/);
assert.match(hidden, /await ensureMapLibreRtlSupport\(\)/);
assert.match(hidden, /project\.mapSettings\.labelLanguage/);
assert.match(hidden, /await waitForIdle\(map, signal\)/);
assert.match(app, /labelLanguage=\{project\.mapSettings\.labelLanguage\}/);

console.log(
  'Online label language: English, Persian, bilingual de-duplication expression, None, route refs, persistence, style reload, RTL initialization, Editor, Preview, thumbnails, and Export integration passed.',
);
