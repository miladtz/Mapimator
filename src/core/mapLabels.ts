import { CITY_LABELS, CONTINENT_LABELS, COUNTRIES, MARINE_LABELS, type MapLabel } from '../data/worldMap';
import type { CameraState } from './project';
import {
  CAMERA_FOCAL_LENGTH,
  CAMERA_SETTINGS,
  clamp,
  createWorldToScreenProjector,
  flatCameraDepth,
} from './camera';

export interface LabelOpacity<T> {
  item: T;
  opacity: number;
  scale?: number;
  letterSpacing?: number;
}

export interface SelectedMapLabels {
  continents: LabelOpacity<MapLabel>[];
  oceans: LabelOpacity<MapLabel>[];
  countries: LabelOpacity<(typeof COUNTRIES)[number]>[];
  capitals: LabelOpacity<MapLabel>[];
  cities: LabelOpacity<MapLabel>[];
  riversOpacity: number;
  lakesOpacity: number;
}

export interface FlatLabelProjection {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  depth: number;
  basisLength: number;
  verticalBasisLength: number;
  shear: number;
  foreshortening: number;
  determinant: number;
  rawSigmaMax: number;
  rawSigmaMin: number;
  perspectiveSigmaMax: number;
  perspectiveSigmaMin: number;
  rawMatrix: readonly [number, number, number, number];
  matrix: readonly [number, number, number, number, number, number];
  transform: string;
}

export const LABEL_MIN_DEPTH = CAMERA_FOCAL_LENGTH * 0.15;
export const LABEL_MIN_BASIS_LENGTH = 0.01;
export const LABEL_MAX_BASIS_LENGTH = CAMERA_SETTINGS.maxZoom / 0.15 + 1;
export const LABEL_MIN_DETERMINANT = 0.015;

const singularValues2x2 = (a: number, b: number, c: number, d: number) => {
  const energy = a * a + b * b + c * c + d * d;
  const determinant = a * d - b * c;
  const discriminant = Math.sqrt(Math.max(0, energy * energy - 4 * determinant * determinant));
  return {
    max: Math.sqrt(Math.max(0, (energy + discriminant) / 2)),
    min: Math.sqrt(Math.max(0, (energy - discriminant) / 2)),
  };
};

/**
 * Flat geographic labels are screen-space typography anchored to the map.
 * Perspective controls position and a normalized local surface frame, never
 * unbounded absolute glyph scale.
 */
export function projectFlatMapLabel(
  camera: CameraState,
  worldX: number,
  worldY: number,
): FlatLabelProjection | null {
  const project = createWorldToScreenProjector(camera);
  const depth = flatCameraDepth(camera, worldX, worldY);
  if (!Number.isFinite(depth) || depth < LABEL_MIN_DEPTH) return null;
  const anchor = project(worldX, worldY);
  const tangent = project(worldX + 1, worldY);
  const vertical = project(worldX, worldY + 1);
  if (!anchor || !tangent || !vertical) return null;
  const dx = tangent.x - anchor.x;
  const dy = tangent.y - anchor.y;
  const verticalX = vertical.x - anchor.x;
  const verticalY = vertical.y - anchor.y;
  const basisLength = Math.hypot(dx, dy);
  const verticalBasisLength = Math.hypot(verticalX, verticalY);
  if (
    ![anchor.x, anchor.y, dx, dy, verticalX, verticalY, basisLength, verticalBasisLength].every(
      Number.isFinite,
    ) ||
    basisLength < LABEL_MIN_BASIS_LENGTH ||
    basisLength > LABEL_MAX_BASIS_LENGTH ||
    verticalBasisLength < LABEL_MIN_BASIS_LENGTH ||
    verticalBasisLength > LABEL_MAX_BASIS_LENGTH
  )
    return null;
  const exX = dx / basisLength;
  const exY = dy / basisLength;
  const rawC = verticalX / basisLength;
  const rawD = verticalY / basisLength;
  const rawSingular = singularValues2x2(exX, exY, rawC, rawD);
  if (
    !Number.isFinite(rawSingular.max) ||
    !Number.isFinite(rawSingular.min) ||
    rawSingular.max < LABEL_MIN_BASIS_LENGTH ||
    rawSingular.min / rawSingular.max < LABEL_MIN_DETERMINANT
  )
    return null;
  // The tiny guard keeps a recomputed sigmaMax at or below one despite
  // floating-point cancellation in extremely ill-conditioned frames.
  const perspectiveNormalization = 1 / (rawSingular.max * (1 + 1e-7));
  const shapeA = exX * perspectiveNormalization;
  const shapeB = exY * perspectiveNormalization;
  const shapeC = rawC * perspectiveNormalization;
  const shapeD = rawD * perspectiveNormalization;
  const perspectiveSingular = singularValues2x2(shapeA, shapeB, shapeC, shapeD);
  const shear = shapeC * shapeA + shapeD * shapeB;
  const foreshortening = shapeA * shapeD - shapeB * shapeC;
  const rotation = (Math.atan2(dy, dx) * 180) / Math.PI;
  const scale = clamp(camera.zoom, CAMERA_SETTINGS.minZoom, CAMERA_SETTINGS.maxZoom);
  const a = shapeA * scale;
  const b = shapeB * scale;
  const c = shapeC * scale;
  const d = shapeD * scale;
  const determinant = a * d - b * c;
  const values = [anchor.x, anchor.y, rotation, scale, a, b, c, d, determinant];
  if (!values.every(Number.isFinite)) return null;
  return {
    x: anchor.x,
    y: anchor.y,
    rotation,
    scale,
    depth,
    basisLength,
    verticalBasisLength,
    shear,
    foreshortening,
    determinant,
    rawSigmaMax: rawSingular.max,
    rawSigmaMin: rawSingular.min,
    perspectiveSigmaMax: perspectiveSingular.max,
    perspectiveSigmaMin: perspectiveSingular.min,
    rawMatrix: [exX, exY, rawC, rawD],
    matrix: [a, b, c, d, anchor.x, anchor.y],
    transform: `matrix(${a} ${b} ${c} ${d} ${anchor.x} ${anchor.y})`,
  };
}

