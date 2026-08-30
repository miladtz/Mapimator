import { CANVAS_LAYOUTS, type CanvasLayoutId, type Project } from './project';

export const CUSTOM_LOGICAL_PIXEL_BUDGET = 960 * 540;
export const MIN_CUSTOM_FRAME_DIMENSION = 240;
export const MAX_CUSTOM_FRAME_DIMENSION = 2160;
export const MAX_CUSTOM_FRAME_PIXELS = 2_500_000;

export interface ResolvedProjectFrameFormat {
  id: CanvasLayoutId;
  label: string;
  logicalWidth: number;
  logicalHeight: number;
  exportWidth: number;
  exportHeight: number;
  aspectRatio: number;
  custom: boolean;
}

export const validateCustomFrameDimensions = (width: number, height: number) => {
  if (!Number.isInteger(width) || !Number.isInteger(height))
    throw new Error('Custom frame dimensions must be whole pixels.');
  if (width % 2 !== 0 || height % 2 !== 0)
    throw new Error('Custom frame width and height must be even for H.264 export.');
  if (
    width < MIN_CUSTOM_FRAME_DIMENSION ||
    height < MIN_CUSTOM_FRAME_DIMENSION ||
    width > MAX_CUSTOM_FRAME_DIMENSION ||
    height > MAX_CUSTOM_FRAME_DIMENSION
  )
    throw new Error(
      `Custom frame dimensions must be between ${MIN_CUSTOM_FRAME_DIMENSION} and ${MAX_CUSTOM_FRAME_DIMENSION} pixels.`,
    );
  if (width * height > MAX_CUSTOM_FRAME_PIXELS)
    throw new Error(`Custom frame area must not exceed ${MAX_CUSTOM_FRAME_PIXELS.toLocaleString()} pixels.`);
  return { width, height };
};

/** Stable, window-independent logical scene with the exact custom aspect ratio. */
export const deriveCustomLogicalViewport = (exportWidth: number, exportHeight: number) => {
  validateCustomFrameDimensions(exportWidth, exportHeight);
  const scale = Math.sqrt(CUSTOM_LOGICAL_PIXEL_BUDGET / (exportWidth * exportHeight));
  return {
    width: exportWidth * scale,
    height: exportHeight * scale,
    aspectRatio: exportWidth / exportHeight,
  };
};

export const resolveProjectFrameFormat = (project: Pick<Project, 'canvas'>): ResolvedProjectFrameFormat => {
  if (project.canvas.layoutId === 'custom') {
    const { width: exportWidth, height: exportHeight } = validateCustomFrameDimensions(
      project.canvas.width,
      project.canvas.height,
    );
    const logical = deriveCustomLogicalViewport(exportWidth, exportHeight);
    return {
      id: 'custom',
      label: 'Custom',
      logicalWidth: logical.width,
      logicalHeight: logical.height,
      exportWidth,
      exportHeight,
      aspectRatio: logical.aspectRatio,
      custom: true,
    };
  }
  const preset =
    CANVAS_LAYOUTS.find((candidate) => candidate.id === project.canvas.layoutId) ?? CANVAS_LAYOUTS[0];
  return {
    id: preset.id,
    label: preset.name,
    logicalWidth: preset.logicalWidth,
    logicalHeight: preset.logicalHeight,
    exportWidth: preset.width,
    exportHeight: preset.height,
    aspectRatio: preset.width / preset.height,
    custom: false,
  };
};

export const isProjectFrameFormatLocked = (project: Pick<Project, 'views'>) => project.views.length > 0;

export const projectThumbnailViewport = (
  project: Pick<Project, 'canvas'>,
  maxWidth = 320,
  maxHeight = 180,
) => {
  const format = resolveProjectFrameFormat(project);
  const scale = Math.min(maxWidth / format.logicalWidth, maxHeight / format.logicalHeight);
  return {
    width: Math.max(1, Math.round(format.logicalWidth * scale)),
    height: Math.max(1, Math.round(format.logicalHeight * scale)),
  };
};
