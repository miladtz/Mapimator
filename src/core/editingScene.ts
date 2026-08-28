import type { CameraState, Layer, Project, SegmentRef } from './project';
import { interpolateCamera } from './camera';
import { interpolateCameraChainTransition } from './cameraContinuity';
import { interpolateGlobeCamera } from './globeMath';

export interface EditingScene {
  camera: CameraState;
  layers: Layer[];
}

/**
 * Resolve the editor-only Project composition. Segment membership is timeline
 * configuration and must never hide canonical Project Layers on this canvas.
 * Animation transients and sequence time are intentionally ignored.
 */
export function resolveEditingScene(
  project: Project,
  segment: SegmentRef | null,
  workingCamera: CameraState = { x: 0, y: 0, zoom: 1 },
): EditingScene {
  const layers = project.layers.map((layer) => ({ ...structuredClone(layer), visible: true }));
  if (!segment)
    return {
      camera: { ...workingCamera },
      layers,
    };
  if (segment.kind === 'view') {
    const view = project.views.find((candidate) => candidate.id === segment.id);
    return view ? { camera: { ...view.camera }, layers } : { camera: { ...workingCamera }, layers };
  }
  const transition = project.transitions.find((candidate) => candidate.id === segment.id);
  const from = transition && project.views.find((view) => view.id === transition.fromViewId);
  const to = transition && project.views.find((view) => view.id === transition.toViewId);
  if (!transition || !from || !to) return { camera: { ...workingCamera }, layers };
  const fromIndex = project.views.findIndex((view) => view.id === from.id);
  return {
    camera:
      interpolateCameraChainTransition(project, fromIndex, 0.5) ??
      (from.mapMode === 'globe'
        ? interpolateGlobeCamera(from.camera, to.camera, 0.5, transition.preset, transition.type)
        : interpolateCamera(from.camera, to.camera, 0.5, transition.preset, transition.type)),
    layers,
  };
}

/** @deprecated Use resolveEditingScene. Kept for milestone compatibility tests. */
export const resolveSegmentForEditing = resolveEditingScene;
