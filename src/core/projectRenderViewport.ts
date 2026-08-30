/**
 * Canonical logical viewport for the online MapLibre scene.
 *
 * Both interactive playback and export render MapLibre against these EXACT
 * logical dimensions.  The zoom, symbol collision, label inventory, and
 * detail hierarchy are all computed against this canonical layout — never
 * against physical output pixels, application window size, or editor panel
 * dimensions.
 *
 * The editor visually scales this canonical viewport into the available
 * panel area via a CSS transform.  MapLibre's internal logical layout
 * always stays at the canonical size.
 */
export interface LogicalViewport {
  width: number;
  height: number;
  aspectRatio: number;
}

/**
 * Canonical MapLibre logical viewport.
 * Fixed, independent of window size, DPR, or output resolution.
 * Maps cleanly to common output resolutions (960×540 → 1920×1080 @ 2×).
 */
const LANDSCAPE_LOGICAL_VIEWPORT: LogicalViewport = {
  width: 960,
  height: 540,
  aspectRatio: 960 / 540,
};

/** Returns the fixed canonical online logical viewport. */
export function projectRenderViewport(project?: Pick<Project, 'canvas'>): LogicalViewport {
  if (!project) return LANDSCAPE_LOGICAL_VIEWPORT;
  const format = resolveProjectFrameFormat(project);
  return { width: format.logicalWidth, height: format.logicalHeight, aspectRatio: format.aspectRatio };
}

export interface FitResult {
  /** Canonical logical viewport width — always fixed. */
  width: number;
  /** Canonical logical viewport height — always fixed. */
  height: number;
  /** CSS display width to fit the canonical viewport into availableWidth × availableHeight. */
  displayWidth: number;
  /** CSS display height to fit the canonical viewport into availableWidth × availableHeight. */
  displayHeight: number;
}

/**
 * Computes the CSS display dimensions to fit the canonical logical viewport
 * inside the available container while preserving the exact aspect ratio.
 *
 * The returned width/height are always the fixed canonical viewport — only
 * displayWidth/displayHeight change to fit the available area.
 */
export function fitProjectViewport(
  viewport: LogicalViewport,
  availableWidth: number,
  availableHeight: number,
): FitResult {
  const { width, height, aspectRatio } = viewport;
  const containerAspect = availableWidth / availableHeight;

  let displayWidth: number;
  let displayHeight: number;
  if (containerAspect > aspectRatio) {
    displayHeight = availableHeight;
    displayWidth = displayHeight * aspectRatio;
  } else {
    displayWidth = availableWidth;
    displayHeight = displayWidth / aspectRatio;
  }

  return { width, height, displayWidth, displayHeight };
}

/** Shared Legacy SVG composition window; interactive, thumbnails and Export use it unchanged. */
export function projectSceneViewBox(viewport: LogicalViewport) {
  const sceneWidth = 1000;
  const sceneHeight = 560;
  const sceneAspect = sceneWidth / sceneHeight;
  if (viewport.aspectRatio < sceneAspect) {
    const fittedWidth = sceneHeight * viewport.aspectRatio;
    return `${(sceneWidth - fittedWidth) / 2} 0 ${fittedWidth} ${sceneHeight}`;
  }
  const fittedHeight = sceneWidth / viewport.aspectRatio;
  return `0 ${(sceneHeight - fittedHeight) / 2} ${sceneWidth} ${fittedHeight}`;
}
import type { Project } from './project';
import { resolveProjectFrameFormat } from './projectFrameFormat';
