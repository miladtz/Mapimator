import type { CameraState, Layer, Project, View } from './project';
import { easeCameraProgress, interpolateCamera, interpolateNumber } from './camera';

export type LayerDiff = 'ENTER' | 'EXIT' | 'UPDATE' | 'HOLD' | 'NONE';
export interface AnimationSegment {
  from: View;
  to?: View;
  start: number;
  holdEnd: number;
  end: number;
}
export interface AnimationSequence {
  duration: number;
  segments: AnimationSegment[];
}
export interface RenderedProjectState {
  camera: CameraState;
  layers: Layer[];
  activeViewIndex: number;
  transitionProgress: number;
}

export const diffLayerState = (previous?: Layer, next?: Layer): LayerDiff => {
  if (!previous && next?.visible) return 'ENTER';
  if (previous?.visible && !next) return 'EXIT';
  if (!previous?.visible && next?.visible) return 'ENTER';
  if (previous?.visible && !next?.visible) return 'EXIT';
  if (!previous || !next) return 'NONE';
  return JSON.stringify(previous) === JSON.stringify(next) ? 'HOLD' : 'UPDATE';
};
export const compileViews = (views: View[]): AnimationSequence => {
  let cursor = 0;
  const segments = views.map((view, index) => {
    const start = cursor;
    const holdEnd = start + view.holdDuration;
    const end = holdEnd + (index < views.length - 1 ? view.transitionDuration : 0);
    cursor = end;
    return { from: view, to: views[index + 1], start, holdEnd, end };
  });
  return { duration: cursor, segments };
};
const blendLayer = (previous: Layer | undefined, next: Layer | undefined, t: number): Layer | null => {
  if (!previous && !next) return null;
  if (!previous && next) return { ...next, opacity: next.opacity * t, visible: t > 0 };
  if (previous && !next) return { ...previous, opacity: previous.opacity * (1 - t), visible: t < 1 };
  if (!previous || !next) return null;
  return {
    ...next,
    x: interpolateNumber(previous.x, next.x, t),
    y: interpolateNumber(previous.y, next.y, t),
    x2:
      previous.x2 !== undefined && next.x2 !== undefined
        ? interpolateNumber(previous.x2, next.x2, t)
        : next.x2,
    y2:
      previous.y2 !== undefined && next.y2 !== undefined
        ? interpolateNumber(previous.y2, next.y2, t)
        : next.y2,
    opacity: interpolateNumber(previous.opacity, next.opacity, t),
    visible: t < 0.5 ? previous.visible : next.visible,
  };
};
export const evaluateProjectAtTime = (project: Project, time: number): RenderedProjectState => {
  const sequence = compileViews(project.views);
  const index = sequence.segments.findIndex((s) => time >= s.start && time <= s.end);
  const segment = sequence.segments[Math.max(0, index)];
  if (!segment)
    return {
      camera: { x: 0, y: 0, zoom: 1 },
      layers: project.layers,
      activeViewIndex: 0,
      transitionProgress: 0,
    };
  if (!segment.to || time <= segment.holdEnd)
    return {
      camera: segment.from.camera,
      layers: structuredClone(segment.from.layers),
      activeViewIndex: Math.max(0, index),
      transitionProgress: 0,
    };
  const raw = Math.min(1, (time - segment.holdEnd) / segment.from.transitionDuration);
  const t = easeCameraProgress(raw, segment.from.transitionPreset);
  const before = new Map(segment.from.layers.map((l) => [l.id, l]));
  const after = new Map(segment.to.layers.map((l) => [l.id, l]));
  const ids = new Set([...before.keys(), ...after.keys()]);
  return {
    camera: interpolateCamera(segment.from.camera, segment.to.camera, raw, segment.from.transitionPreset),
    layers: [...ids]
      .map((id) => blendLayer(before.get(id), after.get(id), t))
      .filter((l): l is Layer => l !== null),
    activeViewIndex: Math.max(0, index),
    transitionProgress: raw,
  };
};
