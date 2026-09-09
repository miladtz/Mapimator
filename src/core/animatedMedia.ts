import type { Layer, SegmentLayerAnimation } from './project';

export interface AnimatedWebPFrameInfo {
  index: number;
  startMs: number;
  durationMs: number;
}

export interface AnimatedWebPInfo {
  frameCount: number;
  cycleDurationMs: number;
  repetitionCount: number;
  canvasWidth: number;
  canvasHeight: number;
  frames: AnimatedWebPFrameInfo[];
}

export interface AnimatedMediaActiveInterval {
  start: number;
  end: number;
}

export const mergeAnimatedMediaIntervals = (intervals: AnimatedMediaActiveInterval[]) => {
  const merged: AnimatedMediaActiveInterval[] = [];
  for (const interval of [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end + 1e-9)
      previous.end = Math.max(previous.end, interval.end);
    else if (interval.end > interval.start) merged.push({ ...interval });
  }
  return merged;
};

export interface AnimatedMediaTimelineEvent {
  start: number;
  end: number;
  animation?: SegmentLayerAnimation;
}

export const animatedMediaIntervalsForRun = (
  events: readonly AnimatedMediaTimelineEvent[],
  runStart: number,
  runEnd: number,
  intrinsicCycleDurationMs: number,
) =>
  mergeAnimatedMediaIntervals(
    events.map(({ start: segmentStart, end: segmentEnd, animation }) => {
      if (!animation?.animatedMediaRepeatCountEnabled) return { start: segmentStart, end: segmentEnd };
      const start = segmentStart + Math.max(0, animation.animatedMediaStartDelay ?? 0);
      const end = start + animatedMediaEffectiveDurationMs(animation, intrinsicCycleDurationMs) / 1000;
      return { start: Math.max(runStart, start), end: Math.min(runEnd, end) };
    }),
  );

export const animatedMediaRotationOf = (layer: Layer) => layer.animatedMediaRotation ?? 0;
export const animatedMediaAspectRatioOf = (layer: Layer) =>
  layer.animatedMediaAspectRatio ?? (layer.width ?? 160) / Math.max(1, layer.height ?? 90);

/** Pixel offsets used by the retained billboard renderer and editor hit geometry. */
export const animatedMediaScreenOffsets = (layer: Layer): [number, number][] => {
  const width = Math.max(1, layer.width ?? 160);
  const height = Math.max(1, layer.height ?? 90);
  const radians = (animatedMediaRotationOf(layer) * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [
    [-width / 2, -height / 2],
    [width / 2, -height / 2],
    [width / 2, height / 2],
    [-width / 2, height / 2],
  ].map(([x, y]) => [x * cosine - y * sine, x * sine + y * cosine]);
};

export const pointInAnimatedMediaScreenQuad = (
  layer: Layer,
  center: { x: number; y: number },
  point: { x: number; y: number },
) => {
  const polygon = animatedMediaScreenOffsets(layer).map(([x, y]) => ({ x: center.x + x, y: center.y + y }));
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
};

export const resizeAnimatedMedia = (layer: Layer, width: number, height: number): Partial<Layer> => {
  const safeWidth = Math.max(4, width);
  const safeHeight = Math.max(4, height);
  const ratio = animatedMediaAspectRatioOf(layer);
  return layer.animatedMediaAspectLocked !== false
    ? { width: safeWidth, height: safeWidth / Math.max(0.0001, ratio), animatedMediaAspectRatio: ratio }
    : { width: safeWidth, height: safeHeight, animatedMediaAspectRatio: safeWidth / safeHeight };
};

export const rotateAnimatedMediaToward = (layer: Layer, point: { x: number; y: number }): Partial<Layer> => ({
  animatedMediaRotation:
    Math.round(
      ((Math.atan2(
        point.y - (layer.y + (layer.height ?? 90) / 2),
        point.x - (layer.x + (layer.width ?? 160) / 2),
      ) *
        180) /
        Math.PI +
        90) *
        1000,
    ) / 1000,
});

export const animatedMediaEffectiveDurationMs = (
  animation: SegmentLayerAnimation | undefined,
  intrinsicCycleDurationMs: number,
) =>
  animation?.animatedMediaRepeatCountEnabled
    ? Math.max(0.001, animation.animatedMediaRepeatCount ?? 1) * intrinsicCycleDurationMs
    : Number.POSITIVE_INFINITY;

const dataUrlBytes = (url: string) => {
  const comma = url.indexOf(',');
  if (comma < 0) throw new Error('Invalid Animated WebP asset data.');
  const binary = atob(url.slice(comma + 1));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const isAnimatedWebPBytes = (bytes: Uint8Array) => {
  if (bytes.length < 16 || new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RIFF') return false;
  if (new TextDecoder().decode(bytes.subarray(8, 12)) !== 'WEBP') return false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = new TextDecoder().decode(bytes.subarray(offset, offset + 4));
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    if (kind === 'ANIM' || kind === 'ANMF') return true;
    offset += 8 + size + (size & 1);
  }
  return false;
};

const uint24 = (bytes: Uint8Array, offset: number) =>
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);

/** Animated WebP canvas comes from VP8X, never a frame patch or alpha bounds. */
export const animatedWebPCanvasSize = (bytes: Uint8Array) => {
  if (bytes.length < 30 || new TextDecoder().decode(bytes.subarray(12, 16)) !== 'VP8X')
    throw new Error('Animated WebP is missing its extended canvas header.');
  const width = uint24(bytes, 24) + 1;
  const height = uint24(bytes, 27) + 1;
  if (width <= 0 || height <= 0) throw new Error('Animated WebP has invalid canvas dimensions.');
  return { width, height };
};

export const animatedWebPBytesFromDataUrl = (url: string) => {
  const bytes = dataUrlBytes(url);
  if (!isAnimatedWebPBytes(bytes))
    throw new Error('This WebP is static. Use the normal Image layer for static WebP files.');
  return bytes;
};

export const animatedMediaFrameAtTime = (
  info: AnimatedWebPInfo,
  localTimeMs: number,
  playback: 'loop' | 'once',
) => {
  if (!info.frames.length) return 0;
  const cycle = Math.max(1, info.cycleDurationMs);
  const elapsed = Math.max(0, localTimeMs);
  const time =
    playback === 'loop' ? ((elapsed % cycle) + cycle) % cycle : Math.min(elapsed, Math.max(0, cycle - 0.001));
  return (
    info.frames.find((frame) => time < frame.startMs + frame.durationMs)?.index ?? info.frames.length - 1
  );
};

export const evaluateAnimatedMediaTime = (
  layer: Layer,
  animation: SegmentLayerAnimation | undefined,
  segmentLocalTimeSeconds: number,
) => {
  const delay = Math.max(0, animation?.animatedMediaStartDelay ?? 0);
  const duration =
    animatedMediaEffectiveDurationMs(animation, Math.max(1, layer.animatedMediaCycleDurationMs ?? 1000)) /
    1000;
  const local = segmentLocalTimeSeconds - delay;
  layer.visible = layer.visible && local >= 0 && local < duration;
  layer.animatedMediaTimeMs = Math.max(0, local * 1000);
  layer.animatedMediaRepeatCountEnabled = Boolean(animation?.animatedMediaRepeatCountEnabled);
  layer.animatedMediaRepeatCount = Math.max(1, Math.floor(animation?.animatedMediaRepeatCount ?? 1));
};
