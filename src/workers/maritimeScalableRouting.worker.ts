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
import { selectMaritimeRefinementWindows } from '../core/maritimePrepass';

type RouteRequest = { id: number; geometry: Coordinate[] };
type CancelRequest = { id: number; cancel: true };
type Tile = { water: PolygonRings[]; bytes: number; polygons: number };
type TileCoordinate = { x: number; y: number };

const concurrency = 6;
const retryCount = 2;
const maxTilesPerRoute = 800;
const maxCachedTiles = 512;
let tileTemplate: string | undefined;
const tiles = new Map<string, Tile>();
const requestControllers = new Map<number, AbortController>();

const delay = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
const getTemplate = async (signal: AbortSignal) => {
  if (tileTemplate) return tileTemplate;
  const response = await fetch('https://tiles.openfreemap.org/planet', { signal });
  if (!response.ok) throw new Error(`OpenFreeMap TileJSON HTTP ${response.status}.`);
  const json = (await response.json()) as { tiles?: string[] };
  if (!json.tiles?.[0]) throw new Error('OpenFreeMap TileJSON has no vector tile template.');
  tileTemplate = json.tiles[0];
  return tileTemplate;
};
const tileAt = ([longitude, latitude]: Coordinate, zoom: number): TileCoordinate => {
  const extent = 2 ** zoom;
  const wrappedLongitude = (((longitude + 180) % 360) + 360) % 360;
  const safeLatitude = Math.max(-85.0511, Math.min(85.0511, latitude));
  return {
    x: Math.floor((wrappedLongitude / 360) * extent),
    y: Math.floor(
      ((1 -
        Math.log(Math.tan((safeLatitude * Math.PI) / 180) + 1 / Math.cos((safeLatitude * Math.PI) / 180)) /
          Math.PI) /
        2) *
        extent,
    ),
  };
};
const normalizedTile = ({ x, y }: TileCoordinate, zoom: number): TileCoordinate => {
  const extent = 2 ** zoom;
  return { x: ((x % extent) + extent) % extent, y: Math.max(0, Math.min(extent - 1, y)) };
};
const key = ({ x, y }: TileCoordinate, zoom: number) => `${zoom}/${x}/${y}`;
const touchCache = (id: string, tile: Tile) => {
  tiles.delete(id);
  tiles.set(id, tile);
  while (tiles.size > maxCachedTiles) tiles.delete(tiles.keys().next().value!);
};

class TileFetchError extends Error {
  constructor(
    public url: string,
    public tile: string,
    public status?: number,
    public causeText?: string,
  ) {
    super(
      status
        ? `Coastline tile ${tile} HTTP ${status}: ${url}`
        : `Coastline tile ${tile} network failure (${causeText ?? 'unknown'}): ${url}`,
    );
  }
}

const fetchTile = async (
  coordinate: TileCoordinate,
  zoom: number,
  signal: AbortSignal,
  diagnostic: Diagnostic,
) => {
  const normalized = normalizedTile(coordinate, zoom);
  const id = key(normalized, zoom);
  const cached = tiles.get(id);
  if (cached) {
    diagnostic.cachedTileCount += 1;
    touchCache(id, cached);
    return;
  }
  const url = (await getTemplate(signal))
    .replace('{z}', String(zoom))
    .replace('{x}', String(normalized.x))
    .replace('{y}', String(normalized.y));
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === retryCount) throw new TileFetchError(url, id, response.status);
        diagnostic.retries += 1;
        await delay(200 * 2 ** attempt, signal);
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const vector = new VectorTile(new Pbf(bytes));
      const layer = vector.layers.water;
      const water: PolygonRings[] = [];
      for (let index = 0; layer && index < layer.length; index += 1) {
        const feature = layer.feature(index);
        if (feature.type !== 3) continue;
        const geometry = feature.toGeoJSON(normalized.x, normalized.y, zoom).geometry;
        if (geometry.type === 'Polygon') water.push(geometry.coordinates as PolygonRings);
        if (geometry.type === 'MultiPolygon') water.push(...(geometry.coordinates as PolygonRings[]));
      }
      const tile = { water, bytes: bytes.byteLength, polygons: water.length };
      touchCache(id, tile);
      diagnostic.downloadedTileCount += 1;
      diagnostic.downloadedBytes += bytes.byteLength;
      diagnostic.parsedPolygonCount += water.length;
      return;
    } catch (error) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (error instanceof TileFetchError) throw error;
      lastError = error;
      if (attempt === retryCount)
        throw new TileFetchError(url, id, undefined, error instanceof Error ? error.message : String(error));
      diagnostic.retries += 1;
      await delay(200 * 2 ** attempt, signal);
    }
  }
  throw lastError;
};

