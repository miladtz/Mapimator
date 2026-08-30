import type { Project } from './project';
import { compileTimeline } from './viewCompiler';

export const VIEW_CARD_WIDTH = 160;
export const TRANSITION_CARD_WIDTH = 90;
export const TIMELINE_CARD_GAP = 9;

export interface TimelineLayoutItem {
  id: string;
  kind: 'view' | 'transition';
  x: number;
  width: number;
  projectStartTime: number;
  projectEndTime: number;
}

export interface TimelineLayout {
  duration: number;
  items: TimelineLayoutItem[];
  width: number;
}

export interface ResolvedTimelinePosition {
  item: TimelineLayoutItem;
  localTime: number;
  localProgress: number;
  absoluteTime: number;
  x: number;
}

const positiveDuration = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);

export function buildTimelineLayout(project: Project, zoom = 1): TimelineLayout {
  const sequence = compileTimeline(project);
  const scale = Math.max(0.01, zoom);
  const items: TimelineLayoutItem[] = [];
  let x = 0;
  let boundary = 0;

  project.views.forEach((view, index) => {
    const holdDuration = positiveDuration(view.holdDuration);
    const width = VIEW_CARD_WIDTH * scale;
    items.push({
      id: view.id,
      kind: 'view',
      x,
      width,
      projectStartTime: boundary,
      projectEndTime: boundary + holdDuration,
    });
    x += width + TIMELINE_CARD_GAP;
    boundary += holdDuration;

    const next = project.views[index + 1];
    const transition =
      next &&
      project.transitions.find(
        (candidate) => candidate.fromViewId === view.id && candidate.toViewId === next.id,
      );
    if (!transition) return;
    const duration = positiveDuration(transition.duration);
    const transitionWidth = TRANSITION_CARD_WIDTH * scale;
    items.push({
      id: transition.id,
      kind: 'transition',
      x,
      width: transitionWidth,
      projectStartTime: boundary,
      projectEndTime: boundary + duration,
    });
    x += transitionWidth + TIMELINE_CARD_GAP;
    boundary += duration;
  });

  return { duration: sequence.duration, items, width: Math.max(0, x - TIMELINE_CARD_GAP) };
}

export function resolveTimelineAtTime(layout: TimelineLayout, time: number): ResolvedTimelinePosition | null {
  const timedItems = layout.items.filter((item) => item.projectEndTime > item.projectStartTime);
  if (!timedItems.length) return null;
  const absoluteTime = Math.max(0, Math.min(layout.duration, time));
  const item =
    timedItems.find(
      (candidate) => absoluteTime >= candidate.projectStartTime && absoluteTime < candidate.projectEndTime,
    ) ?? timedItems.at(-1)!;
  const duration = item.projectEndTime - item.projectStartTime;
  const localTime = Math.max(0, Math.min(duration, absoluteTime - item.projectStartTime));
  const localProgress = localTime / duration;
  return {
    item,
    localTime,
    localProgress,
    absoluteTime,
    x: item.x + localProgress * item.width,
  };
}

export function timelinePosition(project: Project, time: number, zoom = 1) {
  const layout = buildTimelineLayout(project, zoom);
  const resolved = resolveTimelineAtTime(layout, time);
  if (resolved) return resolved.x;
  return layout.items[0]?.x ?? 0;
}

export function timelineTimeAtPosition(project: Project, x: number, zoom = 1) {
  const layout = buildTimelineLayout(project, zoom);
  if (!layout.items.length || x <= layout.items[0].x) return 0;

  const item = layout.items.find((candidate) => x >= candidate.x && x <= candidate.x + candidate.width);
  if (item) {
    const duration = item.projectEndTime - item.projectStartTime;
    if (duration <= 0) return item.projectStartTime;
    const localProgress = Math.max(0, Math.min(1, (x - item.x) / item.width));
    return item.projectStartTime + localProgress * duration;
  }

  for (let index = 0; index < layout.items.length - 1; index += 1) {
    const previous = layout.items[index];
    const next = layout.items[index + 1];
    const previousEnd = previous.x + previous.width;
    if (x <= previousEnd || x >= next.x) continue;
    return x - previousEnd <= next.x - x ? previous.projectEndTime : next.projectStartTime;
  }

  return layout.duration;
}
