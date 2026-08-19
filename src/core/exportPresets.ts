import type { CanvasLayoutId, Project } from './project';

export type ExportFps = 30 | 60;

export interface ExportVideoSettings {
  width: number;
  height: number;
  fps: ExportFps;
}

export interface ExportPreset extends ExportVideoSettings {
  id: string;
  name: string;
  layoutId: CanvasLayoutId;
}

export const EXPORT_PRESETS = [
  {
    id: 'youtube-1080p30',
    name: 'YouTube Landscape',
    width: 1920,
    height: 1080,
    fps: 30,
    layoutId: 'landscape',
  },
  {
    id: 'youtube-1080p60',
    name: 'YouTube Landscape 60',
    width: 1920,
    height: 1080,
    fps: 60,
    layoutId: 'landscape',
  },
  { id: 'youtube-shorts', name: 'YouTube Shorts', width: 1080, height: 1920, fps: 30, layoutId: 'portrait' },
  {
    id: 'instagram-square',
    name: 'Instagram Square',
    width: 1080,
    height: 1080,
    fps: 30,
    layoutId: 'square',
  },
  {
    id: 'instagram-portrait',
    name: 'Instagram Portrait',
    width: 1080,
    height: 1350,
    fps: 30,
    layoutId: 'portrait-4-5',
  },
] as const satisfies readonly ExportPreset[];

export type ExportPresetId = (typeof EXPORT_PRESETS)[number]['id'];

export const DEFAULT_EXPORT_PRESET_ID: ExportPresetId = 'youtube-1080p30';

const supportedProjectSizes = new Set(['1920x1080', '1080x1920', '1080x1080', '1080x1350', '1440x1080']);

export function validateExportSettings(settings: ExportVideoSettings) {
  const key = `${settings.width}x${settings.height}`;
  if (!supportedProjectSizes.has(key)) throw new Error(`Unsupported H.264 export resolution: ${key}.`);
  if (settings.fps !== 30 && settings.fps !== 60) throw new Error(`Unsupported export FPS: ${settings.fps}.`);
  if (settings.fps === 60 && key !== '1920x1080')
    throw new Error('60 FPS export is supported only at 1920x1080.');
  return settings;
}

export const projectExportSettings = (project: Project): ExportVideoSettings =>
  validateExportSettings({
    width: project.canvas.width,
    height: project.canvas.height,
    fps: project.canvas.fps === 60 ? 60 : 30,
  });
