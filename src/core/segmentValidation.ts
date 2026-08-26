import type { SegmentLayerAnimation } from './project';

export interface SegmentWarning {
  level: 'info' | 'warning';
  message: string;
}

export interface TransitionLayerValidationInput {
  /** Project layer ids included in the source View. */
  sourceMemberIds: ReadonlySet<string>;
  /** Whether this layer is included in the Transition. */
  transitionIncluded: boolean;
  /** Project layer ids included in the destination View. */
  destMemberIds: ReadonlySet<string>;
  /** Layer id being validated. */
  layerId: string;
  /** The transition's animation config for this layer (if any). */
  anim: SegmentLayerAnimation | undefined;
  /** Transition segment duration, used to detect lifecycle truncation. */
  transitionDuration?: number;
}

/**
 * Lightweight semantic validation of a transition-owned layer configuration.
 * These are advisories — the configuration is never silently rewritten. Odd
 * combinations produce a warning plus deterministic behavior.
 *
 * Operates purely on segment MEMBERSHIP (usage configs) and animation config —
 * Layer visual state is canonical in Project.layers and never relevant here.
 */
export const validateTransitionLayer = (input: TransitionLayerValidationInput): SegmentWarning[] => {
  const { sourceMemberIds, transitionIncluded, destMemberIds, layerId, anim } = input;
  const warnings: SegmentWarning[] = [];

  const inSource = sourceMemberIds.has(layerId);
  const inDest = destMemberIds.has(layerId);

  if (anim && !transitionIncluded) {
    warnings.push({
      level: 'info',
      message: 'Enable this layer for the transition to configure animation.',
    });
    return warnings;
  }

  if (!transitionIncluded) {
    if (inSource && inDest) {
      warnings.push({
        level: 'warning',
        message:
          'Layer is hidden during this transition but visible in both Views; it will disappear when the transition starts and reappear at the View boundary.',
      });
    }
    return warnings;
  }

  // Appear enabled while the layer is continuously visible from the source
  // View into the transition: appear has no effect (never replays).
  if (anim?.appearEnabled && inSource) {
    warnings.push({
      level: 'info',
      message:
        'Layer is already visible when the transition starts; Appear has no effect. Turn it off unless you intend a replay.',
    });
  }

  // Wipe Out while the destination View still contains the layer: it will hide
  // before the boundary, then the next View shows it again.
  if (anim?.wipeEnabled && inDest) {
    warnings.push({
      level: 'warning',
      message:
        'This layer is also visible in the next View. Wipe Out will hide it before the View boundary, then the next View will show it again.',
    });
  }

  // The destination View does not contain the layer: any appear/wipe lifecycle
  // is cut at the View boundary, so part of the animation can never be seen.
  if (!inDest && anim) {
    const appearDuration =
      anim.appearEnabled && !inSource
        ? Math.max(0, anim.appearDelay ?? 0) + Math.max(0.05, anim.appearDuration ?? 0.6)
        : 0;
    const lifecycleDuration =
      appearDuration +
      Math.max(0, anim.layerHoldDuration ?? 0) +
      (anim.wipeEnabled ? Math.max(0.05, anim.wipeDuration ?? 0.5) : 0);
    if (lifecycleDuration > (input.transitionDuration ?? 0)) {
      warnings.push({
        level: 'warning',
        message:
          'Animation extends beyond this transition, but the layer is not included in the next View. The remaining animation will be cut at the View boundary.',
      });
    }
  }

  return warnings;
};

export interface ViewLayerValidationInput {
  /** Whether this layer is included in the View. */
  viewIncluded: boolean;
  /** The View's animation config for this layer (if any). */
  anim: SegmentLayerAnimation | undefined;
  /** View Hold duration in seconds (for lifecycle-overflow warning). */
  holdDuration: number;
}

/**
 * Semantic validation for a View-hold layer animation.  View animations are
 * segment-scoped lifecycles that run from the hold start.
 */
export const validateViewLayer = (input: ViewLayerValidationInput): SegmentWarning[] => {
  const { viewIncluded, anim, holdDuration } = input;
  const warnings: SegmentWarning[] = [];

  if (anim && !viewIncluded) {
    warnings.push({
      level: 'info',
      message: 'Enable this layer for the View to configure animation.',
    });
    return warnings;
  }
  if (!anim || !viewIncluded) return warnings;

  const appearDuration = anim.appearEnabled
    ? Math.max(0, anim.appearDelay ?? 0) + Math.max(0.05, anim.appearDuration ?? 0.6)
    : 0;
  const lifecycle =
    appearDuration +
    Math.max(0, anim.layerHoldDuration ?? 0) +
    (anim.wipeEnabled ? Math.max(0.05, anim.wipeDuration ?? 0.5) : 0);
  if (lifecycle > Math.max(0, holdDuration)) {
    warnings.push({
      level: 'warning',
      message:
        'Animation lifecycle is longer than this View Hold; the remaining animation will be cut at the View boundary.',
    });
  }
  return warnings;
};
