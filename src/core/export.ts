import { compileViews, evaluateProjectAtTime, type RenderedProjectState } from './viewCompiler';
import type { Project } from './project';

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  format: 'mp4';
  codec: 'h264';
}
export interface RenderFrame {
  index: number;
  time: number;
  state: RenderedProjectState;
}
export interface VideoRenderer {
  exportVideo(project: Project, options: ExportOptions): Promise<void>;
}

export const defaultExportOptions = (project: Project): ExportOptions => ({
  width: project.canvas.width,
  height: project.canvas.height,
  fps: project.canvas.fps,
  format: 'mp4',
  codec: 'h264',
});
export function* deterministicFrames(project: Project, options: ExportOptions): Generator<RenderFrame> {
  const duration = compileViews(project.views).duration;
  for (let index = 0; index < Math.ceil(duration * options.fps); index += 1) {
    const time = index / options.fps;
    yield { index, time, state: evaluateProjectAtTime(project, time) };
  }
}
export const unavailableVideoRenderer: VideoRenderer = {
  async exportVideo() {
    throw new Error(
      'Video export requires the bundled FFmpeg renderer, which is not configured in this build.',
    );
  },
};
