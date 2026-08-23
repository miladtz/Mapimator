import type { CameraState, CanvasLayout, Layer } from './project';
import { autoReframeCamera } from './camera';

export const autoReframe = (layers: Layer[], current: CameraState, layout: CanvasLayout): CameraState =>
  autoReframeCamera(layers, current, layout);
