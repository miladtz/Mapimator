import { findOceanPath, loadGridFromBuffer } from '@arcnautical/maritime-routing/pathfinding';

// Browser-compatible Buffer shim for the maritime package
const WorkerBuffer = Object.assign(Uint8Array, {
  from: (value: ArrayBuffer | Uint8Array) => (value instanceof Uint8Array ? value : new Uint8Array(value)),
});
Object.assign(globalThis, { Buffer: WorkerBuffer });

type MaritimeRequest = {
  id: number;
  start: [number, number];
  end: [number, number];
};

type GridState = 'uninitialized' | 'loading' | 'ready' | 'failed';

let gridState: GridState = 'uninitialized';
let gridError: string | undefined;
let gridReady: Promise<void> | undefined;

// Use .bin extension (NOT .gz) to prevent HTTP servers from transparently
// decompressing the response. The package's loadGridFromBuffer() expects
// gzipped bytes and calls gunzipSync() internally.
const GRID_URL = '/assets/ocean-grid.bin';
const GZIP_MAGIC = 0x1f8b;

const ensureGrid = (): Promise<void> => {
  if (gridState === 'ready') return Promise.resolve();
  if (gridState === 'failed') return Promise.reject(new Error(gridError ?? 'Maritime grid failed to load.'));
  if (gridReady) return gridReady;

  gridState = 'loading';
  gridReady = fetch(GRID_URL)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Maritime grid asset not found (HTTP ${response.status}).`);
      }
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // Validate gzip magic bytes (1F 8B)
      if (bytes.length < 2 || ((bytes[0] << 8) | bytes[1]) !== GZIP_MAGIC) {
        const text = new TextDecoder().decode(bytes.slice(0, 64));
        if (text.includes('<!') || text.includes('<html')) {
          throw new Error('Maritime grid asset returned HTML instead of binary data.');
        }
        throw new Error(`Maritime grid data is not valid gzip (received ${bytes.length} bytes).`);
      }

      loadGridFromBuffer(bytes);
      gridState = 'ready';
    })
    .catch((error) => {
      gridState = 'failed';
      gridError = error instanceof Error ? error.message : String(error);
      gridReady = undefined;
      throw error;
    });

  return gridReady;
};

self.onmessage = async ({ data }: MessageEvent<MaritimeRequest>) => {
  try {
    const started = performance.now();
    await ensureGrid();
    const initialized = performance.now();
    // findOceanPath(fromLat, fromLon, toLat, toLon) → [lon, lat][]
    // The package snaps to nearest water cell, runs A*, validates, densifies.
    const geometry = findOceanPath(data.start[1], data.start[0], data.end[1], data.end[0]);
    self.postMessage({
      id: data.id,
      geometry,
      // Pass back user coordinates so caller can compute snap distance
      userStart: data.start,
      userEnd: data.end,
      initializationMs: initialized - started,
      routingMs: performance.now() - initialized,
    });
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