type LabelCandidate<T> = LabelOpacity<T> & {
  id: string;
  point: [number, number];
  rank: number;
  width: number;
  height: number;
};

export function selectMapLabels(camera: CameraState): SelectedMapLabels {
  const zoom = camera.zoom;
  const viewport = {
    minX: -camera.x / zoom,
    minY: -camera.y / zoom,
    maxX: (-camera.x + 1000) / zoom,
    maxY: (-camera.y + 560) / zoom,
  };

  const continents = resolveCollisions(
    CONTINENT_LABELS.map((label) => candidate(label, label.name, 0, fade(zoom, 0.8, 1.35), 34, 10)),
    viewport,
  );
  const oceans = resolveCollisions(
    MARINE_LABELS.filter((label) => label.kind === 'ocean').map((label) =>
      candidate(label, label.name, label.rank ?? 2, fade(zoom, 0.9, 1.9), 28, 8),
    ),
    viewport,
  );
  const countries = resolveCollisions(
    COUNTRIES.map((country) => {
      const capacity = COUNTRY_CAPACITIES.get(country.id) ?? { width: 0, height: 0 };
      const textWidth = Math.max(country.name.length, country.nameFa?.length ?? 0) * 4.8;
      const fitScale = clamp(capacity.width / Math.max(1, textWidth), 0, 1);
      const zoomScale = clamp(0.68 + Math.log2(Math.max(1, zoom)) * 0.12, 0.68, 0.98);
      const scale = Math.min(fitScale, zoomScale);
      const opacity = scale < 0.52 ? 0 : fade(zoom, countryThreshold(country.labelRank), 0.42);
      return {
        ...candidate(country, country.name, country.labelRank, opacity, 4.8 * scale, 5.6 * scale),
        scale,
        letterSpacing: clamp(0.18 - (1 - scale) * 0.16, 0.02, 0.18),
      };
    }),
    viewport,
  );
  const capitals = resolveCollisions(
    CITY_LABELS.filter((label) => label.capital).map((label) =>
      candidate(label, label.name, label.rank ?? 3, fade(zoom, 1.12 + (label.rank ?? 3) * 0.2, 0.32), 5, 6),
    ),
    viewport,
  );
  const cities = resolveCollisions(
    CITY_LABELS.filter((label) => !label.capital).map((label) =>
      candidate(label, label.name, label.rank ?? 5, fade(zoom, 2.25 + (label.rank ?? 5) * 0.16, 0.38), 4, 6),
    ),
    viewport,
  );

  return {
    continents,
    oceans,
    countries,
    capitals,
    cities,
    riversOpacity: fade(zoom, 1.18, 0.42),
    lakesOpacity: fade(zoom, 0.92, 0.32),
  };
}

function candidate<T extends { id: string; point?: [number, number]; label?: [number, number] }>(
  item: T,
  text: string,
  rank: number,
  opacity: number,
  charWidth: number,
  height: number,
): LabelCandidate<T> {
  const point = item.point ?? item.label ?? [0, 0];
  return {
    item,
    id: item.id,
    point,
    rank,
    opacity,
    width: Math.max(18, text.length * charWidth) / Math.max(0.9, rank * 0.18 + 1),
    height,
  };
}

function resolveCollisions<T>(labels: LabelCandidate<T>[], viewport: Bounds): LabelOpacity<T>[] {
  const occupied: Bounds[] = [];
  return labels
    .filter((label) => label.opacity > 0.02 && isVisible(label.point, viewport))
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
    .flatMap((label) => {
      const box = labelBounds(label);
      if (occupied.some((candidate) => intersects(candidate, box))) return [];
      occupied.push(box);
      return [
        {
          item: label.item,
          opacity: label.opacity,
          scale: label.scale,
          letterSpacing: label.letterSpacing,
        },
      ];
    });
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function labelBounds(label: LabelCandidate<unknown>): Bounds {
  return {
    minX: label.point[0] - label.width / 2,
    minY: label.point[1] - label.height / 2,
    maxX: label.point[0] + label.width / 2,
    maxY: label.point[1] + label.height / 2,
  };
}

function isVisible(point: [number, number], viewport: Bounds) {
  return (
    point[0] >= viewport.minX - 40 &&
    point[0] <= viewport.maxX + 40 &&
    point[1] >= viewport.minY - 30 &&
    point[1] <= viewport.maxY + 30
  );
}

function intersects(a: Bounds, b: Bounds) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

function countryThreshold(rank: number) {
  if (rank <= 1) return 0.82;
  if (rank <= 2) return 1.02;
  if (rank <= 3) return 1.28;
  if (rank <= 4) return 1.72;
  return 2.34;
}

function countryCapacity(path: string) {
  const numbers = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  if (numbers.length < 4) return { width: 0, height: 0 };
  const xs = numbers.filter((_, index) => index % 2 === 0);
  const ys = numbers.filter((_, index) => index % 2 === 1);
  return {
    width: Math.max(0, Math.max(...xs) - Math.min(...xs)) * 0.74,
    height: Math.max(0, Math.max(...ys) - Math.min(...ys)) * 0.56,
  };
}

const COUNTRY_CAPACITIES = new Map(COUNTRIES.map((country) => [country.id, countryCapacity(country.path)]));

function fade(zoom: number, start: number, width: number) {
  return clamp((zoom - start) / width, 0, 1);
}
