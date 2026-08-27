import { CAMERA_VIEWPORT, createWorldToScreenProjector } from './camera';
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
  const output: string[] = [];
  lastProjectedVertices = 0;
  lastCulledSubpaths = 0;
  for (const subpath of parsed.subpaths) {
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
});
