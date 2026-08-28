import {
  clamp,
  easeCameraProgress,
  interpolateBearing,
  interpolateNumber,
  MAX_CAMERA_PITCH,
  MIN_CAMERA_PITCH,
  normalizeBearing,
  roundCamera,
} from './camera';
import {
  IDENTITY_QUATERNION,
  type CameraState,
  type GlobeFocus,
  type Quaternion,
  type TransitionPreset,
  type TransitionType,
} from './project';

export type Vec3 = readonly [number, number, number];
export type Mat4 = Float32Array;

export const worldToLonLat = (x: number, y: number) => ({
  lon: (x / 1000) * 360 - 180,
  lat: 90 - (y / 560) * 180,
});
export const lonLatToWorld = (lon: number, lat: number) => ({
  x: ((lon + 180) / 360) * 1000,
  y: ((90 - lat) / 180) * 560,
});
export const cameraTargetLonLat = (camera: CameraState) =>
  worldToLonLat((500 - camera.x) / camera.zoom, (280 - camera.y) / camera.zoom);
export const cameraWithTargetLonLat = (camera: CameraState, lon: number, lat: number): CameraState => {
  const world = lonLatToWorld(lon, clamp(lat, -89.5, 89.5));
  return roundCamera({ ...camera, x: 500 - world.x * camera.zoom, y: 280 - world.y * camera.zoom });
};

export const lonLatToSphere = (lon: number, lat: number): Vec3 => {
  const lambda = (lon * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180;
  const cosine = Math.cos(phi);
  // +X is longitude 0°, +Y is north and -Z is geographic east. This keeps
  // increasing longitude screen-right for the north-up front camera.
  return [cosine * Math.cos(lambda), Math.sin(phi), -cosine * Math.sin(lambda)];
};
export const sphereToLonLat = ([x, y, z]: Vec3) => ({
  lon: normalizeBearing((Math.atan2(-z, x) * 180) / Math.PI),
  lat: (Math.asin(clamp(y / Math.hypot(x, y, z), -1, 1)) * 180) / Math.PI,
});
export const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const normalize3 = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  return length > 1e-12 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 0];
};
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (v: Vec3, scale: number): Vec3 => [v[0] * scale, v[1] * scale, v[2] * scale];

export const normalizeQuaternion = (value: Quaternion | undefined): Quaternion => {
  if (!value || ![value.x, value.y, value.z, value.w].every(Number.isFinite))
    return { ...IDENTITY_QUATERNION };
  const length = Math.hypot(value.x, value.y, value.z, value.w);
  if (length < 1e-12) return { ...IDENTITY_QUATERNION };
  return { x: value.x / length, y: value.y / length, z: value.z / length, w: value.w / length };
};
export const conjugateQuaternion = (value: Quaternion): Quaternion => ({
  x: -value.x,
  y: -value.y,
  z: -value.z,
  w: value.w,
});
export const multiplyQuaternions = (left: Quaternion, right: Quaternion): Quaternion =>
  normalizeQuaternion({
    x: left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
    y: left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
    z: left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
    w: left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
  });
