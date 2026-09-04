import { haversineMeters, type Coordinate } from './maritimeGeometry';

export type RefinementWindow = { startSegment: number; endSegment: number; geometry: Coordinate[] };

const bearing = (start: Coordinate, end: Coordinate) => {
  const radians = (value: number) => (value * Math.PI) / 180;
  const latitudeA = radians(start[1]);
  const latitudeB = radians(end[1]);
  const longitudeDelta = radians(end[0] - start[0]);
  return (
    (Math.atan2(
      Math.sin(longitudeDelta) * Math.cos(latitudeB),
      Math.cos(latitudeA) * Math.sin(latitudeB) -
        Math.sin(latitudeA) * Math.cos(latitudeB) * Math.cos(longitudeDelta),
    ) *
      180) /
    Math.PI
  );
};
const angleDelta = (a: number, b: number) => Math.abs(((b - a + 540) % 360) - 180);

export const selectMaritimeRefinementWindows = (geometry: Coordinate[]): RefinementWindow[] => {
  if (geometry.length < 2) return [];
  const segmentCount = geometry.length - 1;
  if (segmentCount <= 100) return [{ startSegment: 0, endSegment: segmentCount - 1, geometry }];
  const selected = new Set<number>();
  for (let index = 0; index < Math.min(12, segmentCount); index += 1) {
    selected.add(index);
    selected.add(segmentCount - 1 - index);
  }
  for (let index = 4; index < geometry.length - 4; index += 1) {
    const turn = angleDelta(
      bearing(geometry[index - 4], geometry[index]),
      bearing(geometry[index], geometry[index + 4]),
    );
    const longChord = haversineMeters(geometry[index], geometry[index + 1]) > 20_000;
    if (turn >= 30 || longChord)
      for (let offset = -2; offset <= 2; offset += 1) {
        const segment = index + offset;
        if (segment >= 0 && segment < segmentCount) selected.add(segment);
      }
  }
  const ordered = [...selected].sort((a, b) => a - b);
  const windows: RefinementWindow[] = [];
  for (const index of ordered) {
    const previous = windows.at(-1);
    if (previous && index <= previous.endSegment + 1 && index - previous.startSegment < 16) {
      previous.endSegment = index;
      previous.geometry = geometry.slice(previous.startSegment, index + 2);
    } else
      windows.push({ startSegment: index, endSegment: index, geometry: geometry.slice(index, index + 2) });
  }
  return windows;
};
