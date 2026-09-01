import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'online-search-'));
const entry = join(out, 'entry.ts');
const modulePath = (path) => join(root, path).replaceAll('\\', '/');
writeFileSync(
  entry,
  `export * from '${modulePath('src/core/locationSearch')}';\nexport * from '${modulePath('src/core/project')}';\nexport * from '${modulePath('src/core/projectRenderViewport')}';`,
);
let core;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: out,
      emptyOutDir: false,
      minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'module.mjs' },
    },
  });
  core = await import(pathToFileURL(join(out, 'module.mjs')).href);
} finally {
  rmSync(out, { recursive: true, force: true });
}

const first = (query) => core.searchLocalLocations(query)[0];
assert.equal(first('Iran').category, 'Country');
assert.equal(first('California').category, 'Administrative Region');
assert.equal(first('Africa').category, 'Continent');
assert.equal(first('MENA').category, 'Macro Region');
assert.equal(first('USA').countryCode, 'USA');
assert.equal(first('ایران').countryCode, 'IRN');
assert.equal(first('تهران').name, 'Tehran');
assert.equal(first('Tehran').category, 'City');
assert.equal(first('Persian Gulf').category, 'Sea');
assert.equal(first('35.6892, 51.3890').source, 'coordinates');
assert.equal(first('35.6892 51.3890').coordinates.longitude, 51.389);
assert.deepEqual(first('35.6892 N, 51.3890 E').coordinates, { longitude: 51.389, latitude: 35.6892 });
assert.equal(core.parseCoordinateQuery('91, 0'), null);
assert.equal(core.parseCoordinateQuery('0, 181'), null);
assert.equal(first('90, 0').coordinates.latitude, 85.05112878);

const localIran = first('Iran');
const duplicateIran = { ...localIran, id: 'geocoder:iran', source: 'geocoder' };
assert.equal(core.mergeSearchResults([localIran], [duplicateIran]).length, 1);
const normalized = core.normalizePhotonResults([
  {
    properties: { osm_id: 1, name: 'Paris', osm_value: 'city', country: 'France', countrycode: 'fr' },
    geometry: { coordinates: [2.3522, 48.8566] },
    bbox: [2.2, 48.8, 2.5, 48.95],
  },
  {
    properties: { osm_id: 2, name: 'JFK Airport', osm_value: 'airport' },
    geometry: { coordinates: [-73.7781, 40.6413] },
  },
  {
    properties: { osm_id: 3, name: 'Eiffel Tower', osm_value: 'attraction' },
    geometry: { coordinates: [2.2945, 48.8584] },
  },
  { properties: { osm_id: 4, street: 'Main Street', osm_value: 'house' }, geometry: { coordinates: [1, 2] } },
]);
assert.deepEqual(
  normalized.map((result) => result.category),
  ['City', 'Airport', 'POI', 'Address'],
);
assert.equal(core.normalizePhotonResults([{ geometry: { coordinates: [999, 0] } }]).length, 0);

for (const layoutId of ['landscape', 'portrait', 'square', 'portrait-4-5', 'classic-4-3']) {
  const project = core.createProject(layoutId);
  const preset = core.CANVAS_LAYOUTS.find((candidate) => candidate.id === layoutId);
  project.canvas = { ...project.canvas, layoutId, width: preset.width, height: preset.height };
  const viewport = core.projectRenderViewport(project);
  const current = { x: 0, y: 0, zoom: 4, bearing: 450, pitch: 65 };
  const pointCamera = core.cameraForSearchResult(first('Tehran'), current, 'online', viewport);
  assert.equal(pointCamera.pitch, 0);
  assert.equal(pointCamera.bearing, 450);
  const boundsCamera = core.cameraForSearchResult(localIran, current, 'online', viewport);
  assert.equal(boundsCamera.pitch, 0);
  assert.ok(Number.isFinite(boundsCamera.zoom));
}
const wrappedZoom = core.mapLibreZoomForBounds(
  { west: 179, south: -10, east: 181, north: 10 },
  { width: 960, height: 540, aspectRatio: 16 / 9 },
);
const brokenZoom = core.mapLibreZoomForBounds(
  { west: -179, south: -10, east: 179, north: 10 },
  { width: 960, height: 540, aspectRatio: 16 / 9 },
);
assert.ok(wrappedZoom > brokenZoom, 'wrapped bounds avoid near-world zoom');
assert.equal(core.trimRecentSearches([localIran, first('Tehran'), localIran], 2).length, 2);

