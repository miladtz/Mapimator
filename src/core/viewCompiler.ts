import type {
  CameraState,
  Layer,
  MapMode,
  Project,
  SegmentLayerAnimation,
  Transition,
  View,
} from './project';
import {
  hasConsistentViewMapMode,
  transitionAnimOf,
  transitionLayerConfigsOf,
  transitionLayersOf,
  transitionMemberIds,
  viewAnimOf,
  viewLayersOf,
  viewMemberIds,
} from './project';
import { applyRouteEvaluation } from './routes';
import { easeCameraProgress, interpolateCamera } from './camera';
import type { CameraTransitionType } from './camera';
import { interpolateGlobeCamera } from './globeMath';
import { interpolateCameraChainTransition } from './cameraContinuity';
import { textMapZoomScale } from './textLayers';
import { supportsDrawShape } from './shapes';

export type CompiledSegment =
  | { kind: 'view'; id: string; view: View; start: number; end: number; duration: number }
  | {
      kind: 'transition';
      id: string;
      transition: Transition;
      from: View;
      to: View;
      start: number;
      end: number;
      duration: number;
    };
export interface AnimationSegment {
  from: View;
  to?: View;
  start: number;
  holdEnd: number;
  end: number;
}
export interface AnimationSequence {
  duration: number;
  segments: CompiledSegment[];
}
export interface RenderedProjectState {
  camera: CameraState;
  mapMode: MapMode;
  layers: Layer[];
  activeViewIndex: number;
  transitionProgress: number;
}

export const compileTimeline = (project: Project): AnimationSequence => {
  if (!hasConsistentViewMapMode(project.views))
    throw new Error('Project Views must all use the same map mode.');
  let cursor = 0;
  const segments: CompiledSegment[] = [];
  for (let index = 0; index < project.views.length; index += 1) {
    const view = project.views[index];
    if (Number.isFinite(view.holdDuration) && view.holdDuration > 0) {
      const start = cursor;
      cursor += view.holdDuration;
      segments.push({ kind: 'view', id: view.id, view, start, end: cursor, duration: view.holdDuration });
    }
    const next = project.views[index + 1];
    if (!next) continue;
    const transition = project.transitions.find(
      (candidate) => candidate.fromViewId === view.id && candidate.toViewId === next.id,
    );
    if (!transition) continue;
    if (Number.isFinite(transition.duration) && transition.duration > 0) {
      const start = cursor;
      cursor += transition.duration;
      segments.push({
        kind: 'transition',
        id: transition.id,
        transition,
        from: view,
        to: next,
        start,
        end: cursor,
        duration: transition.duration,
      });
    }
  }
  return { duration: cursor, segments };
};

/** @deprecated New runtime code must call compileTimeline(project). */
export const compileViews = (views: View[]): AnimationSequence =>
  compileTimeline({
    views,
    transitions: views.slice(0, -1).map((view, index) => ({
      id: `legacy-transition-${index}`,
      fromViewId: view.id,
      toViewId: views[index + 1].id,
      duration: view.transitionDuration ?? 0,
      referenceDuration: view.transitionDuration ?? 0,
      speed: 1,
      timingSource: 'duration' as const,
      preset: view.transitionPreset ?? 'smooth',
      type: view.transitionType ?? 'smooth',
      layerConfigs: view.transitionLayerConfigs ?? {},
    })),
    layers: [],
    version: 1,
    metadata: { name: '', createdAt: '', updatedAt: '' },
    canvas: { width: 1920, height: 1080, fps: 30, layoutId: 'landscape', safeArea: 0, showSafeArea: false },
    mapSettings: {
      styleId: 'documentary-dark',
      labelLanguage: 'en',
      onlineLabelPolicyVersion: 1,
      basemapRenderer: 'legacy',
      onlineStyleId: 'liberty',
    },
    assets: [],
    animation: {},
    exportSettings: {},
  });

