import { invoke } from '@tauri-apps/api/core';
import type { MapMode } from '../components/OfflineMap';
import type { Project } from './project';
import { renderProjectRgbaSequence } from './frameRenderer';
import { projectExportSettings, validateExportSettings, type ExportVideoSettings } from './exportPresets';
import { ExportProgressEstimator, exportPercentage } from './exportProgress';
import {
  createProjectExportPlan,
  encoderFallbackOrder,
  verifyNativeExportResult,
  type H264Encoder,
} from './exportRuntime';

export type ReferenceEncoder = H264Encoder;
export type ExportStatus =
  'idle' | 'preparing' | 'rendering' | 'finalizing' | 'completed' | 'cancelled' | 'failed';

export interface ExportProgressState {
  status: ExportStatus;
  currentFrame: number;
  totalFrames: number;
  percentage: number;
  encoderLabel?: string;
  elapsedMs?: number;
  etaSeconds?: number;
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
  prepareMs: number;
  renderMs: number;
  ipcWriteMs: number;
  finalizationMs: number;
  evaluateMs: number;
  sceneMs: number;
  serializeMs: number;
  blobMs: number;
  imageDecodeMs: number;
  canvasDrawMs: number;
  rgbaMs: number;
  encoder: ReferenceEncoder;
  encoderLabel: string;
  requestedEncoder: ReferenceEncoder;
  fallbackUsed: boolean;
  fallbackReason?: string;
  native: {
    framesWritten: number;
    stderr: string;
    outputBytes: number;
    exitCode: number;
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

const hasNativeExportCause = (error: unknown): boolean =>
  error instanceof NativeExportError ||
  (error instanceof Error &&
    'cause' in error &&
    error.cause !== undefined &&
    hasNativeExportCause(error.cause));

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
  const settings = validateExportSettings(options.settings ?? projectExportSettings(project));
  const plan = createProjectExportPlan(project, settings);
  const duration = plan.duration;
  exportActive = true;
  const totalFrames = plan.totalFrames;
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
    const candidates: EncoderProbeResult[] = encoderFallbackOrder(probe.encoder).map((encoder) =>
      encoder === probe.encoder
        ? probe
        : { encoder, displayName: 'Software H.264', diagnostics: probe.diagnostics },
    );

    let lastError: unknown;
    for (let attempt = 0; attempt < candidates.length; attempt += 1) {
      const candidate = candidates[attempt];
      options.signal?.throwIfAborted();
      try {
        reportedFrame = 0;
        reportedPercentage = 0;
        return await runExportAttempt(
          project,
          outputPath,
          settings,
          candidate,
          probe.encoder,
          attempt > 0,
          options.mapMode ?? 'flat',
          options.signal,
          emit,
        );
      } catch (error) {
        await cancelProjectVideoExport();
        if (options.signal?.aborted) throw abortError();
        lastError = error;
        if (!hasNativeExportCause(error) || candidate.encoder !== 'h264_nvenc') throw error;
        console.warn('NVENC export failed; retrying with software H.264.', error);
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
  requestedEncoder: ReferenceEncoder,
  fallbackUsed: boolean,
  mapMode: MapMode,
  signal: AbortSignal | undefined,
  emit: (progress: ExportProgressState) => void,
): Promise<ProjectVideoExportResult> {
  const started = performance.now();
  const plan = createProjectExportPlan(project, settings);
  const totalFrames = plan.totalFrames;
  const estimator = new ExportProgressEstimator();
  estimator.start(started);
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
    ...estimator.measure('rendering', 0, totalFrames, performance.now()),
  });
  const sequence = await renderProjectRgbaSequence(
    project,
    async ({ pixels, index, time }) => {
      signal?.throwIfAborted();
      const expectedBytes = plan.bytesPerFrame;
      if (pixels.byteLength !== expectedBytes)
        throw new Error(
          `Frame ${index} at ${time.toFixed(6)}s has ${pixels.byteLength} RGBA bytes; expected ${expectedBytes}.`,
        );
      try {
        await invokeNative<void>('write_project_export_frame', pixels);
      } catch (error) {
        throw new Error(`Frame ${index} at ${time.toFixed(6)}s failed: ${String(error)}`, { cause: error });
      }
      const currentFrame = index + 1;
      emit({
        status: 'rendering',
        currentFrame,
        totalFrames,
        percentage: exportPercentage('rendering', currentFrame, totalFrames),
        encoderLabel: encoder.displayName,
        ...estimator.measure('rendering', currentFrame, totalFrames, performance.now()),
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
    ...estimator.measure('finalizing', totalFrames, totalFrames, performance.now()),
  });
  const finalizeStarted = performance.now();
  const native = await invokeNative<ProjectVideoExportResult['native']>('finish_project_export');
  verifyNativeExportResult(native);
  const finalizationMs = performance.now() - finalizeStarted;
  const result = {
    ...sequence,
    elapsedMs: performance.now() - started,
    renderMs: sequence.renderMs,
    ipcWriteMs: sequence.consumeMs,
    finalizationMs,
    encoder: encoder.encoder,
    encoderLabel: encoder.displayName,
    requestedEncoder,
    fallbackUsed,
    fallbackReason: fallbackUsed ? encoder.diagnostics.trim() || 'NVIDIA NVENC startup failed.' : undefined,
    native,
  };
  emit({
    status: 'completed',
    currentFrame: totalFrames,
    totalFrames,
    percentage: 100,
    encoderLabel: encoder.displayName,
    elapsedMs: result.elapsedMs,
  });
  return result;
}
