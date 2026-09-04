import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'route-vehicles-'));
const entry = join(out, 'entry.ts');
const source = (value) => join(root, value).replaceAll('\\', '/');
writeFileSync(
  entry,
  `export * from '${source('src/core/routes')}'; export { createProject } from '${source('src/core/project')}'; export { serializeCanonicalProject, parseProjectFile } from '${source('src/core/projectFile')}'; export { findReferencedAssets } from '${source('src/core/projectAssets')}'; export { onlineRouteFeatureCollection, loadOnlineProjectOverlayAssets } from '${source('src/core/onlineProjectOverlays')}';`,
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

for (const vehicle of [
  'sedan',
  'suv',
  'taxi',
  'pickup',
  'van',
  'delivery-van',
  'bus',
  'coach',
  'small-truck',
  'box-truck',
  'semi-truck',
  'tanker-truck',
  'motorcycle',
  'passenger-plane',
  'cargo-plane',
  'private-jet',
  'small-plane',
  'helicopter',
  'container-ship',
  'cargo-ship',
  'bulk-carrier',
  'oil-tanker',
  'lng-carrier',
  'ferry',
  'cruise-ship',
  'small-boat',
  'speedboat',
  'yacht',
  'sailboat',
  'dot',
  'pulse',
  'arrow',
  'directional-capsule',
  'package',
  'person',
  'money',
  'custom',
])
  assert.ok(core.ROUTE_VEHICLE_LABELS[vehicle], `missing built-in vehicle ${vehicle}`);

const timing = {
  included: true,
  vehicleEnabled: true,
  vehicleDelay: 1,
  vehicleDuration: 8,
  vehicleRepetitive: true,
  vehicleInterval: 2,
  vehicleType: 'sedan',
  vehicleFollowDirection: true,
  vehicleOrientationOffset: 15,
};
assert.equal(core.evaluateRouteVehicleInstances('section', timing, 0.999).length, 0);
assert.deepEqual(core.evaluateRouteVehicleInstances('section', timing, 1), [
  { id: 'section-vehicle-0', progress: 0 },
]);
const atSeven = core.evaluateRouteVehicleInstances('section', timing, 7);
assert.equal(atSeven.length, 4);
assert.deepEqual(
  atSeven.map((instance) => instance.progress),
  [0.75, 0.5, 0.25, 0],
);
assert.deepEqual(
  core.evaluateRouteVehicleInstances('section', timing, 7),
  atSeven,
  'direct seek must be history-independent',
);

const points = [
  { id: 'a', name: 'A', longitude: 0, latitude: 0 },
  { id: 'b', name: 'B', longitude: 10, latitude: 5 },
  { id: 'c', name: 'C', longitude: 20, latitude: 0 },
  { id: 'd', name: 'D', longitude: 30, latitude: 5 },
];
const layer = core.createRouteLayer(points);
const [first, second, third] = layer.routeSegments.map((section) => section.id);
const assetId = `asset_${'a'.repeat(64)}`;
const animation = {
  routeSegmentAnimations: {
    [first]: { ...timing, vehicleType: 'custom', vehicleAssetId: assetId },
    [second]: { ...timing, vehicleType: 'small-plane', vehicleInterval: 3 },
    [third]: { ...timing, included: false, vehicleType: 'cargo-ship' },
  },
};
core.applyRouteEvaluation(layer, animation, 7);
assert.equal(layer.routeRenderState[0].vehicleInstances.length, 4);
assert.equal(layer.routeRenderState[1].vehicleInstances.length, 3);
assert.equal(layer.routeRenderState[2].vehicleInstances.length, 0);
const features = core.onlineRouteFeatureCollection([layer], null, {
  [assetId]: 'data:image/png;base64,AA==',
});
const vehicles = features.features.filter((feature) => feature.properties.role === 'vehicle');
assert.equal(vehicles.length, 7);
assert.equal(vehicles.filter((feature) => feature.properties.segmentId === first).length, 4);
assert.ok(vehicles.every((feature) => Number.isFinite(feature.properties.bearing)));
assert.ok(vehicles.some((feature) => feature.properties.iconId === `mapmotion-route-custom-${assetId}`));
const runtimeImages = new Map();
let decodeCount = 0;
const fakeMap = {
  hasImage: (id) => runtimeImages.has(id),
  loadImage: async (url) => {
    decodeCount += 1;
    assert.equal(url, 'data:image/png;base64,AA==');
    return { data: { width: 64, height: 32 } };
  },
  addImage: (id, data, options) => runtimeImages.set(id, { data, options }),
};
await core.loadOnlineProjectOverlayAssets(fakeMap, [layer], { [assetId]: 'data:image/png;base64,AA==' });
await core.loadOnlineProjectOverlayAssets(fakeMap, [layer], { [assetId]: 'data:image/png;base64,AA==' });
assert.equal(decodeCount, 1, 'custom vehicle must decode/register only once per MapLibre style');
assert.ok(runtimeImages.has(`mapmotion-route-custom-${assetId}`));

const noDirection = structuredClone(layer);
noDirection.routeRenderState[0].vehicleFollowDirection = false;
const fixedBearing = core
  .onlineRouteFeatureCollection([noDirection], null, { [assetId]: 'data:image/png;base64,AA==' })
  .features.filter(
    (feature) => feature.properties.segmentId === first && feature.properties.role === 'vehicle',
  );
assert.ok(fixedBearing.every((feature) => feature.properties.bearing === 15));

const project = core.createProject('Repeated vehicles');
project.layers = [layer];
project.assets = [
  {
    id: assetId,
    kind: 'image',
    filename: 'vehicle.webp',
    mediaType: 'image/webp',
    sha256: 'a'.repeat(64),
    size: 100,
    width: 64,
    height: 32,
    packagePath: `assets/${'a'.repeat(64)}.webp`,
  },
];
project.views = [
  {
    id: 'view-1',
    name: 'Vehicles',
    holdDuration: 10,
    camera: { x: 0, y: 0, zoom: 1 },
    mapMode: 'flat',
    layerConfigs: { [layer.id]: { included: true, animation } },
    thumbnailColor: '#000000',
  },
];
const reopened = core.parseProjectFile(core.serializeCanonicalProject(project).json);
assert.equal(
  reopened.views[0].layerConfigs[layer.id].animation.routeSegmentAnimations[first].vehicleAssetId,
  assetId,
);
assert.ok(core.findReferencedAssets(reopened).has(assetId));

const started = performance.now();
let maximumInstances = 0;
for (let frame = 0; frame < 600; frame += 1) {
  const state = core.evaluateRouteRenderState(layer, animation, frame / 60);
  maximumInstances = Math.max(maximumInstances, ...state.map((section) => section.vehicleInstances.length));
}
const elapsed = performance.now() - started;
assert.equal(maximumInstances, 4);
assert.ok(elapsed < 1000, `600-frame multi-instance evaluation took ${elapsed.toFixed(1)}ms`);

const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
for (const token of ['Custom Vehicle Image', 'Repetitive Movement', 'Interval Time', 'Follow Path Direction'])
  assert.ok(app.includes(token), `missing vehicle UI token: ${token}`);

console.log(
  `Online Route Vehicles: complete library, custom WebP persistence, exact interval launches, simultaneous instances, seek determinism, direction controls, Section suppression, and output features passed; 600 frames in ${elapsed.toFixed(1)}ms.`,
);