export const quaternionFromAxisAngle = (axis: Vec3, angle: number): Quaternion => {
  const unit = normalize3(axis);
  const sine = Math.sin(angle / 2);
  return normalizeQuaternion({
    x: unit[0] * sine,
    y: unit[1] * sine,
    z: unit[2] * sine,
    w: Math.cos(angle / 2),
  });
};
export const quaternionBetweenVectors = (fromValue: Vec3, toValue: Vec3): Quaternion => {
  const from = normalize3(fromValue);
  const to = normalize3(toValue);
  const cosine = clamp(dot3(from, to), -1, 1);
  if (cosine > 1 - 1e-12) return { ...IDENTITY_QUATERNION };
  if (cosine < -1 + 1e-12) {
    const fallback: Vec3 = Math.abs(from[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
    return quaternionFromAxisAngle(normalize3(cross3(from, fallback)), Math.PI);
  }
  const axis = normalize3(cross3(from, to));
  return quaternionFromAxisAngle(axis, Math.acos(cosine));
};
export const rotateVector = (rotation: Quaternion, vector: Vec3): Vec3 => {
  const q = normalizeQuaternion(rotation);
  const u: Vec3 = [q.x, q.y, q.z];
  const uv = cross3(u, vector);
  const uuv = cross3(u, uv);
  return add3(vector, add3(scale3(uv, 2 * q.w), scale3(uuv, 2)));
};

/** Geographic object-space frame. E, M (north), N form a right-handed basis: E × M = N. */
export const localGlobeFrame = (normal: Vec3) => {
  const n = normalize3(normal);
  const { lon } = sphereToLonLat(n);
  const lambda = (lon * Math.PI) / 180;
  // Analytic longitude tangent remains deterministic at both poles.
  const east = normalize3([-Math.sin(lambda), 0, -Math.cos(lambda)] as Vec3);
  const north = normalize3(cross3(n, east));
  return { normal: n, east, north };
};

export const globeOrientationOf = (camera: CameraState) => normalizeQuaternion(camera.globeOrientation);
export const centralGlobePoint = (orientation: Quaternion): Vec3 =>
  normalize3(rotateVector(conjugateQuaternion(normalizeQuaternion(orientation)), [1, 0, 0]));
export const normalizeGlobeFocus = (
  value: GlobeFocus | undefined,
  fallback: Vec3 = [1, 0, 0],
): GlobeFocus => {
  if (!value || ![value.x, value.y, value.z].every(Number.isFinite)) {
    const normalized = normalize3(fallback);
    return { x: normalized[0], y: normalized[1], z: normalized[2] };
  }
  const normalized = normalize3([value.x, value.y, value.z]);
  if (Math.hypot(...normalized) < 0.5) {
    const safe = normalize3(fallback);
    return { x: safe[0], y: safe[1], z: safe[2] };
  }
  return { x: normalized[0], y: normalized[1], z: normalized[2] };
};
export const globeFocusOf = (camera: CameraState): Vec3 => {
  const fallback = centralGlobePoint(globeOrientationOf(camera));
  const focus = normalizeGlobeFocus(camera.globeFocus, fallback);
  return [focus.x, focus.y, focus.z];
};
export const cameraWithGlobeFocus = (camera: CameraState, focus?: Vec3): CameraState => ({
  ...camera,
  globeOrientation: globeOrientationOf(camera),
  globeFocus: normalizeGlobeFocus(
    focus ? { x: focus[0], y: focus[1], z: focus[2] } : camera.globeFocus,
    centralGlobePoint(globeOrientationOf(camera)),
  ),
});

export const slerpQuaternion = (fromValue: Quaternion, toValue: Quaternion, t: number): Quaternion => {
  const from = normalizeQuaternion(fromValue);
  let to = normalizeQuaternion(toValue);
  let cosine = from.x * to.x + from.y * to.y + from.z * to.z + from.w * to.w;
  if (cosine < 0) {
    to = { x: -to.x, y: -to.y, z: -to.z, w: -to.w };
    cosine = -cosine;
  }
  if (cosine > 0.9995)
    return normalizeQuaternion({
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
      w: from.w + (to.w - from.w) * t,
    });
  const angle = Math.acos(clamp(cosine, -1, 1));
  const sine = Math.sin(angle);
  const left = Math.sin((1 - t) * angle) / sine;
  const right = Math.sin(t * angle) / sine;
  return normalizeQuaternion({
    x: from.x * left + to.x * right,
    y: from.y * left + to.y * right,
    z: from.z * left + to.z * right,
    w: from.w * left + to.w * right,
  });
};

export const quaternionRotationVector = (value: Quaternion): Vec3 => {
  let q = normalizeQuaternion(value);
  if (q.w < 0) q = { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
  const halfAngle = Math.acos(clamp(q.w, -1, 1));
  const sine = Math.sin(halfAngle);
  if (Math.abs(sine) < 1e-10) return [0, 0, 0];
  const angle = halfAngle * 2;
  return [(q.x * angle) / sine, (q.y * angle) / sine, (q.z * angle) / sine];
};

export const quaternionFromRotationVector = (value: Vec3): Quaternion => {
  const angle = Math.hypot(...value);
  return angle < 1e-12 ? { ...IDENTITY_QUATERNION } : quaternionFromAxisAngle(value, angle);
};

/** Spherical cubic Bézier evaluated by deterministic shortest-path de Casteljau interpolation. */
export const sphericalBezier = (
  start: Quaternion,
  startControl: Quaternion,
  endControl: Quaternion,
  end: Quaternion,
  t: number,
) => {
  const q01 = slerpQuaternion(start, startControl, t);
  const q12 = slerpQuaternion(startControl, endControl, t);
  const q23 = slerpQuaternion(endControl, end, t);
  return slerpQuaternion(slerpQuaternion(q01, q12, t), slerpQuaternion(q12, q23, t), t);
};

export const globeDistanceForZoom = (zoom: number) => 0.38 + 2.5 / clamp(zoom, 1, 6);

export interface GlobeCameraMatrices {
  viewProjection: Mat4;
  inverseViewProjection: Mat4;
  position: Vec3;
  target: Vec3;
  orientation: Quaternion;
  width: number;
  height: number;
}

const multiply4 = (a: ArrayLike<number>, b: ArrayLike<number>): Mat4 => {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1)
    for (let row = 0; row < 4; row += 1)
      out[column * 4 + row] =
        a[row] * b[column * 4] +
        a[4 + row] * b[column * 4 + 1] +
        a[8 + row] * b[column * 4 + 2] +
        a[12 + row] * b[column * 4 + 3];
  return out;
};
const perspective = (fov: number, aspect: number, near: number, far: number): Mat4 => {
  const f = 1 / Math.tan(fov / 2);
  return new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) / (near - far),
    -1,
    0,
    0,
    (2 * far * near) / (near - far),
    0,
  ]);
};
const lookAt = (eye: Vec3, target: Vec3, upHint: Vec3): Mat4 => {
  const forward = normalize3([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const right = normalize3(cross3(upHint, forward));
  const up = cross3(forward, right);
  return new Float32Array([
    right[0],
    up[0],
    forward[0],
    0,
    right[1],
    up[1],
    forward[1],
    0,
    right[2],
    up[2],
    forward[2],
    0,
    -dot3(right, eye),
    -dot3(up, eye),
    -dot3(forward, eye),
    1,
  ]);
};
const invert4 = (matrix: ArrayLike<number>): Mat4 => {
  const m = Array.from(matrix);
  const out = new Float32Array(16);
  const b00 = m[0] * m[5] - m[1] * m[4],
    b01 = m[0] * m[6] - m[2] * m[4];
  const b02 = m[0] * m[7] - m[3] * m[4],
    b03 = m[1] * m[6] - m[2] * m[5];
  const b04 = m[1] * m[7] - m[3] * m[5],
    b05 = m[2] * m[7] - m[3] * m[6];
  const b06 = m[8] * m[13] - m[9] * m[12],
    b07 = m[8] * m[14] - m[10] * m[12];
  const b08 = m[8] * m[15] - m[11] * m[12],
    b09 = m[9] * m[14] - m[10] * m[13];
  const b10 = m[9] * m[15] - m[11] * m[13],
    b11 = m[10] * m[15] - m[11] * m[14];
  const determinant = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(determinant) < 1e-12) return out;
  const inverse = 1 / determinant;
  out.set([
    (m[5] * b11 - m[6] * b10 + m[7] * b09) * inverse,
    (-m[1] * b11 + m[2] * b10 - m[3] * b09) * inverse,
    (m[13] * b05 - m[14] * b04 + m[15] * b03) * inverse,
    (-m[9] * b05 + m[10] * b04 - m[11] * b03) * inverse,
    (-m[4] * b11 + m[6] * b08 - m[7] * b07) * inverse,
    (m[0] * b11 - m[2] * b08 + m[3] * b07) * inverse,
    (-m[12] * b05 + m[14] * b02 - m[15] * b01) * inverse,
    (m[8] * b05 - m[10] * b02 + m[11] * b01) * inverse,
    (m[4] * b10 - m[5] * b08 + m[7] * b06) * inverse,
    (-m[0] * b10 + m[1] * b08 - m[3] * b06) * inverse,
    (m[12] * b04 - m[13] * b02 + m[15] * b00) * inverse,
    (-m[8] * b04 + m[9] * b02 - m[11] * b00) * inverse,
    (-m[4] * b09 + m[5] * b07 - m[6] * b06) * inverse,
    (m[0] * b09 - m[1] * b07 + m[2] * b06) * inverse,
    (-m[12] * b03 + m[13] * b01 - m[14] * b00) * inverse,
    (m[8] * b03 - m[9] * b01 + m[10] * b00) * inverse,
  ]);
  return out;
};

export const globeCameraMatrices = (
  camera: CameraState,
  width: number,
  height: number,
): GlobeCameraMatrices => {
  // The observer looks at one fixed world-space surface point. The physical
  // sphere rotates beneath it through `orientation`; camera Pitch never
  // participates in the object transform or its manipulation frame.
  const orientation = globeOrientationOf(camera);
  const focus = globeFocusOf(camera);
  const target = normalize3(rotateVector(orientation, focus));
  const north = normalize3(rotateVector(orientation, localGlobeFrame(focus).north));
  const pitch = (clamp(camera.pitch ?? 0, MIN_CAMERA_PITCH, MAX_CAMERA_PITCH) * Math.PI) / 180;
  // Stored 0° is the accepted top/default view. Positive/negative Pitch tilt
  // the eye symmetrically along the local meridian while it continues to look
  // at the fixed target.
  const direction = normalize3(add3(scale3(target, Math.cos(pitch)), scale3(north, -Math.sin(pitch))));
  const cameraUp = normalize3(add3(scale3(north, Math.cos(pitch)), scale3(target, Math.sin(pitch))));
  const position = add3(target, scale3(direction, globeDistanceForZoom(camera.zoom)));
  const view = lookAt(position, target, cameraUp);
  const projection = perspective((45 * Math.PI) / 180, width / height, 0.03, 12);
  const viewProjection = multiply4(projection, view);
  return {
    viewProjection,
    inverseViewProjection: invert4(viewProjection),
    position,
    target,
    orientation,
    width,
    height,
  };
};

const transform4 = (matrix: ArrayLike<number>, x: number, y: number, z: number, w: number) =>
  [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12] * w,
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13] * w,
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14] * w,
    matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15] * w,
  ] as const;