interface LayerLifecyclePhase {
  /** Opacity multiplier applied on top of the layer's own opacity. */
  opacityMul: number;
  visible: boolean;
  segmentLocalTime: number;
  wipeOpacityMul?: number;
  /** Transient pop/drop scale (pins only, render-time). */
  popScale?: number;
  /** Transient screen-space drop Y offset (pins only, render-time). */
  dropY?: number;
}

export const regionAppearanceCompleteTime = (anim: SegmentLayerAnimation) =>
  Math.max(0, anim.regionDrawingDelay ?? 0) +
  Math.max(0, anim.regionDrawingDuration ?? 1.5) +
  Math.max(0, anim.regionFillingDelay ?? 0) +
  Math.max(0, anim.regionFillingDuration ?? 1.5);

export const wholeAppearanceCompleteTime = (anim: SegmentLayerAnimation) => {
  if (!anim.appearEnabled) return 0;
  const genericComplete = Math.max(0, anim.appearDelay ?? 0) + Math.max(0.05, anim.appearDuration ?? 0.6);
  const regionComplete = anim.regionEffect === 'draw-border' ? regionAppearanceCompleteTime(anim) : 0;
  return Math.max(genericComplete, regionComplete);
};

export const regionWipeTiming = (anim: SegmentLayerAnimation) => {
  const appearanceCompleteTime = wholeAppearanceCompleteTime(anim);
  const wipeStart = appearanceCompleteTime + Math.max(0, anim.wipeDelay ?? 0);
  return {
    appearanceCompleteTime,
    wipeStart,
    wipeEnd: wipeStart + Math.max(0, anim.wipeDuration ?? 1.5),
  };
};

export const regionWipeProgress = (anim: SegmentLayerAnimation, segmentLocalTime: number) => {
  const { wipeStart, wipeEnd } = regionWipeTiming(anim);
  if (segmentLocalTime < wipeStart) return 0;
  if (wipeEnd === wipeStart) return 1;
  return Math.max(0, Math.min(1, (segmentLocalTime - wipeStart) / (wipeEnd - wipeStart)));
};

/**
 * Evaluate a segment-owned layer's animation lifecycle at absolute sequence
 * time. `segmentStart` is the absolute time the View Hold / Transition begins.
 *
 * Timeline (T = segmentStart):
 *   appear     [T + appearDelay, appearEnd)
 *   layer hold [appearEnd, appearEnd + layerHoldDuration)
 *   wipe out   [layerHoldEnd, layerHoldEnd + wipeDuration)
 *
 * For transitions, `entering` means the layer was NOT included in the source
 * View (absent → present); a continuously present layer never replays appear.
 * View-hold lifecycles always run from the hold start (a segment-scoped
 * animation effect), so pass entering=true.  Timing is fully independent of
 * the camera transition duration; segment membership is authoritative at the
 * boundary (handled by the caller).
 */
