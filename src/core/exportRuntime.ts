import type { Project } from './project';
import type { ExportVideoSettings } from './exportPresets';
import { compileTimeline } from './viewCompiler';

export type H264Encoder = 'libx264' | 'h264_nvenc';

export interface ProjectExportPlan {
  duration: number;
  fps: number;
  totalFrames: number;
  bytesPerFrame: number;
}

export function createProjectExportPlan(project: Project, settings: ExportVideoSettings): ProjectExportPlan {
  const duration = compileTimeline(project).duration;
  if (duration <= 0)
    throw new Error('Project duration is 0 seconds. Add a Transition or View Hold before exporting.');
  const bytesPerFrame = settings.width * settings.height * 4;
  if (!Number.isSafeInteger(bytesPerFrame) || bytesPerFrame <= 0)
    throw new Error('Export frame dimensions produce an invalid RGBA buffer size.');
  return { duration, fps: settings.fps, totalFrames: Math.ceil(duration * settings.fps), bytesPerFrame };
}

export function encoderFallbackOrder(preferred: H264Encoder): H264Encoder[] {
  return preferred === 'h264_nvenc' ? ['h264_nvenc', 'libx264'] : ['libx264'];
}

export function verifyNativeExportResult(result: {
  framesWritten: number;
  outputBytes: number;
  exitCode: number;
}) {
  if (result.exitCode !== 0) throw new Error(`FFmpeg exited with code ${result.exitCode}.`);
  if (result.framesWritten <= 0) throw new Error('FFmpeg received no project frames.');
  if (result.outputBytes <= 0) throw new Error('FFmpeg produced an empty output file.');
}
