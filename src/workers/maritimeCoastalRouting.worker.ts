import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import {
  densifyMaritimeGeometry,
  findNearestWaterCoordinate,
  geometryIsWaterSafe,
  haversineMeters,
  pointInPolygon,
  routeAroundLand,
  segmentIsWaterSafe,
  smoothWaterSafe,
  type Coordinate,
  type PolygonRings,
} from '../core/maritimeGeometry';

type Request = { id: number; geometry: Coordinate[] };
type Tile = { water: PolygonRings[] };
let tileTemplate: string | undefined;
const tiles = new Map<string, Tile>();
const zoom = 12;
const extent = 2 ** zoom;

const template = async () => {
  if (tileTemplate) return tileTemplate;
  const response = await fetch('https://tiles.openfreemap.org/planet');
  if (!response.ok) throw new Error(`OpenFreeMap TileJSON failed (${response.status}).`);
  const json = (await response.json()) as { tiles?: string[] };
  if (!json.tiles?.[0]) throw new Error('OpenFreeMap TileJSON has no vector tile template.');
  return (tileTemplate = json.tiles[0]);
};
const tileAt = ([longitude, latitude]: Coordinate) => {
  const x = Math.floor(((longitude + 180) / 360) * extent);
  const safeLatitude = Math.max(-85.0511, Math.min(85.0511, latitude));
  const y = Math.floor(
    ((1 -
      Math.log(Math.tan((safeLatitude * Math.PI) / 180) + 1 / Math.cos((safeLatitude * Math.PI) / 180)) /
        Math.PI) /
      2) *
      extent,
  );
  return { x, y };
};
const key = (x: number, y: number) => `${zoom}/${x}/${y}`;
const loadTile = async (x: number, y: number) => {
  const id = key(x, y);
  if (tiles.has(id)) return;
  const url = (await template())
    .replace('{z}', String(zoom))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`OpenFreeMap coastline tile failed (${response.status}).`);
  const vector = new VectorTile(new Pbf(new Uint8Array(await response.arrayBuffer())));
  const layer = vector.layers.water;
  const water: PolygonRings[] = [];
  if (layer)
    for (let index = 0; index < layer.length; index += 1) {
      const feature = layer.feature(index);
      if (feature.type !== 3) continue;
      const geometry = feature.toGeoJSON(x, y, zoom).geometry;
      if (geometry.type === 'Polygon') water.push(geometry.coordinates as PolygonRings);
      if (geometry.type === 'MultiPolygon') water.push(...(geometry.coordinates as PolygonRings[]));
    }
  tiles.set(id, { water });
};
const preloadCorridor = async (geometry: Coordinate[]) => {
  const requested = new Set<string>();
  for (let index = 0; index < geometry.length - 1; index += 1) {
    const start = geometry[index],
      end = geometry[index + 1];
    const samples = Math.max(1, Math.ceil(haversineMeters(start, end) / 3_000));
    for (let sample = 0; sample <= samples; sample += 1) {
      const amount = sample / samples;
      const point: Coordinate = [
        start[0] + (end[0] - start[0]) * amount,
        start[1] + (end[1] - start[1]) * amount,
      ];
      const center = tileAt(point);
      for (let dx = -2; dx <= 2; dx += 1)
        for (let dy = -2; dy <= 2; dy += 1) requested.add(key(center.x + dx, center.y + dy));
    }
  }
  await Promise.all(
    [...requested].map((id) => {
      const [, x, y] = id.split('/').map(Number);
      return loadTile(x, y);
    }),
  );
  return requested.size;
};
const isWater = (point: Coordinate) => {
  const { x, y } = tileAt(point);
  const tile = tiles.get(key(x, y));
  if (!tile) throw new Error('Detailed coastline tile was not preloaded.');
  return tile.water.some((polygon) => pointInPolygon(point, polygon));
};

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  try {
    const tileCount = await preloadCorridor(data.geometry);
    const macro = data.geometry.map((point, index) =>
      index === 0 || index === data.geometry.length - 1 ? point : findNearestWaterCoordinate(point, isWater),
    );
    let crossingsFound = 0,
      correctedSegments = 0;
    const corrected: Coordinate[] = [macro[0]];
    for (let index = 0; index < macro.length - 1; index += 1) {
      const start = macro[index],
        end = macro[index + 1];
      const safe = segmentIsWaterSafe(start, end, isWater);
      if (!safe) crossingsFound += 1;
      const section = safe ? [start, end] : routeAroundLand(start, end, isWater);
      if (section.length > 2) correctedSegments += 1;
      corrected.push(...section.slice(1));
    }
    const geometry = densifyMaritimeGeometry(smoothWaterSafe(corrected, isWater), 800);
    if (!geometryIsWaterSafe(geometry, isWater))
      throw new Error('Detailed coastline validation failed after smoothing.');
    const maxSegmentLengthMeters = Math.max(
      ...geometry.slice(0, -1).map((point, index) => haversineMeters(point, geometry[index + 1])),
    );
    self.postMessage({
      id: data.id,
      geometry,
      crossingsFound,
      correctedSegments,
      maxSegmentLengthMeters,
      diagnostic: {
        tileCount,
        polygonTopology: 'outer-rings-with-island-holes',
        algorithm: 'bounded-a-star',
      },
    });
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