const layerLifecycle = (
  layer: Layer,
  anim: SegmentLayerAnimation,
  _entering: boolean,
  time: number,
  segmentStart: number,
): LayerLifecyclePhase => {
  const segmentLocalTime = Math.max(0, time - segmentStart);
  const appearEnabled = Boolean(anim.appearEnabled);
  const regionDraw = layer.type === 'region' && anim.regionEffect === 'draw-border';
  const appearanceCompleteTime = wholeAppearanceCompleteTime(anim);
  const appearDelay = appearEnabled ? (regionDraw ? 0 : Math.max(0, anim.appearDelay ?? 0)) : 0;
  const appearDuration = appearEnabled
    ? regionDraw
      ? Math.max(0.0001, appearanceCompleteTime)
      : Math.max(0.05, anim.appearDuration ?? 0.6)
    : 0;
  const appearStart = segmentStart + appearDelay;
  const appearEnd = appearStart + appearDuration;
  const layerHoldEnd =
    segmentStart + appearanceCompleteTime + (regionDraw ? 0 : Math.max(0, anim.layerHoldDuration ?? 0));
  const wipeEnabled = Boolean(anim.wipeEnabled);
  const wipeStart = layerHoldEnd + Math.max(0, anim.wipeDelay ?? 0);
  const wipeDuration = wipeEnabled ? Math.max(0, anim.wipeDuration ?? (regionDraw ? 1.5 : 0.5)) : 0;
  const wipeEnd = wipeStart + wipeDuration;
  const type = anim.appearType ?? 'fade';
  const isAnimatedSymbol = layer.type === 'pin' || layer.type === 'text' || layer.type === 'shape';

  const evalWipe = (): LayerLifecyclePhase => {
    if (!wipeEnabled) return { opacityMul: 1, visible: true, segmentLocalTime, wipeOpacityMul: 1 };
    if (time < wipeStart) return { opacityMul: 1, visible: true, segmentLocalTime, wipeOpacityMul: 1 };
    if (time >= wipeEnd) return { opacityMul: 0, visible: false, segmentLocalTime, wipeOpacityMul: 0 };
    const w = (time - wipeStart) / wipeDuration;
    const wipeOpacityMul = 1 - w;
    return { opacityMul: wipeOpacityMul, visible: true, segmentLocalTime, wipeOpacityMul };
  };

  if (appearEnabled) {
    if (time < appearStart) return { opacityMul: 0, visible: false, segmentLocalTime, wipeOpacityMul: 1 };
    if (time >= appearEnd) return evalWipe();
    const progress = (time - appearStart) / appearDuration;
    const eased =
      type === 'fade' || type === 'draw-shape' ? progress : easeCameraProgress(progress, 'ease-out');
    return {
      opacityMul: eased,
      visible: progress > 0,
      segmentLocalTime,
      wipeOpacityMul: 1,
      popScale:
        isAnimatedSymbol && type === 'pop'
          ? 0.85 + 0.15 * eased
          : isAnimatedSymbol && type === 'drop'
            ? 0.97 + 0.03 * eased
            : undefined,
      dropY: isAnimatedSymbol && type === 'drop' ? -16 * (1 - eased) : undefined,
    };
  }
  return evalWipe();
};

/** Merge a lifecycle phase into a layer clone (transients are render-only). */
const applyPhaseToLayer = (
  layer: Layer,
  phase: LayerLifecyclePhase,
  projectTime = 0,
  animation?: SegmentLayerAnimation,
  cameraZoom = 1,
) => {
  const authoredOpacity = layer.opacity;
  layer.pinSceneOpacity = phase.opacityMul;
  layer.opacity = layer.opacity * phase.opacityMul;
  layer.visible = phase.visible;
  if (layer.type === 'region' && animation?.appearEnabled) {
    layer.regionAnimationEnabled = true;
    layer.regionEffect = animation.regionEffect ?? 'fade';
    layer.regionDrawSpeed = animation.regionDrawSpeed ?? 1;
    layer.regionDrawOrder = animation.regionDrawOrder ?? 'before-fill';
    layer.regionDrawingDelay = animation.regionDrawingDelay ?? 0;
    layer.regionDrawingDuration = animation.regionDrawingDuration ?? 1.5;
    layer.regionFillingDelay = animation.regionFillingDelay ?? 0;
    layer.regionFillingDuration = animation.regionFillingDuration ?? 1.5;
    layer.opacity =
      (phase.visible || animation.regionEffect === 'draw-border' ? authoredOpacity : 0) *
      (phase.wipeOpacityMul ?? 1);
    layer.regionEffectProgress = phase.opacityMul;
    layer.regionEffectTime = animation.regionEffect === 'draw-border' ? phase.segmentLocalTime : projectTime;
  }
  if (layer.type === 'route') applyRouteEvaluation(layer, animation, phase.segmentLocalTime);
  if (layer.type === 'text') {
    layer.textRenderScale = textMapZoomScale(animation, cameraZoom);
    layer.textAnimationScale = phase.popScale ?? 1;
    layer.textDropOffsetY = phase.dropY ?? 0;
    layer.textOrientation = animation?.textOrientation ?? 'face-camera';
    layer.textScaleWithMapZoom = Boolean(animation?.textScaleWithMapZoom);
  }
  if (layer.type === 'shape') {
    const drawing =
      supportsDrawShape(layer.shapeKind) && animation?.appearEnabled && animation.appearType === 'draw-shape';
    const pathWipe = ['polyline', 'polygon', 'free-draw', 'arrow'].includes(layer.shapeKind ?? '');
    layer.shapePathProgress = drawing ? phase.opacityMul : pathWipe ? (phase.wipeOpacityMul ?? 1) : 1;
    layer.shapeAnimationScale = phase.popScale ?? 1;
    layer.shapeDropOffsetY = phase.dropY ?? 0;
    layer.shapeOrientation =
      layer.shapeKind === 'arrow' ? (animation?.shapeOrientation ?? 'flat-on-map') : 'flat-on-map';
    if (drawing || (pathWipe && animation?.wipeEnabled)) layer.opacity = authoredOpacity;
  }
  if (phase.popScale !== undefined) layer.pinPopScale = phase.popScale;
  else delete layer.pinPopScale;
  if (phase.dropY !== undefined) layer.pinDropOffsetY = phase.dropY;
  else delete layer.pinDropOffsetY;
};