export const projectGlobeObjectPoint = (
  matrices: GlobeCameraMatrices,
  orientation: Quaternion,
  objectPoint: Vec3,
) => {
  const sphere = rotateVector(orientation, objectPoint);
  if (
    dot3(
      sphere,
      normalize3([
        matrices.position[0] - sphere[0],
        matrices.position[1] - sphere[1],
        matrices.position[2] - sphere[2],
      ]),
    ) <= 0
  )
    return null;
  const clip = transform4(matrices.viewProjection, ...sphere, 1);
  if (clip[3] <= 0) return null;
  return {
    x: ((clip[0] / clip[3]) * 0.5 + 0.5) * matrices.width,
    y: (1 - ((clip[1] / clip[3]) * 0.5 + 0.5)) * matrices.height,
    depth: clip[2] / clip[3],
  };
};

export const projectGlobeLonLat = (matrices: GlobeCameraMatrices, lon: number, lat: number) =>
  projectGlobeObjectPoint(matrices, matrices.orientation, lonLatToSphere(lon, lat));

const globeScreenRay = (matrices: GlobeCameraMatrices, screenX: number, screenY: number) => {
  const x = (screenX / matrices.width) * 2 - 1;
  const y = 1 - (screenY / matrices.height) * 2;
  const near = transform4(matrices.inverseViewProjection, x, y, -1, 1);
  const far = transform4(matrices.inverseViewProjection, x, y, 1, 1);
  const origin: Vec3 = [near[0] / near[3], near[1] / near[3], near[2] / near[3]];
  const direction = normalize3([
    far[0] / far[3] - origin[0],
    far[1] / far[3] - origin[1],
    far[2] / far[3] - origin[2],
  ]);
  return { origin, direction };
};

