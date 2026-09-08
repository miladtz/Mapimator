import type { Layer, ProjectImageAsset, SegmentLayerAnimation } from './project';
import { mapMotionWorldToLngLat } from './openFreeMapAdapter';

export type ImageFitMode = 'contain' | 'cover';
export type ImageHandleKind = 'north-west' | 'north-east' | 'south-east' | 'south-west' | 'rotate';

export const imageRotationOf = (layer: Layer) => layer.imageRotation ?? 0;
export const imageFitModeOf = (layer: Layer): ImageFitMode => layer.imageFitMode ?? 'contain';
export const imageAspectLocked = (layer: Layer) => layer.imageAspectLocked !== false;
export const IMAGE_MAP_ZOOM_MIN_SCALE = 0.5;
export const IMAGE_MAP_ZOOM_MAX_SCALE = 3;
export const imageMapZoomScale = (animation: SegmentLayerAnimation | undefined, cameraZoom: number) => {
  if (!animation?.imageScaleWithMapZoom) return 1;
  const referenceZoom = Math.max(0.000001, animation.imageReferenceZoom ?? cameraZoom);
  return Math.max(
    IMAGE_MAP_ZOOM_MIN_SCALE,
    Math.min(IMAGE_MAP_ZOOM_MAX_SCALE, Math.sqrt(Math.max(0.000001, cameraZoom) / referenceZoom)),
  );
};

/** Image Wipe is an independent segment-time channel and composes with Appear. */
export const imageWipeVisibility = (
  animation: SegmentLayerAnimation | undefined,
  segmentLocalTime: number,
) => {
  if (!animation?.wipeEnabled) return 1;
  const start = Math.max(0, animation.wipeDelay ?? 0);
  const duration = Math.max(0.05, animation.wipeDuration ?? 0.5);
  if (segmentLocalTime <= start) return 1;
  return Math.max(0, Math.min(1, 1 - (segmentLocalTime - start) / duration));
};

export const evaluatedImageLayer = (layer: Layer): Layer => {
  const scale = Math.max(0, (layer.imageRenderScale ?? 1) * (layer.imageAnimationScale ?? 1));
  const width = Math.max(1, layer.width ?? 160);
  const height = Math.max(1, layer.height ?? 90);
  return {
    ...layer,
    x: layer.x + (width * (1 - scale)) / 2,
    y: layer.y + (height * (1 - scale)) / 2 + (layer.imageDropOffsetY ?? 0),
    width: width * scale,
    height: height * scale,
  };
};
export const imageRenderSurfaceState = (layer: Layer) => {
  const geometry = evaluatedImageLayer(layer);
  const visibleFraction = Math.max(0, Math.min(1, layer.imageWipeProgress ?? 1));
  return {
    geometry,
    opacity: Math.max(0, Math.min(1, layer.opacity)),
    visibleFraction,
    visibleWidth: Math.max(0, geometry.width ?? 0) * visibleFraction,
    orientation: layer.imageOrientation ?? 'flat-on-map',
  } as const;
};
export const imageAspectRatioOf = (layer: Layer, asset?: ProjectImageAsset) =>
  layer.imageAspectRatio ??
  (asset && asset.height > 0 ? asset.width / asset.height : (layer.width ?? 160) / (layer.height ?? 90));

export const imageWorldCorners = (layer: Layer): [number, number][] => {
  layer = evaluatedImageLayer(layer);
  const width = Math.max(1, layer.width ?? 160);
  const height = Math.max(1, layer.height ?? 90);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const centerX = layer.x + halfWidth;
  const centerY = layer.y + halfHeight;
  const radians = (imageRotationOf(layer) * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ].map(([x, y]) => [centerX + x * cosine - y * sine, centerY + x * sine + y * cosine]);
};

export const imageGeographicCorners = (layer: Layer): [number, number][] =>
  imageWorldCorners(layer).map(([x, y]) => mapMotionWorldToLngLat(x, y));

export const resizeImageLayer = (
  layer: Layer,
  width: number,
  height: number,
  asset?: ProjectImageAsset,
): Partial<Layer> => {
  const safeWidth = Math.max(4, width);
  const safeHeight = Math.max(4, height);
  const ratio = imageAspectRatioOf(layer, asset);
  return imageAspectLocked(layer)
    ? { width: safeWidth, height: safeWidth / Math.max(0.0001, ratio), imageAspectRatio: ratio }
    : { width: safeWidth, height: safeHeight, imageAspectRatio: safeWidth / safeHeight };
};

export const resizeImageFromHandle = (
  layer: Layer,
  handle: Exclude<ImageHandleKind, 'rotate'>,
  point: { x: number; y: number },
  asset?: ProjectImageAsset,
): Partial<Layer> => {
  const radians = (-imageRotationOf(layer) * Math.PI) / 180;
  const centerX = layer.x + (layer.width ?? 160) / 2;
  const centerY = layer.y + (layer.height ?? 90) / 2;
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  const localX = dx * Math.cos(radians) - dy * Math.sin(radians);
  const localY = dx * Math.sin(radians) + dy * Math.cos(radians);
  const width = Math.max(4, Math.abs(localX) * 2);
  const height = Math.max(4, Math.abs(localY) * 2);
  const resized = resizeImageLayer(layer, width, height, asset);
  // Keeping the geographic anchor fixed makes repeated drags drift-free. The
  // handle name remains useful for editor hit testing and future edge resizing.
  void handle;
  return resized;
};

export const rotateImageToward = (layer: Layer, point: { x: number; y: number }): Partial<Layer> => ({
  imageRotation:
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
