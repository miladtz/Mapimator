import { CAMERA_SETTINGS, CAMERA_VIEWPORT, normalizeBearing, roundCamera } from './camera';
import {
  conjugateQuaternion,
  globeOrientationOf,
  globeFocusOf,
  multiplyQuaternions,
  quaternionFromRotationVector,
  quaternionRotationVector,
  sphericalBezier,
  normalize3,
  type Vec3,
} from './globeMath';
import type { CameraState, Project, Quaternion } from './project';

const transitionDuration = (project: Project, fromIndex: number) => {
  const from = project.views[fromIndex];
  const to = project.views[fromIndex + 1];
  if (!from || !to) return 0;
  const transition = project.transitions.find(
    (candidate) => candidate.fromViewId === from.id && candidate.toViewId === to.id,
  );
  return transition && Number.isFinite(transition.duration) ? Math.max(0, transition.duration) : 0;
};

export const isPassThroughCameraWaypoint = (project: Project, viewIndex: number) =>
  viewIndex > 0 &&
  viewIndex < project.views.length - 1 &&
  project.views[viewIndex].holdDuration === 0 &&
  transitionDuration(project, viewIndex - 1) > 0 &&
  transitionDuration(project, viewIndex) > 0;

const hermite = (
  start: number,
  end: number,
  startVelocity: number,
  endVelocity: number,
  duration: number,
  t: number,
) => {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * start +
    (t3 - 2 * t2 + t) * duration * startVelocity +
    (-2 * t3 + 3 * t2) * end +
    (t3 - t2) * duration * endVelocity
  );
};

const scalarVelocity = (project: Project, index: number, value: (camera: CameraState) => number) => {
  if (!isPassThroughCameraWaypoint(project, index)) return 0;
  const before = transitionDuration(project, index - 1);
  const after = transitionDuration(project, index);
  return (value(project.views[index + 1].camera) - value(project.views[index - 1].camera)) / (before + after);
};

const cameraWorldCenter = (camera: CameraState) => ({
  x: (CAMERA_VIEWPORT.width / 2 - camera.x) / camera.zoom,
  y: (CAMERA_VIEWPORT.height / 2 - camera.y) / camera.zoom,
});

/**
 * Online Smooth curvature is authored as a visual property. The geometric
 * center direction remains geographic, while its velocity is calibrated to
 * the geometric midpoint of Legacy's accepted multiplicative zoom domain.
 * Dividing by the waypoint's actual authored zoom converts that stable visual
 * velocity back into world units, so deep Online zoom cannot magnify it.
 */
export const SMOOTH_VISUAL_REFERENCE_ZOOM = Math.sqrt(CAMERA_SETTINGS.minZoom * CAMERA_SETTINGS.maxZoom);

const onlineCenterVelocity = (project: Project, index: number, component: 'x' | 'y') => {
  if (!isPassThroughCameraWaypoint(project, index)) return 0;
  const before = transitionDuration(project, index - 1);
  const after = transitionDuration(project, index);
  const previous = cameraWorldCenter(project.views[index - 1].camera);
  const next = cameraWorldCenter(project.views[index + 1].camera);
  const waypointZoom = project.views[index].camera.zoom;
  return (
    ((next[component] - previous[component]) / (before + after)) *
    (SMOOTH_VISUAL_REFERENCE_ZOOM / waypointZoom)
  );
};

const unwrapNear = (value: number | undefined, reference: number) =>
  reference + normalizeBearing((value ?? 0) - reference);

const bearingVelocity = (project: Project, index: number) => {
  if (!isPassThroughCameraWaypoint(project, index)) return 0;
  const current = project.views[index].camera.bearing ?? 0;
  const previous = unwrapNear(project.views[index - 1].camera.bearing, current);
  const next = unwrapNear(project.views[index + 1].camera.bearing, current);
  return (next - previous) / (transitionDuration(project, index - 1) + transitionDuration(project, index));
};

/** Non-uniform monotone cubic tangent: continuous through pass-through Views
 * while preventing Pitch overshoot at extrema and the ±85° safety boundary. */
const pitchVelocity = (project: Project, index: number) => {
  if (!isPassThroughCameraWaypoint(project, index)) return 0;
  const before = transitionDuration(project, index - 1);
  const after = transitionDuration(project, index);
  const previous = project.views[index - 1].camera.pitch ?? 0;
  const current = project.views[index].camera.pitch ?? 0;
  const next = project.views[index + 1].camera.pitch ?? 0;
  const incoming = (current - previous) / before;
  const outgoing = (next - current) / after;
  if (incoming === 0 || outgoing === 0 || Math.sign(incoming) !== Math.sign(outgoing)) return 0;
  const leftWeight = 2 * after + before;
  const rightWeight = after + 2 * before;
  return (leftWeight + rightWeight) / (leftWeight / incoming + rightWeight / outgoing);
};

const addVector = (left: Vec3, right: Vec3): Vec3 => [
  left[0] + right[0],
  left[1] + right[1],
  left[2] + right[2],
];
const scaleVector = (value: Vec3, scale: number): Vec3 => [
  value[0] * scale,
  value[1] * scale,
  value[2] * scale,
];
const relativeRotationVector = (from: Quaternion, to: Quaternion) =>
  quaternionRotationVector(multiplyQuaternions(to, conjugateQuaternion(from)));

