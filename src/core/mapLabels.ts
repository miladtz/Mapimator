import { CITY_LABELS, CONTINENT_LABELS, COUNTRIES, MARINE_LABELS, type MapLabel } from '../data/worldMap';
import type { CameraState } from './project';
import { clamp } from './camera';

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
      const capacity = countryCapacity(country.path);
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

function fade(zoom: number, start: number, width: number) {
  return clamp((zoom - start) / width, 0, 1);
}