export interface GlobeScreenContact {
  world: Vec3;
  object: Vec3;
  onSphere: boolean;
}

/**
 * Frozen-camera virtual trackball contact. Outside the visible silhouette the
 * closest ray approach is normalized onto the rim, avoiding a discontinuity
 * or an unbounded rotation when pointer capture continues beyond the ball.
 */
export const globeScreenContact = (
  matrices: GlobeCameraMatrices,
  screenX: number,
  screenY: number,
  extendToRim = true,
): GlobeScreenContact | null => {
  const { origin, direction } = globeScreenRay(matrices, screenX, screenY);
  const b = 2 * dot3(origin, direction);
  const c = dot3(origin, origin) - 1;
  const discriminant = b * b - 4 * c;
  let world: Vec3;
  let onSphere = discriminant >= 0;
  if (onSphere) {
    const root = Math.sqrt(discriminant);
    const distance = Math.min(...[(-b - root) / 2, (-b + root) / 2].filter((value) => value > 0));
    if (!Number.isFinite(distance)) onSphere = false;
    else world = normalize3(add3(origin, scale3(direction, distance)));
  }
  if (!onSphere) {
    if (!extendToRim) return null;
    const closestDistance = Math.max(0, -dot3(origin, direction));
    world = normalize3(add3(origin, scale3(direction, closestDistance)));
    if (Math.hypot(...world) < 0.5) return null;
  }
  const object = normalize3(rotateVector(conjugateQuaternion(matrices.orientation), world!));
  return { world: world!, object, onSphere };
};