/** Shared world-space angular velocity at an interior zero-Hold waypoint. */
const quaternionVelocity = (project: Project, index: number): Vec3 => {
  if (!isPassThroughCameraWaypoint(project, index)) return [0, 0, 0];
  const previous = globeOrientationOf(project.views[index - 1].camera);
  const current = globeOrientationOf(project.views[index].camera);
  const next = globeOrientationOf(project.views[index + 1].camera);
  const total = transitionDuration(project, index - 1) + transitionDuration(project, index);
  return scaleVector(
    addVector(relativeRotationVector(previous, current), relativeRotationVector(current, next)),
    1 / total,
  );
};

/**
 * Absolute-time interpolation for a transition belonging to a camera chain.
 * Returns undefined for ordinary stop-to-stop transitions so their existing
 * transition type/easing behavior remains byte-compatible.
 */
export const interpolateCameraChainTransition = (
  project: Project,
  fromIndex: number,
  progress: number,
): CameraState | undefined => {
  const from = project.views[fromIndex];
  const to = project.views[fromIndex + 1];
  if (!from || !to) return undefined;
  if (
    !isPassThroughCameraWaypoint(project, fromIndex) &&
    !isPassThroughCameraWaypoint(project, fromIndex + 1)
  )
    return undefined;
  const duration = transitionDuration(project, fromIndex);
  if (!(duration > 0)) return undefined;
  const t = Math.max(0, Math.min(1, progress));
  if (t === 0) return from.camera;
  if (t === 1) return to.camera;
  const value = (pick: (camera: CameraState) => number) =>
    hermite(
      pick(from.camera),
      pick(to.camera),
      scalarVelocity(project, fromIndex, pick),
      scalarVelocity(project, fromIndex + 1, pick),
      duration,
      t,
    );
  const onlineFlatCenter = project.mapSettings.basemapRenderer === 'online' && from.mapMode === 'flat';
  const centerValue = (component: 'x' | 'y') => {
    const start = cameraWorldCenter(from.camera);
    const end = cameraWorldCenter(to.camera);
    return hermite(
      start[component],
      end[component],
      onlineCenterVelocity(project, fromIndex, component),
      onlineCenterVelocity(project, fromIndex + 1, component),
      duration,
      t,
    );
  };
  const startBearing = from.camera.bearing ?? 0;
  const endBearing = unwrapNear(to.camera.bearing, startBearing);
  const zoom = Math.exp(
    hermite(
      Math.log(from.camera.zoom),
      Math.log(to.camera.zoom),
      scalarVelocity(project, fromIndex, (candidate) => Math.log(candidate.zoom)),
      scalarVelocity(project, fromIndex + 1, (candidate) => Math.log(candidate.zoom)),
      duration,
      t,
    ),
  );
  const center = onlineFlatCenter ? { x: centerValue('x'), y: centerValue('y') } : null;
  const camera = roundCamera({
    x: center ? CAMERA_VIEWPORT.width / 2 - center.x * zoom : value((candidate) => candidate.x),
    y: center ? CAMERA_VIEWPORT.height / 2 - center.y * zoom : value((candidate) => candidate.y),
    zoom,
    bearing: normalizeBearing(
      hermite(
        startBearing,
        endBearing,
        bearingVelocity(project, fromIndex),
        bearingVelocity(project, fromIndex + 1),
        duration,
        t,
      ),
    ),
    pitch: hermite(
      from.camera.pitch ?? 0,
      to.camera.pitch ?? 0,
      pitchVelocity(project, fromIndex),
      pitchVelocity(project, fromIndex + 1),
      duration,
      t,
    ),
  });
  if (from.mapMode !== 'globe') return camera;

  const start = globeOrientationOf(from.camera);
  const end = globeOrientationOf(to.camera);
  const startVelocity = quaternionVelocity(project, fromIndex);
  const endVelocity = quaternionVelocity(project, fromIndex + 1);
  const startControl = multiplyQuaternions(
    quaternionFromRotationVector(scaleVector(startVelocity, duration / 3)),
    start,
  );
  const endControl = multiplyQuaternions(
    quaternionFromRotationVector(scaleVector(endVelocity, -duration / 3)),
    end,
  );
  const focusComponent = (component: 0 | 1 | 2) =>
    hermite(
      globeFocusOf(from.camera)[component],
      globeFocusOf(to.camera)[component],
      scalarVelocity(project, fromIndex, (candidate) => globeFocusOf(candidate)[component]),
      scalarVelocity(project, fromIndex + 1, (candidate) => globeFocusOf(candidate)[component]),
      duration,
      t,
    );
  const focus = normalize3([focusComponent(0), focusComponent(1), focusComponent(2)]);
  return {
    ...camera,
    globeOrientation: sphericalBezier(start, startControl, endControl, end, t),
    globeFocus: { x: focus[0], y: focus[1], z: focus[2] },
  };
};
