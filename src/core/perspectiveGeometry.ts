import {
  CAMERA_FOCAL_LENGTH,
  CAMERA_VIEWPORT,
  MAX_CAMERA_PITCH,
  MIN_CAMERA_PITCH,
  clamp,
  createWorldToScreenProjector,
  normalizeBearing,
} from './camera';
import type { CameraState } from './project';

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
interface ParsedSubpath {
  coordinates: Float64Array;
  bounds: Bounds;
  closed: boolean;
}
interface ParsedPath {
  subpaths: ParsedSubpath[];
  vertexCount: number;
}

const parsedPaths = new Map<string, ParsedPath>();
let parseCount = 0;
let parsedVertexCount = 0;
let parsedSubpathCount = 0;
let lastProjectedVertices = 0;
let lastCulledSubpaths = 0;
let lastVisibleClosedRings = 0;
let lastHiddenClosedRings = 0;
let lastMixedClosedRings = 0;

export const FLAT_FILL_NEAR_DEPTH = CAMERA_FOCAL_LENGTH * 0.01;

interface CameraSpacePoint {
  x: number;
  y: number;
  depth: number;
}

const createFlatCameraSpace = (camera: CameraState) => {
  const bearing = (normalizeBearing(camera.bearing) * Math.PI) / 180;
  const bearingCosine = Math.cos(bearing);
  const bearingSine = Math.sin(bearing);
  const pitch = (clamp(camera.pitch ?? 0, MIN_CAMERA_PITCH, MAX_CAMERA_PITCH) * Math.PI) / 180;
  const pitchCosine = Math.cos(pitch);
  const pitchSine = Math.sin(pitch);
  const depth = (worldX: number, worldY: number) => {
    const northUpX = worldX * camera.zoom + camera.x - CAMERA_VIEWPORT.width / 2;
    const northUpY = worldY * camera.zoom + camera.y - CAMERA_VIEWPORT.height / 2;
    const rotatedY = northUpX * bearingSine + northUpY * bearingCosine;
    return CAMERA_FOCAL_LENGTH + rotatedY * pitchSine;
  };
  const toCamera = (worldX: number, worldY: number): CameraSpacePoint => {
    const northUpX = worldX * camera.zoom + camera.x - CAMERA_VIEWPORT.width / 2;
    const northUpY = worldY * camera.zoom + camera.y - CAMERA_VIEWPORT.height / 2;
    const x = northUpX * bearingCosine - northUpY * bearingSine;
    const y = northUpX * bearingSine + northUpY * bearingCosine;
    return { x, y, depth: CAMERA_FOCAL_LENGTH + y * pitchSine };
  };
  const project = (point: CameraSpacePoint) => {
    const perspective = CAMERA_FOCAL_LENGTH / point.depth;
    return {
      x: CAMERA_VIEWPORT.width / 2 + point.x * perspective,
      y: CAMERA_VIEWPORT.height / 2 + point.y * pitchCosine * perspective,
    };
  };
  return { depth, toCamera, project };
};

const nearPlaneIntersection = (from: CameraSpacePoint, to: CameraSpacePoint): CameraSpacePoint => {
  const denominator = to.depth - from.depth;
  const unclamped = denominator === 0 ? 0 : (FLAT_FILL_NEAR_DEPTH - from.depth) / denominator;
  const t = clamp(unclamped, 0, 1);
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    depth: FLAT_FILL_NEAR_DEPTH,
  };
};

const clipClosedRingToNearPlane = (
  coordinates: Float64Array,
  toCamera: (worldX: number, worldY: number) => CameraSpacePoint,
) => {
  const output: CameraSpacePoint[] = [];
  const vertexCount = coordinates.length / 2;
  if (vertexCount < 3) return output;
  let previous = toCamera(coordinates[coordinates.length - 2], coordinates[coordinates.length - 1]);
  let previousInside = previous.depth >= FLAT_FILL_NEAR_DEPTH;
  for (let index = 0; index < coordinates.length; index += 2) {
    const current = toCamera(coordinates[index], coordinates[index + 1]);
    const currentInside = current.depth >= FLAT_FILL_NEAR_DEPTH;
    if (currentInside !== previousInside) output.push(nearPlaneIntersection(previous, current));
    if (currentInside) output.push(current);
    previous = current;
    previousInside = currentInside;
  }
  return output;
};

const boundsOf = (coordinates: readonly number[]): Bounds => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < coordinates.length; index += 2) {
    const x = coordinates[index];
    const y = coordinates[index + 1];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
};