export const intersectGlobeScreenRay = (matrices: GlobeCameraMatrices, screenX: number, screenY: number) => {
  const contact = globeScreenContact(matrices, screenX, screenY, false);
  return contact ? sphereToLonLat(contact.object) : null;
};

export const slerpLonLat = (
  from: { lon: number; lat: number },
  to: { lon: number; lat: number },
  t: number,
) => {
  const a = lonLatToSphere(from.lon, from.lat),
    b = lonLatToSphere(to.lon, to.lat);
  const angle = Math.acos(clamp(dot3(a, b), -1, 1));
  if (angle < 1e-8) return from;
  const sine = Math.sin(angle),
    left = Math.sin((1 - t) * angle) / sine,
    right = Math.sin(t * angle) / sine;
  return sphereToLonLat(normalize3(add3(scale3(a, left), scale3(b, right))));
};

export const interpolateGlobeCamera = (
  from: CameraState,
  to: CameraState,
  progress: number,
  preset: TransitionPreset,
  _type: TransitionType,
): CameraState => {
  const t = easeCameraProgress(progress, preset);
  const zoom = from.zoom * Math.pow(to.zoom / from.zoom, t);
  const fromFocus = globeFocusOf(from);
  const toFocus = globeFocusOf(to);
  const focusAngle = Math.acos(clamp(dot3(fromFocus, toFocus), -1, 1));
  const focus =
    focusAngle < 1e-8
      ? fromFocus
      : normalize3(
          add3(
            scale3(fromFocus, Math.sin((1 - t) * focusAngle) / Math.sin(focusAngle)),
            scale3(toFocus, Math.sin(t * focusAngle) / Math.sin(focusAngle)),
          ),
        );
  return roundCamera({
    x: interpolateNumber(from.x, to.x, t),
    y: interpolateNumber(from.y, to.y, t),
    zoom,
    bearing: interpolateBearing(from.bearing, to.bearing, t),
    pitch: interpolateNumber(from.pitch ?? 0, to.pitch ?? 0, t),
    globeOrientation: slerpQuaternion(globeOrientationOf(from), globeOrientationOf(to), t),
    globeFocus: { x: focus[0], y: focus[1], z: focus[2] },
  });
};