type Diagnostic = {
  requestedTileCount: number;
  uniqueTileCount: number;
  cachedTileCount: number;
  downloadedTileCount: number;
  failedTileCount: number;
  downloadedBytes: number;
  parsedPolygonCount: number;
  retries: number;
  maxConcurrentFetches: number;
  refinementWindows: number;
  prepassMs: number;
  fetchMs: number;
  correctionMs: number;
};
const runQueue = async (
  coordinates: TileCoordinate[],
  zoom: number,
  signal: AbortSignal,
  diagnostic: Diagnostic,
) => {
  let cursor = 0;
  let active = 0;
  const runner = async () => {
    while (cursor < coordinates.length) {
      const coordinate = coordinates[cursor++];
      active += 1;
      diagnostic.maxConcurrentFetches = Math.max(diagnostic.maxConcurrentFetches, active);
      try {
        await fetchTile(coordinate, zoom, signal, diagnostic);
      } catch (error) {
        diagnostic.failedTileCount += 1;
        throw error;
      } finally {
        active -= 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, coordinates.length) }, runner));
};
const windowTiles = (geometry: Coordinate[], zoom: number, radius: number) => {
  const requested = new Map<string, TileCoordinate>();
  for (let index = 0; index < geometry.length - 1; index += 1) {
    const start = geometry[index];
    const end = geometry[index + 1];
    const samples = Math.max(1, Math.ceil(haversineMeters(start, end) / 3_000));
    let longitudeDelta = end[0] - start[0];
    if (longitudeDelta > 180) longitudeDelta -= 360;
    if (longitudeDelta < -180) longitudeDelta += 360;
    for (let sample = 0; sample <= samples; sample += 1) {
      const amount = sample / samples;
      const center = tileAt(
        [start[0] + longitudeDelta * amount, start[1] + (end[1] - start[1]) * amount],
        zoom,
      );
      for (let dx = -radius; dx <= radius; dx += 1)
        for (let dy = -radius; dy <= radius; dy += 1) {
          const coordinate = normalizedTile({ x: center.x + dx, y: center.y + dy }, zoom);
          requested.set(key(coordinate, zoom), coordinate);
        }
    }
  }
  return requested;
};
const waterClassifier = (zoom: number) => (point: Coordinate) => {
  const tile = tiles.get(key(tileAt(point, zoom), zoom));
  if (!tile) throw new Error('Required detailed coastline tile was not loaded.');
  return tile.water.some((polygon) => pointInPolygon(point, polygon));
};
const refineWindow = (geometry: Coordinate[], zoom: number, preserveStart: boolean, preserveEnd: boolean) => {
  const isWater = waterClassifier(zoom);
  let coreStart = 0;
  let coreEnd = geometry.length - 1;
  if (preserveStart) {
    coreStart = geometry.findIndex((point, index) => index > 0 && isWater(point));
    if (coreStart < 0 || haversineMeters(geometry[0], geometry[coreStart]) > 100_000)
      throw new Error('Selected maritime source is more than 100 km from confirmed open water.');
  }
  if (preserveEnd) {
    coreEnd = -1;
    for (let index = geometry.length - 2; index >= coreStart; index -= 1)
      if (isWater(geometry[index])) {
        coreEnd = index;
        break;
      }
    if (coreEnd < coreStart || haversineMeters(geometry[coreEnd], geometry.at(-1)!) > 100_000)
      throw new Error('Selected maritime destination is more than 100 km from confirmed open water.');
  }
  const core = geometry.slice(coreStart, coreEnd + 1);
  const navigable = core.map((point) => findNearestWaterCoordinate(point, isWater));
  let crossingsFound = 0;
  let correctedSegments = 0;
  const corrected: Coordinate[] = [navigable[0]];
  for (let index = 0; index < navigable.length - 1; index += 1) {
    const start = navigable[index];
    const end = navigable[index + 1];
    const safe = segmentIsWaterSafe(start, end, isWater);
    if (!safe) crossingsFound += 1;
    let section: Coordinate[];
    try {
      section = safe
        ? [start, end]
        : routeAroundLand(start, end, isWater, zoom <= 10 ? 0.005 : 0.0015, zoom <= 10 ? 0.8 : 0.12);
    } catch (error) {
      throw new Error(
        `Local coastal correction failed for ${JSON.stringify(start)} → ${JSON.stringify(end)} at z${zoom}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (section.length > 2) correctedSegments += 1;
    corrected.push(...section.slice(1));
  }
  const refinedCore = smoothWaterSafe(corrected, isWater);
  if (!geometryIsWaterSafe(refinedCore, isWater, 0)) {
    const unsafePoint = refinedCore.slice(1, -1).findIndex((point) => !isWater(point));
    const unsafeSegment = refinedCore
      .slice(0, -1)
      .findIndex((point, index) => !segmentIsWaterSafe(point, refinedCore[index + 1], isWater));
    throw new Error(
      `Detailed coastline validation failed after correction at point ${unsafePoint < 0 ? 'none' : unsafePoint + 1}, segment ${unsafeSegment} ${unsafeSegment < 0 ? '' : JSON.stringify([refinedCore[unsafeSegment], refinedCore[unsafeSegment + 1]])}.`,
    );
  }
  const refined = [
    ...(preserveStart ? [geometry[0]] : []),
    ...refinedCore,
    ...(preserveEnd ? [geometry.at(-1)!] : []),
  ].filter(
    (point, index, points) =>
      index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1],
  );
  return { geometry: refined, crossingsFound, correctedSegments };
};

self.onmessage = async ({ data }: MessageEvent<RouteRequest | CancelRequest>) => {
  if ('cancel' in data) {
    requestControllers.get(data.id)?.abort();
    return;
  }
  const controller = new AbortController();
  requestControllers.set(data.id, controller);
  const diagnostic: Diagnostic = {
    requestedTileCount: 0,
    uniqueTileCount: 0,
    cachedTileCount: 0,
    downloadedTileCount: 0,
    failedTileCount: 0,
    downloadedBytes: 0,
    parsedPolygonCount: 0,
    retries: 0,
    maxConcurrentFetches: 0,
    refinementWindows: 0,
    prepassMs: 0,
    fetchMs: 0,
    correctionMs: 0,
  };
  try {
    const prepassStarted = performance.now();
    const windows = selectMaritimeRefinementWindows(data.geometry);
    diagnostic.prepassMs = performance.now() - prepassStarted;
    diagnostic.refinementWindows = windows.length;
    const detailZoom = data.geometry.length > 1_500 ? 9 : data.geometry.length > 200 ? 10 : 12;
    const tileRadius = detailZoom === 12 ? 2 : 1;
    const allKeys = new Set<string>();
    const output: Coordinate[] = [data.geometry[0]];
    let macroCursor = 0;
    let crossingsFound = 0;
    let correctedSegments = 0;
    for (const window of windows) {
      while (macroCursor < window.startSegment) output.push(data.geometry[++macroCursor]);
      const requested = windowTiles(window.geometry, detailZoom, tileRadius);
      diagnostic.requestedTileCount += requested.size;
      for (const id of requested.keys()) allKeys.add(id);
      diagnostic.uniqueTileCount = allKeys.size;
      if (allKeys.size > maxTilesPerRoute)
        throw new Error(`Coastal refinement tile budget exceeded (${allKeys.size}/${maxTilesPerRoute}).`);
      const fetchStarted = performance.now();
      await runQueue([...requested.values()], detailZoom, controller.signal, diagnostic);
      diagnostic.fetchMs += performance.now() - fetchStarted;
      const correctionStarted = performance.now();
      const refined = refineWindow(
        window.geometry,
        detailZoom,
        window.startSegment === 0,
        window.endSegment === data.geometry.length - 2,
      );
      diagnostic.correctionMs += performance.now() - correctionStarted;
      crossingsFound += refined.crossingsFound;
      correctedSegments += refined.correctedSegments;
      output.push(...refined.geometry.slice(1));
      macroCursor = window.endSegment + 1;
    }
    while (macroCursor < data.geometry.length - 1) output.push(data.geometry[++macroCursor]);
    const geometry = densifyMaritimeGeometry(output, 800);
    if (!geometry.every(([longitude, latitude]) => Number.isFinite(longitude) && Number.isFinite(latitude)))
      throw new Error('Maritime route contains invalid coordinates.');
    self.postMessage({
      id: data.id,
      geometry,
      crossingsFound,
      correctedSegments,
      maxSegmentLengthMeters: Math.max(
        ...geometry.slice(0, -1).map((point, index) => haversineMeters(point, geometry[index + 1])),
      ),
      diagnostic,
    });
  } catch (error) {
    console.error('[maritime-refinement]', error);
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    requestControllers.delete(data.id);
  }
};
