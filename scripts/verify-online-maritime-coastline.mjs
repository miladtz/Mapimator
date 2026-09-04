import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { VectorTile } from '@mapbox/vector-tile';
import { findOceanPath } from '@arcnautical/maritime-routing/pathfinding';
import Pbf from 'pbf';
import {
  haversineMeters,
  densifyMaritimeGeometry,
  findNearestWaterCoordinate,
  geometryIsWaterSafe,
  pointInPolygon,
  pointInRing,
  routeAroundLand,
  segmentIsWaterSafe,
  smoothWaterSafe,
} from '../src/core/maritimeGeometry.ts';

const source = [56.2224, 27.1541];
const destination = [55.2803, 25.2659];
const knownIslandHole = [[56.11112594604492,26.81158510925563],[56.11138343811035,26.811182940540803],[56.111319065093994,26.811010582083455],[56.11136198043823,26.81058926030674],[56.11170530319214,26.810550958249394],[56.112048625946045,26.810761619404616],[56.11219882965088,26.811221242384633],[56.112048625946045,26.811738316009823],[56.11196279525757,26.81185322093961],[56.11123323440552,26.811814919309285],[56.11112594604492,26.81158510925563]];
const knownCrossingSegment = [[56.125,26.825000000000003],[56.07500000000002,26.775000000000006]];
const zoom = 12;
const extent = 2 ** zoom;
const tiles = new Map();
const tileJson = await fetch('https://tiles.openfreemap.org/planet').then((response) => {
  assert.equal(response.ok, true, `TileJSON HTTP ${response.status}`);
  return response.json();
});
const tileTemplate = tileJson.tiles?.[0];
assert.ok(tileTemplate, 'OpenFreeMap TileJSON must expose its current vector tiles');

const tileAt = ([longitude, latitude]) => ({
  x: Math.floor(((longitude + 180) / 360) * extent),
  y: Math.floor(
    ((1 - Math.log(Math.tan((latitude * Math.PI) / 180) + 1 / Math.cos((latitude * Math.PI) / 180)) / Math.PI) / 2) * extent,
  ),
});
const tileKey = ({ x, y }) => `${zoom}/${x}/${y}`;
const loadTile = async ({ x, y }) => {
  const id = tileKey({ x, y });
  if (tiles.has(id)) return;
  const url = tileTemplate.replace('{z}', zoom).replace('{x}', x).replace('{y}', y);
  const response = await fetch(url);
  assert.equal(response.ok, true, `${id} HTTP ${response.status}`);
  const vector = new VectorTile(new Pbf(new Uint8Array(await response.arrayBuffer())));
  const layer = vector.layers.water;
  const water = [];
  for (let index = 0; layer && index < layer.length; index += 1) {
    const feature = layer.feature(index);
    if (feature.type !== 3) continue;
    const geometry = feature.toGeoJSON(x, y, zoom).geometry;
    if (geometry.type === 'Polygon') water.push(geometry.coordinates);
    if (geometry.type === 'MultiPolygon') water.push(...geometry.coordinates);
  }
  tiles.set(id, water);
};
const preload = async (geometry) => {
  const needed = new Map();
  for (let index = 0; index < geometry.length - 1; index += 1) {
    const start = geometry[index];
    const end = geometry[index + 1];
    const count = Math.max(1, Math.ceil(haversineMeters(start, end) / 3_000));
    for (let step = 0; step <= count; step += 1) {
      const amount = step / count;
      const center = tileAt([start[0] + (end[0] - start[0]) * amount, start[1] + (end[1] - start[1]) * amount]);
      for (let dx = -2; dx <= 2; dx += 1) for (let dy = -2; dy <= 2; dy += 1) {
        const tile = { x: center.x + dx, y: center.y + dy };
        needed.set(tileKey(tile), tile);
      }
    }
  }
  for (const tile of needed.values()) await loadTile(tile);
  return needed.size;
};
const isWater = (point) => tiles.get(tileKey(tileAt(point)))?.some((polygon) => pointInPolygon(point, polygon)) ?? false;
const hash = (geometry) => createHash('sha256').update(JSON.stringify(geometry)).digest('hex');
const firstLandSample = (start, end) => {
  const count = Math.max(2, Math.ceil(haversineMeters(start, end) / 120));
  for (let step = 1; step < count; step += 1) {
    const amount = step / count;
    const point = [start[0] + (end[0] - start[0]) * amount, start[1] + (end[1] - start[1]) * amount];
    if (isWater(point)) continue;
    const id = tileKey(tileAt(point));
    const polygon = tiles.get(id)?.find((candidate) => pointInRing(point, candidate[0]));
    const hole = polygon?.slice(1).find((candidate) => pointInRing(point, candidate));
    return { point, tile: id, classification: hole ? 'island-hole' : 'outside-water', hole };
  }
};

