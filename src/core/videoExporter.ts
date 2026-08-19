import { invoke } from '@tauri-apps/api/core';
import type { Project } from './project';
import { renderProjectRgbaSequence } from './frameRenderer';
import { compileViews } from './viewCompiler';

export type ReferenceEncoder = 'libx264' | 'h264_nvenc';

export interface ProjectVideoExportResult {
  duration: number;
  fps: number;
  totalFrames: number;
  elapsedMs: number;
  native: {
    framesWritten: number;
    stderr: string;
  };
}

export async function exportProjectVideo(
  project: Project,
  outputPath: string,
  encoder: ReferenceEncoder = 'libx264',
): Promise<ProjectVideoExportResult> {
  if (compileViews(project.views).duration <= 0)
    throw new Error('The project must contain a View sequence with a positive duration.');
  await invoke('start_project_export', { outputPath, encoder });
  const started = performance.now();
  try {
    const sequence = await renderProjectRgbaSequence(project, async ({ pixels }) => {
      await invoke('write_project_export_frame', pixels);
    });
    const native = await invoke<ProjectVideoExportResult['native']>('finish_project_export');
    return { ...sequence, elapsedMs: performance.now() - started, native };
  } catch (error) {
    await invoke('abort_project_export').catch(() => undefined);
    throw error;
  }
}
