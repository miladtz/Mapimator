import type { CameraState, CanvasLayout, Layer } from './project';

export const autoReframe = (layers: Layer[], current: CameraState, layout: CanvasLayout): CameraState => {
  const visible = layers.filter((layer) => layer.visible);
  if (!visible.length) return current;
  const xs = visible.flatMap((layer) => [layer.x, layer.x2 ?? layer.x]);
  const ys = visible.flatMap((layer) => [layer.y, layer.y2 ?? layer.y]);
  const width = Math.max(1, Math.max(...xs) - Math.min(...xs));
  const height = Math.max(1, Math.max(...ys) - Math.min(...ys));
  const targetAspect = layout.width / layout.height;
  const contentAspect = width / height;
  const zoom = Math.max(
    0.72,
    Math.min(3.4, current.zoom * Math.min(contentAspect / targetAspect, targetAspect / contentAspect, 1)),
  );
  return { x: current.x, y: current.y, zoom };
};