/**
 * New-model continuation: while a View holds, an appear animation from the
 * immediately previous transition may still be running. It continues ONLY for
 * layers that belong to BOTH the previous transition and the current View
 * (segment membership is authoritative — no phantom layers). The configured
 * appear, hold, and wipe lifecycle may cross the boundary; the destination
 * View's own lifecycle takes over when that continuation completes. Returns
 * the set of layer ids whose
 * continuation is still active (their View-hold lifecycle is deferred).
 */
const segmentMemberIds = (segment: CompiledSegment | undefined): Set<string> => {
  if (!segment) return new Set<string>();
  return segment.kind === 'view' ? viewMemberIds(segment.view) : transitionMemberIds(segment.transition);
};

const applyContinuingTransitionAnimations = (
  layers: Layer[],
  segments: CompiledSegment[],
  currentIndex: number,
  time: number,
  cameraZoom: number,
): Set<string> => {
  const continued = new Set<string>();
  const prevSeg = segments[currentIndex - 1];
  if (!prevSeg) return continued;
  if (prevSeg.kind !== 'transition') return continued;
  const prevTransIds = transitionMemberIds(prevSeg.transition);
  const curIds = new Set(layers.map((layer) => layer.id));
  // Entering state comes from the previous ACTIVE temporal segment. A
  // zero-Hold View is only a camera anchor and is deliberately absent here.
  const sourceMembers = segmentMemberIds(segments[currentIndex - 2]);
  const transitionStart = prevSeg.start;
  for (const layer of layers) {
    if (!prevTransIds.has(layer.id) || !curIds.has(layer.id)) continue;
    const anim = transitionAnimOf(prevSeg.transition, layer.id);
    if (!anim || (!anim.appearEnabled && !anim.wipeEnabled)) continue;
    const entering = !sourceMembers.has(layer.id);
    const appearDuration = anim.appearEnabled ? wholeAppearanceCompleteTime(anim) : 0;
    const lifecycleEnd =
      transitionStart +
      appearDuration +
      Math.max(0, anim.layerHoldDuration ?? 0) +
      (anim.wipeEnabled ? Math.max(0.05, anim.wipeDuration ?? 0.5) : 0);
    if (time >= lifecycleEnd) continue;
    applyPhaseToLayer(
      layer,
      layerLifecycle(layer, anim, entering, time, transitionStart),
      time,
      anim,
      cameraZoom,
    );
    continued.add(layer.id);
  }
  return continued;
};

/**
 * The single deterministic project-time evaluator shared by editor Preview,
 * thumbnails, and Export.
 *
 * Resolution flow:
 *   sequence time → compiled timeline → active segment
 *     ├── View Hold:     project layers included in the View + View animation
 *     │                  lifecycle (+ continuation from the previous transition)
 *     └── Transition:    project layers included in the Transition + Transition
 *                        animation lifecycle
 *
 * Layer VISUAL state always comes from Project.layers — the one canonical
 * definition. Segment configs contribute only membership + animation.
 */
