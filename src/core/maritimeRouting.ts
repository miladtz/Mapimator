import type { RoutePoint } from './project';
import { haversineDistanceMeters, pathDistanceMeters } from './routes';

export interface MaritimeRouteResult {
  geometry: [number, number][];
  distanceMeters: number;
  routedStart: [number, number];
  routedEnd: [number, number];
  initializationMs: number;
  routingMs: number;
  /** High-resolution refinement stats */
  refinement?: {
    crossingsFound: number;
    correctedSegments: number;
    maxSegmentLengthMeters: number;
    diagnostic?: Record<string, number>;
  };
}

type WorkerResponse = {
  id: number;
  geometry?: [number, number][];
  userStart?: [number, number];
  userEnd?: [number, number];
  error?: string;
  initializationMs?: number;
  routingMs?: number;
};

type RefinementResponse = {
  id: number;
  geometry?: [number, number][];
  crossingsFound?: number;
  correctedSegments?: number;
  maxSegmentLengthMeters?: number;
  error?: string;
  diagnostic?: Record<string, number>;
};

let macroWorker: Worker | undefined;
let refinementWorker: Worker | undefined;
let requestId = 0;
let refinementRequestId = 0;
const pending = new Map<
  number,
  { resolve: (value: MaritimeRouteResult) => void; reject: (error: Error) => void }
>();
const pendingRefinement = new Map<
  number,
  { resolve: (value: RefinementResponse) => void; reject: (error: Error) => void }
>();

/** Normalize raw maritime errors into user-friendly messages. */
const normalizeError = (raw: string): string => {
  if (raw.includes('HTML instead of binary')) return 'Maritime routing data could not be loaded.';
  if (raw.includes('not valid gzip')) return 'Maritime routing data is corrupt.';
  if (raw.includes('not found') || raw.includes('HTTP')) return 'Maritime routing data could not be loaded.';
  if (raw.includes('too far from navigable water')) return raw;
  if (raw.includes('No navigable maritime route'))
    return 'Could not calculate a maritime path between these points.';
  if (raw.includes('Aborted')) return raw;
  return 'Maritime routing failed. Try different coastal locations.';
};

const normalizeRefinementError = (raw: string) => {
  if (raw.includes('Aborted')) return raw;
  if (raw.includes('HTTP 429') || /HTTP 5\d\d/.test(raw))
    return 'Maritime coastline data is temporarily unavailable.';
  if (raw.includes('network failure') || raw.includes('TileJSON'))
    return 'Detailed coastline data could not be loaded.';
  if (raw.includes('tile budget exceeded'))
    return 'This route requires too much coastal detail to calculate safely.';
  return `Maritime coastal refinement failed: ${raw}`;
};

const getMacroWorker = () => {
  if (macroWorker) return macroWorker;
  macroWorker = new Worker(new URL('../workers/maritimeRouting.worker.ts', import.meta.url), {
    type: 'module',
  });
  macroWorker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error || !data.geometry?.length) {
      request.reject(new Error(data.error || 'No navigable maritime route was found.'));
      return;
    }
    const geometry = data.geometry;
    const userStart = data.userStart;
    const userEnd = data.userEnd;
    const snappedStart = geometry[0];
    const snappedEnd = geometry.at(-1)!;
    const maxSnapMeters = 100_000;

    if (userStart && userEnd) {
      const startSnapMeters = haversineDistanceMeters(userStart, snappedStart);
      const endSnapMeters = haversineDistanceMeters(userEnd, snappedEnd);
      if (startSnapMeters > maxSnapMeters || endSnapMeters > maxSnapMeters) {
        request.reject(
          new Error('Selected location is too far from navigable water. Pick a coastal/port location.'),
        );
        return;
      }
    }

    request.resolve({
      geometry,
      distanceMeters: pathDistanceMeters(geometry),
      routedStart: snappedStart,
      routedEnd: snappedEnd,
      initializationMs: data.initializationMs ?? 0,
      routingMs: data.routingMs ?? 0,
    });
  };
  macroWorker.onerror = () => {
    for (const [id, request] of pending) {
      request.reject(new Error('Maritime routing worker crashed.'));
      pending.delete(id);
    }
  };
  return macroWorker;
};

const getRefinementWorker = () => {
  if (refinementWorker) return refinementWorker;
  refinementWorker = new Worker(new URL('../workers/maritimeScalableRouting.worker.ts', import.meta.url), {
    type: 'module',
  });
  refinementWorker.onmessage = ({ data }: MessageEvent<RefinementResponse>) => {
    const request = pendingRefinement.get(data.id);
    if (!request) return;
    pendingRefinement.delete(data.id);
    if (data.error) {
      request.reject(new Error(data.error));
      return;
    }
    request.resolve(data);
  };
  refinementWorker.onerror = () => {
    for (const [id, request] of pendingRefinement) {
      request.reject(new Error('Maritime refinement worker crashed.'));
      pendingRefinement.delete(id);
    }
  };
  return refinementWorker;
};

const requestRefinement = (geometry: [number, number][], signal?: AbortSignal): Promise<RefinementResponse> =>
  new Promise((resolve, reject) => {
    const id = ++refinementRequestId;
    const cancel = () => {
      pendingRefinement.delete(id);
      refinementWorker?.postMessage({ id, cancel: true });
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) return cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    pendingRefinement.set(id, {
      resolve: (value) => {
        signal?.removeEventListener('abort', cancel);
        resolve(value);
      },
      reject: (error) => {
        signal?.removeEventListener('abort', cancel);
        reject(error);
      },
    });
    getRefinementWorker().postMessage({ id, geometry });
  });

export const planMaritimeRoute = (start: RoutePoint, end: RoutePoint, signal?: AbortSignal) =>
  new Promise<MaritimeRouteResult>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const id = ++requestId;
    const cancel = () => {
      pending.delete(id);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    pending.set(id, {
      resolve: (macroResult) => {
        signal?.removeEventListener('abort', cancel);
        resolve(macroResult);
      },
      reject: (error) => {
        signal?.removeEventListener('abort', cancel);
        reject(new Error(normalizeError(error.message)));
      },
    });
    getMacroWorker().postMessage({
      id,
      start: [start.longitude, start.latitude],
      end: [end.longitude, end.latitude],
    });
  });