const macro = findOceanPath(source[1], source[0], destination[1], destination[0]);
const knownCrossingSamples = Array.from({ length: 101 }, (_, index) => [
  knownCrossingSegment[0][0] + (knownCrossingSegment[1][0] - knownCrossingSegment[0][0]) * index / 100,
  knownCrossingSegment[0][1] + (knownCrossingSegment[1][1] - knownCrossingSegment[0][1]) * index / 100,
]);
assert.ok(knownCrossingSamples.some((point) => pointInRing(point, knownIslandHole)), 'Hard fixture macro chord must intersect the captured visible island polygon');
const tileCount = await preload(macro);
const navigableMacro = macro.map((point, index) => index === 0 || index === macro.length - 1 ? point : findNearestWaterCoordinate(point, isWater));
const crossings = [];
const final = [navigableMacro[0]];
for (let index = 0; index < navigableMacro.length - 1; index += 1) {
  const start = navigableMacro[index];
  const end = navigableMacro[index + 1];
  if (!segmentIsWaterSafe(start, end, isWater)) crossings.push({ index, start, end, collision: firstLandSample(start, end) });
  const section = segmentIsWaterSafe(start, end, isWater) ? [start, end] : routeAroundLand(start, end, isWater);
  final.push(...section.slice(1));
}
assert.ok(crossings.length > 0, 'The fixed human route must reproduce a visible OpenFreeMap land crossing');
assert.ok(final.length > macro.length, 'Detailed obstacle avoidance must materially change the macro route');
const rendered = densifyMaritimeGeometry(smoothWaterSafe(final, isWater, 2, 1_500), 800);
assert.ok(geometryIsWaterSafe(rendered, isWater), 'Smoothed rendered route must remain entirely in displayed water');
assert.deepEqual(final[0], source, 'Source must remain exact');
assert.deepEqual(final.at(-1), destination, 'Destination must remain exact');
const repeated = [navigableMacro[0]];
for (let index = 0; index < navigableMacro.length - 1; index += 1) {
  const section = segmentIsWaterSafe(navigableMacro[index], navigableMacro[index + 1], isWater)
    ? [navigableMacro[index], navigableMacro[index + 1]]
    : routeAroundLand(navigableMacro[index], navigableMacro[index + 1], isWater);
  repeated.push(...section.slice(1));
}
assert.deepEqual(repeated, final, 'Detailed correction must be deterministic');
const repeatedRendered = densifyMaritimeGeometry(smoothWaterSafe(repeated, isWater, 2, 1_500), 800);
assert.deepEqual(repeatedRendered, rendered, 'Final smoothed geometry must be byte-deterministic');

console.log(JSON.stringify({
  route: { source, destination },
  visibleSource: { tileJson: 'https://tiles.openfreemap.org/planet', sourceLayer: 'water', zoom, polygonTopology: 'outer rings with island holes' },
  macro: { count: macro.length, hash: hash(macro) },
  crossing: crossings[0],
  islandCrossing: crossings.find((crossing) => crossing.collision?.classification === 'island-hole'),
  crossingsFound: crossings.length,
  final: { count: rendered.length, hash: hash(rendered), maxSegmentMeters: Math.max(...rendered.slice(0, -1).map((point, index) => haversineMeters(point, rendered[index + 1]))) },
  tileCount,
}, null, 2));