const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
const panel = readFileSync(join(root, 'src/components/SearchPanel.tsx'), 'utf8');
const online = readFileSync(join(root, 'src/components/OnlineOpenFreeMap.tsx'), 'utf8');
const styles = readFileSync(join(root, 'src/styles/global.css'), 'utf8');
assert.match(app, /event\.ctrlKey \|\| event\.metaKey/);
assert.match(app, /key\.toLocaleLowerCase\(\) === 'k'/);
assert.match(app, /cameraForSearchResult/);
assert.match(app, /createLayer\('pin'\)/);
assert.match(app, /createGeographicRegionLayer/);
assert.match(app, /findAdministrativeRegion/);
assert.doesNotMatch(app, /SearchResult[\s\S]{0,80}Project/);
assert.match(panel, /window\.setTimeout\([\s\S]{0,300}250/);
assert.match(panel, /ArrowDown/);
assert.match(panel, /ArrowUp/);
assert.match(panel, /event\.key === 'Enter'/);
assert.match(panel, /event\.key === 'Escape'/);
assert.match(panel, /Clear Search/);
assert.match(panel, /Online POI\/address search requires a configured production geocoder/);
assert.match(online, /map\.stop\(\)/);
assert.match(online, /map\.easeTo\(\{ \.\.\.target, duration: 700/);

const canvasColumnIndex = app.indexOf('<section className="canvas-column">');
const searchColumnIndex = app.indexOf('{locationSearchOpen && (\n          <SearchPanel');
const propertiesColumnIndex = app.indexOf('className={`panel right-panel');
assert.ok(canvasColumnIndex >= 0 && searchColumnIndex > canvasColumnIndex);
assert.ok(propertiesColumnIndex > searchColumnIndex, 'desktop column order is Map → Search → Properties');
assert.doesNotMatch(
  app.slice(app.indexOf('<div className={`map-frame'), searchColumnIndex),
  /<SearchPanel/,
  'Search is not mounted over the map frame',
);
assert.match(app, /workspace[\s\S]{0,180}locationSearchOpen \? 'search-open'/);
assert.match(app, /focusRequest=\{locationSearchFocusRequest\}/);
assert.match(app, /setLocationSearchFocusRequest\(\(request\) => request \+ 1\)/);
assert.match(app, /if \(locationSearchOpen\) \{\s*setLocationSearchOpen\(false\);\s*return;/);
assert.doesNotMatch(
  app.slice(app.indexOf('const addPinFromSearch'), app.indexOf('const addRegionFromSearch')),
  /setLocationSearchOpen\(false\)/,
  'Add Pin keeps Search open',
);
assert.doesNotMatch(
  app.slice(app.indexOf('const addRegionFromSearch'), app.indexOf('const exportProof')),
  /setLocationSearchOpen\(false\)/,
  'Add Region and duplicate selection keep Search open',
);
assert.match(panel, /className="panel location-search-panel"/);
assert.doesNotMatch(panel, /role="dialog"/);
assert.match(panel, /inputRef\.current\?\.select\(\)/);
assert.match(panel, />\s*Go Here\s*</);
assert.match(panel, /location-search-body/);
assert.match(styles, /\.workspace\.search-open\s*\{[\s\S]{0,220}minmax\(280px, 300px\)/);
assert.match(styles, /\.workspace\.layers-closed\.search-open/);
assert.match(styles, /\.location-search-panel\s*\{[\s\S]{0,220}display: grid/);
assert.match(styles, /\.location-search-results\s*\{[\s\S]{0,100}overflow-y: auto/);
assert.doesNotMatch(
  styles.slice(styles.indexOf('.location-search-panel'), styles.indexOf('.online-map-navigation')),
  /position:\s*(?:absolute|fixed)/,
  'Search uses a grid column rather than overlay positioning',
);

let providerCalls = 0;
const provider = {
  id: 'mock',
  attribution: 'Mock',
  async search(query, signal) {
    providerCalls += 1;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, query === 'slow' ? 20 : 1);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
    });
    return normalized;
  },
};
const controller = new core.LocationSearchController(provider, 2);
await controller.search('Paris');
await controller.search('Paris');
assert.equal(providerCalls, 1, 'bounded provider cache avoids duplicate calls');
await controller.search('35.6892, 51.3890');
assert.equal(providerCalls, 1, 'coordinate query never calls provider');
const slow = controller.search('slow').catch((error) => error.name);
const fast = controller.search('fast');
assert.equal(await slow, 'AbortError');
assert.equal((await fast).onlineUnavailable, false);

const benchmarkStarted = performance.now();
for (let index = 0; index < 1_000; index += 1) core.searchLocalLocations(index % 2 ? 'Tehran' : 'ایران');
const averageSearchMs = (performance.now() - benchmarkStarted) / 1_000;

console.log(
  `Online Search: 100 local/coordinate/provider/UI/column-layout/camera/project-safety/integration/frame-format behaviors passed; average local query ${averageSearchMs.toFixed(3)} ms.`,
);