const parsePath = (path: string): ParsedPath => {
  const cached = parsedPaths.get(path);
  if (cached) return cached;
  const tokens = path.match(/[MLZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const subpaths: ParsedSubpath[] = [];
  let coordinates: number[] = [];
  let closed = false;
  const finish = () => {
    if (coordinates.length < 2) return;
    subpaths.push({ coordinates: Float64Array.from(coordinates), bounds: boundsOf(coordinates), closed });
    coordinates = [];
    closed = false;
  };
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index++];
    if (token === 'Z') {
      closed = true;
      finish();
      continue;
    }
    if (token !== 'M' && token !== 'L') continue;
    if (token === 'M') finish();
    const x = Number(tokens[index++]);
    const y = Number(tokens[index++]);
    if (Number.isFinite(x) && Number.isFinite(y)) coordinates.push(x, y);
  }
  finish();
  const vertexCount = subpaths.reduce((sum, subpath) => sum + subpath.coordinates.length / 2, 0);
  const parsed = { subpaths, vertexCount };
  parsedPaths.set(path, parsed);
  parseCount += 1;
  parsedVertexCount += vertexCount;
  parsedSubpathCount += subpaths.length;
  return parsed;
};

const rounded = (value: number) => Math.round(value * 1000) / 1000;
// Geography is clipped by the SVG viewport. A small stroke-safe margin avoids
// producing off-screen path strings without changing visible map detail.
const CULL_MARGIN = 12;

type Projector = ReturnType<typeof createWorldToScreenProjector>;

const canContributeToViewport = (project: Projector, bounds: Bounds) => {
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const samples = [
    [bounds.minX, bounds.minY],
    [centerX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.minX, centerY],
    [centerX, centerY],
    [bounds.maxX, centerY],
    [bounds.minX, bounds.maxY],
    [centerX, bounds.maxY],
    [bounds.maxX, bounds.maxY],
  ];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of samples) {
    const projected = project(x, y);
    if (!projected) continue;
    minX = Math.min(minX, projected.x);
    minY = Math.min(minY, projected.y);
    maxX = Math.max(maxX, projected.x);
    maxY = Math.max(maxY, projected.y);
  }
  if (!Number.isFinite(minX)) return false;
  return !(
    maxX < -CULL_MARGIN ||
    minX > CAMERA_VIEWPORT.width + CULL_MARGIN ||
    maxY < -CULL_MARGIN ||
    minY > CAMERA_VIEWPORT.height + CULL_MARGIN
  );
};

export const projectSvgPath = (path: string, camera: CameraState) => {
  const parsed = parsePath(path);
  const project = createWorldToScreenProjector(camera);
  const cameraSpace = (camera.pitch ?? 0) !== 0 ? createFlatCameraSpace(camera) : null;
  const output: string[] = [];
  lastProjectedVertices = 0;
  lastCulledSubpaths = 0;
  lastVisibleClosedRings = 0;
  lastHiddenClosedRings = 0;
  lastMixedClosedRings = 0;
  for (const subpath of parsed.subpaths) {
    if (subpath.closed && cameraSpace) {
      let visibleVertices = 0;
      for (let index = 0; index < subpath.coordinates.length; index += 2) {
        if (
          cameraSpace.depth(subpath.coordinates[index], subpath.coordinates[index + 1]) >=
          FLAT_FILL_NEAR_DEPTH
        )
          visibleVertices += 1;
      }
      const vertexCount = subpath.coordinates.length / 2;
      if (visibleVertices === 0) {
        lastHiddenClosedRings += 1;
        lastCulledSubpaths += 1;
        continue;
      }
      if (visibleVertices < vertexCount) {
        lastMixedClosedRings += 1;
        const clipped = clipClosedRingToNearPlane(subpath.coordinates, cameraSpace.toCamera);
        if (clipped.length < 3) {
          lastCulledSubpaths += 1;
          continue;
        }
        clipped.forEach((point, index) => {
          const projected = cameraSpace.project(point);
          output.push(`${index === 0 ? 'M' : 'L'}${rounded(projected.x)} ${rounded(projected.y)}`);
        });
        output.push('Z');
        lastProjectedVertices += clipped.length;
        continue;
      }
      lastVisibleClosedRings += 1;
    }
    if (!canContributeToViewport(project, subpath.bounds)) {
      lastCulledSubpaths += 1;
      continue;
    }
    let penVisible = false;
    for (let index = 0; index < subpath.coordinates.length; index += 2) {
      const projected = project(subpath.coordinates[index], subpath.coordinates[index + 1]);
      lastProjectedVertices += 1;
      if (!projected) {
        penVisible = false;
        continue;
      }
      output.push(`${penVisible ? 'L' : 'M'}${rounded(projected.x)} ${rounded(projected.y)}`);
      penVisible = true;
    }
    if (subpath.closed && penVisible) output.push('Z');
  }
  return output.join('');
};

export const preparseSvgPaths = (paths: readonly string[]) => {
  for (const path of paths) parsePath(path);
};

export const perspectiveGeometryCacheStats = () => ({
  pathCount: parsedPaths.size,
  subpathCount: parsedSubpathCount,
  parseCount,
  vertexCount: parsedVertexCount,
  lastProjectedVertices,
  lastCulledSubpaths,
  lastVisibleClosedRings,
  lastHiddenClosedRings,
  lastMixedClosedRings,
});