export const evaluateProjectAtTime = (project: Project, time: number): RenderedProjectState => {
  const sequence = compileTimeline(project);
  const timelineTime = Math.max(0, Math.min(sequence.duration, time));
  // A segment boundary belongs to the FOLLOWING segment (the source View's
  // transition ends when the next View hold begins); only the exact end of the
  // whole sequence falls back to the final segment.
  let index = sequence.segments.findIndex((s) => timelineTime >= s.start && timelineTime < s.end);
  if (index < 0) index = sequence.segments.length - 1;
  const segment = sequence.segments[Math.max(0, index)];
  if (!segment)
    return {
      camera: project.views.at(-1)?.camera ?? { x: 0, y: 0, zoom: 1 },
      mapMode: project.views.at(-1)?.mapMode ?? 'flat',
      layers: [],
      activeViewIndex: Math.max(0, project.views.length - 1),
      transitionProgress: 0,
    };

  if (segment.kind === 'view') {
    // --- View Hold: project layers included in this View + View lifecycle ---
    const layers = viewLayersOf(project, segment.view);
    const continued = applyContinuingTransitionAnimations(
      layers,
      sequence.segments,
      index,
      timelineTime,
      segment.view.camera.zoom,
    );
    for (const layer of layers) {
      if (continued.has(layer.id)) continue;
      const anim = viewAnimOf(segment.view, layer.id);
      if (!anim) continue;
      // View lifecycles are segment-scoped: they run from the hold start
      // whenever appear is enabled (no replay gating — the View is a new
      // segment context).
      applyPhaseToLayer(
        layer,
        layerLifecycle(layer, anim, true, timelineTime, segment.start),
        timelineTime,
        anim,
        segment.view.camera.zoom,
      );
    }
    return {
      camera: segment.view.camera,
      mapMode: segment.view.mapMode,
      layers,
      activeViewIndex: Math.max(
        0,
        project.views.findIndex((view) => view.id === segment.view.id),
      ),
      transitionProgress: 0,
    };
  }

  // --- Transition segment: project layers included in this Transition ---
  const raw = Math.min(1, Math.max(0, (timelineTime - segment.start) / segment.duration));
  const transitionStartTime = segment.start;
  const transitionType: CameraTransitionType = segment.transition.type;
  const fromIndex = project.views.findIndex((view) => view.id === segment.from.id);
  const camera =
    interpolateCameraChainTransition(project, fromIndex, raw) ??
    (segment.from.mapMode === 'globe'
      ? interpolateGlobeCamera(
          segment.from.camera,
          segment.to.camera,
          raw,
          segment.transition.preset,
          transitionType,
        )
      : interpolateCamera(
          segment.from.camera,
          segment.to.camera,
          raw,
          segment.transition.preset,
          transitionType,
        ));
  const layers = transitionLayersOf(project, segment.transition);
  const sourceMembers = segmentMemberIds(sequence.segments[index - 1]);
  const continued = applyContinuingTransitionAnimations(
    layers,
    sequence.segments,
    index,
    timelineTime,
    camera.zoom,
  );
  const configs = transitionLayerConfigsOf(segment.transition);
  for (const layer of layers) {
    if (continued.has(layer.id)) continue;
    const anim = configs[layer.id]?.animation ?? transitionAnimOf(segment.transition, layer.id);
    if (!anim) continue; // no animation config → render the project state as-is
    const entering = !sourceMembers.has(layer.id);
    applyPhaseToLayer(
      layer,
      layerLifecycle(layer, anim, entering, timelineTime, transitionStartTime),
      timelineTime,
      anim,
      camera.zoom,
    );
  }
  return {
    camera,
    mapMode: segment.from.mapMode,
    layers,
    activeViewIndex: Math.max(
      0,
      project.views.findIndex((view) => view.id === (raw >= 1 ? segment.to.id : segment.from.id)),
    ),
    transitionProgress: raw,
  };
};
