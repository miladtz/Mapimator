import { invoke } from '@tauri-apps/api/core';
import type { MapMode } from '../components/OfflineMap';
import type { Project } from './project';
import { renderProjectRgbaSequence } from './frameRenderer';
import { compileViews } from './viewCompiler';
import { projectExportSettings, validateExportSettings, type ExportVideoSettings } from './exportPresets';

export type ReferenceEncoder = 'libx264' | 'h264_nvenc';
export type ExportStatus =
  'idle' | 'preparing' | 'rendering' | 'finalizing' | 'completed' | 'cancelled' | 'failed';

export interface ExportProgressState {
  status: ExportStatus;
  currentFrame: number;
  totalFrames: number;
  percentage: number;
  encoderLabel?: string;
}

export interface ProjectVideoExportOptions {
  encoder?: ReferenceEncoder | 'auto';
  settings?: ExportVideoSettings;
  mapMode?: MapMode;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgressState) => void;
}

export interface ProjectVideoExportResult {
  duration: number;
  fps: number;
  totalFrames: number;
  elapsedMs: number;
  renderMs: number;
  ipcWriteMs: number;
  finalizationMs: number;
  encoder: ReferenceEncoder;
  encoderLabel: string;
  fallbackUsed: boolean;
  native: {
    framesWritten: number;
    stderr: string;
  };
}

interface EncoderProbeResult {
  encoder: ReferenceEncoder;
  displayName: string;
  diagnostics: string;
}

class NativeExportError extends Error {
  constructor(readonly diagnostics: string) {
    super(diagnostics.split(/\r?\n/, 1)[0] || 'Native video export failed.');
    this.name = 'NativeExportError';
  }
}

let exportActive = false;

const abortError = () => new DOMException('Video export was cancelled.', 'AbortError');

const invokeNative = async <T>(command: string, args?: Record<string, unknown> | Uint8Array) => {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new NativeExportError(String(error));
  }
};

export async function cancelProjectVideoExport() {
  await invoke('abort_project_export').catch(() => undefined);
}

export async function exportProjectVideo(
  project: Project,
  outputPath: string,
  options: ProjectVideoExportOptions = {},
): Promise<ProjectVideoExportResult> {
  if (exportActive) throw new Error('A video export is already active.');
  const duration = compileViews(project.views).duration;
  if (duration <= 0) throw new Error('The project must contain a View sequence with a positive duration.');

  const settings = validateExportSettings(options.settings ?? projectExportSettings(project));
  exportActive = true;
  const totalFrames = Math.ceil(duration * settings.fps);
  let reportedFrame = 0;
  let reportedPercentage = 0;
  const emit = (progress: ExportProgressState) => {
    reportedFrame = Math.max(reportedFrame, progress.currentFrame);
    reportedPercentage = Math.max(reportedPercentage, progress.percentage);
    options.onProgress?.({
      ...progress,
      currentFrame: reportedFrame,
      percentage: reportedPercentage,
    });
  };
  const abortListener = () => void cancelProjectVideoExport();
  options.signal?.addEventListener('abort', abortListener, { once: true });

  try {
    options.signal?.throwIfAborted();
    emit({ status: 'preparing', currentFrame: 0, totalFrames, percentage: 0 });
    const requestedEncoder = options.encoder ?? 'auto';
    const probe =
      requestedEncoder === 'auto'
        ? await invokeNative<EncoderProbeResult>('select_h264_encoder')
        : {
            encoder: requestedEncoder,
            displayName: requestedEncoder === 'h264_nvenc' ? 'NVIDIA NVENC' : 'Software H.264',
            diagnostics: '',
          };
    const candidates: EncoderProbeResult[] = [probe];
    if (probe.encoder === 'h264_nvenc')
      candidates.push({ encoder: 'libx264', displayName: 'Software H.264', diagnostics: probe.diagnostics });

    let lastError: unknown;
    for (let attempt = 0; attempt < candidates.length; attempt += 1) {
      const candidate = candidates[attempt];
      options.signal?.throwIfAborted();
      try {
        return await runExportAttempt(
          project,
          outputPath,
          settings,
          candidate,
          attempt > 0,
          options.mapMode ?? 'flat',
          options.signal,
          emit,
        );
      } catch (error) {
        await cancelProjectVideoExport();
        if (options.signal?.aborted) throw abortError();
        lastError = error;
        if (!(error instanceof NativeExportError) || candidate.encoder !== 'h264_nvenc') throw error;
        console.warn('NVENC export failed; retrying with software H.264.', error.diagnostics);
        emit({
          status: 'preparing',
          currentFrame: 0,
          totalFrames,
          percentage: 0,
          encoderLabel: 'Software H.264',
        });
      }
    }
    throw lastError;
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      emit({ status: 'cancelled', currentFrame: reportedFrame, totalFrames, percentage: reportedPercentage });
      throw abortError();
    }
    emit({ status: 'failed', currentFrame: reportedFrame, totalFrames, percentage: reportedPercentage });
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortListener);
    exportActive = false;
  }
}

async function runExportAttempt(
  project: Project,
  outputPath: string,
  settings: ExportVideoSettings,
  encoder: EncoderProbeResult,
  fallbackUsed: boolean,
  mapMode: MapMode,
  signal: AbortSignal | undefined,
  emit: (progress: ExportProgressState) => void,
): Promise<ProjectVideoExportResult> {
  const started = performance.now();
  const totalFrames = Math.ceil(compileViews(project.views).duration * settings.fps);
  await invokeNative<void>('start_project_export', {
    outputPath,
    encoder: encoder.encoder,
    width: settings.width,
    height: settings.height,
    fps: settings.fps,
  });
  emit({
    status: 'rendering',
    currentFrame: 0,
    totalFrames,
    percentage: 0,
    encoderLabel: encoder.displayName,
  });
  const sequence = await renderProjectRgbaSequence(
    project,
    async ({ pixels, index }) => {
      signal?.throwIfAborted();
      await invokeNative<void>('write_project_export_frame', pixels);
      const currentFrame = index + 1;
      emit({
        status: 'rendering',
        currentFrame,
        totalFrames,
        percentage: Math.min(99, Math.floor((currentFrame / totalFrames) * 100)),
        encoderLabel: encoder.displayName,
      });
    },
    signal,
    settings,
    mapMode,
  );
  signal?.throwIfAborted();
  emit({
    status: 'finalizing',
    currentFrame: totalFrames,
    totalFrames,
    percentage: 99,
    encoderLabel: encoder.displayName,
  });
  const finalizeStarted = performance.now();
  const native = await invokeNative<ProjectVideoExportResult['native']>('finish_project_export');
  const finalizationMs = performance.now() - finalizeStarted;
  const result = {
    ...sequence,
    elapsedMs: performance.now() - started,
    renderMs: sequence.renderMs,
    ipcWriteMs: sequence.consumeMs,
    finalizationMs,
    encoder: encoder.encoder,
    encoderLabel: encoder.displayName,
    fallbackUsed,
    native,
  };
  emit({
    status: 'completed',
    currentFrame: totalFrames,
    totalFrames,
    percentage: 100,
    encoderLabel: encoder.displayName,
  });
  return result;
}
