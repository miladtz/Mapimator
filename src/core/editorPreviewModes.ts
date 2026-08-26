import type { SegmentRef } from './project';

export type PreviewPlaybackState = 'stopped' | 'playing' | 'paused';
export type EditorInteractionMode = 'project' | 'timeline' | 'preview';
export interface EditorPreviewModeState {
  selectedTimelineEntity: SegmentRef | null;
  previewTime: number | null;
  playbackState: PreviewPlaybackState;
}

export const playPreviewMode = (state: EditorPreviewModeState): EditorPreviewModeState => ({
  ...state,
  previewTime: state.playbackState === 'stopped' || state.previewTime === null ? 0 : state.previewTime,
  playbackState: 'playing',
});
export const pausePreviewMode = (state: EditorPreviewModeState): EditorPreviewModeState => ({
  ...state,
  playbackState: 'paused',
});
export const stopPreviewMode = <T extends EditorPreviewModeState>(state: T): T =>
  ({
    ...state,
    selectedTimelineEntity: null,
    previewTime: null,
    playbackState: 'stopped',
  }) as T;
export const completePreviewMode = stopPreviewMode;
export const scrubPreviewMode = (state: EditorPreviewModeState, time: number): EditorPreviewModeState => ({
  ...state,
  previewTime: Math.max(0, time),
  playbackState: 'paused',
});
export const selectEditingEntity = (
  state: EditorPreviewModeState,
  selectedTimelineEntity: SegmentRef,
): EditorPreviewModeState =>
  state.playbackState === 'stopped' ? { ...state, selectedTimelineEntity } : state;

export function enterProjectMode(state: EditorPreviewModeState): EditorPreviewModeState {
  if (state.playbackState !== 'stopped') return state;
  return { ...state, selectedTimelineEntity: null, previewTime: null };
}

export function leaveProjectMode(
  state: EditorPreviewModeState,
  firstViewId: string | null,
): EditorPreviewModeState {
  if (state.playbackState !== 'stopped' || !firstViewId) return { ...state, selectedTimelineEntity: null };
  return {
    ...state,
    selectedTimelineEntity: { kind: 'view', id: firstViewId },
    previewTime: null,
  };
}

export const resolveEditorInteractionMode = (state: EditorPreviewModeState): EditorInteractionMode => {
  if (state.playbackState !== 'stopped') return 'preview';
  return state.selectedTimelineEntity ? 'timeline' : 'project';
};

/** Pure presentation state; Map Mode must not write this checked value to a usage map. */
export const membershipCheckboxPresentation = (
  projectMode: boolean,
  included: boolean,
  hasSelectedSegment: boolean,
) => ({
  checked: projectMode || included,
  disabled: projectMode || !hasSelectedSegment,
});

export const allocationCheckboxDisabled = (
  playbackState: PreviewPlaybackState,
  selectedTimelineEntity: SegmentRef | null,
): boolean => playbackState !== 'stopped' || selectedTimelineEntity === null;

export const isPreviewMode = (playbackState: PreviewPlaybackState): boolean => playbackState !== 'stopped';
export const isMapMode = (playbackState: PreviewPlaybackState, selection: SegmentRef | null): boolean =>
  playbackState === 'stopped' && selection === null;
export const isSegmentEditMode = (
  playbackState: PreviewPlaybackState,
  selection: SegmentRef | null,
): boolean => playbackState === 'stopped' && selection !== null;
export const canEditMembership = isSegmentEditMode;
export const canEditProjectLayer = (playbackState: PreviewPlaybackState): boolean =>
  playbackState === 'stopped';
export const canEditAnimation = (
  playbackState: PreviewPlaybackState,
  selection: SegmentRef | null,
  included: boolean,
): boolean => isSegmentEditMode(playbackState, selection) && included;
export const canToggleMapMode = (playbackState: PreviewPlaybackState): boolean => playbackState === 'stopped';
export const canOpenTransitionPopover = (
  playbackState: PreviewPlaybackState,
  selection: SegmentRef | null,
): boolean => playbackState === 'stopped' && selection?.kind === 'transition';
