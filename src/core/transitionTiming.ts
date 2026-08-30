import type { Transition } from './project';

export const MIN_TRANSITION_DURATION = 0;
export const MAX_TRANSITION_DURATION = 30;
export const MIN_TRANSITION_SPEED = 0.001;
export const MAX_TRANSITION_SPEED = 4;
export const TRANSITION_SPEED_STEP = 0.001;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const quantizeSpeed = (value: number) => Math.round(value / TRANSITION_SPEED_STEP) * TRANSITION_SPEED_STEP;
const ceilSpeed = (value: number) =>
  Math.ceil((value - Number.EPSILON) / TRANSITION_SPEED_STEP) * TRANSITION_SPEED_STEP;

export const transitionSpeedRange = (referenceDuration: number) => {
  if (!(referenceDuration > 0)) return { min: MIN_TRANSITION_SPEED, max: MAX_TRANSITION_SPEED };
  return {
    min: ceilSpeed(Math.max(MIN_TRANSITION_SPEED, referenceDuration / MAX_TRANSITION_DURATION)),
    max: MAX_TRANSITION_SPEED,
  };
};

export const transitionDisplaySpeed = (transition: Transition): number | null =>
  transition.duration > 0 ? transition.speed : null;

export const normalizeTransitionTiming = (transition: Transition): Transition => {
  const duration = clamp(
    Number.isFinite(transition.duration) ? transition.duration : 0,
    0,
    MAX_TRANSITION_DURATION,
  );
  const referenceDuration =
    Number.isFinite(transition.referenceDuration) && transition.referenceDuration >= 0
      ? transition.referenceDuration
      : duration;
  const timingSource = transition.timingSource === 'speed' ? 'speed' : 'duration';
  if (!(duration > 0) || !(referenceDuration > 0))
    return { ...transition, duration, referenceDuration, speed: 1, timingSource: 'duration' };
  if (timingSource === 'speed') {
    const range = transitionSpeedRange(referenceDuration);
    const speed = clamp(quantizeSpeed(transition.speed), range.min, range.max);
    return { ...transition, referenceDuration, speed, duration: referenceDuration / speed, timingSource };
  }
  const speed = clamp(
    quantizeSpeed(referenceDuration / duration),
    transitionSpeedRange(referenceDuration).min,
    4,
  );
  return { ...transition, referenceDuration, duration, speed, timingSource };
};

export const setTransitionSpeed = (transition: Transition, input: number): Transition => {
  const current = normalizeTransitionTiming(transition);
  if (!(current.duration > 0) || !(current.referenceDuration > 0) || !Number.isFinite(input)) return current;
  const range = transitionSpeedRange(current.referenceDuration);
  const speed = clamp(quantizeSpeed(input), range.min, range.max);
  return { ...current, speed, duration: current.referenceDuration / speed, timingSource: 'speed' };
};

export const setTransitionDuration = (transition: Transition, input: number): Transition => {
  const current = normalizeTransitionTiming(transition);
  if (!Number.isFinite(input)) return current;
  const duration = clamp(input, 0, MAX_TRANSITION_DURATION);
  if (duration === 0) return { ...current, duration: 0, speed: 1, timingSource: 'duration' };
  const referenceDuration = current.referenceDuration > 0 ? current.referenceDuration : duration;
  const speed = clamp(
    quantizeSpeed(referenceDuration / duration),
    transitionSpeedRange(referenceDuration).min,
    4,
  );
  return { ...current, referenceDuration, duration, speed, timingSource: 'duration' };
};
