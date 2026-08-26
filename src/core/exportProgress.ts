import type { ExportStatus } from './videoExporter';

export interface ExportTiming {
  elapsedMs: number;
  etaSeconds?: number;
}

const ETA_MIN_ELAPSED_MS = 1500;
const ETA_MIN_FRAMES = 8;

export class ExportProgressEstimator {
  private startedAt = 0;
  private active = false;

  start(now = performance.now()) {
    this.startedAt = now;
    this.active = true;
  }

  reset() {
    this.startedAt = 0;
    this.active = false;
  }

  measure(
    status: ExportStatus,
    completedFrames: number,
    totalFrames: number,
    now = performance.now(),
  ): ExportTiming {
    if (!this.active) this.start(now);
    const elapsedMs = Math.max(0, now - this.startedAt);
    if (status !== 'rendering' || completedFrames < ETA_MIN_FRAMES || elapsedMs < ETA_MIN_ELAPSED_MS)
      return { elapsedMs };
    const throughput = completedFrames / (elapsedMs / 1000);
    if (!Number.isFinite(throughput) || throughput <= 0) return { elapsedMs };
    return {
      elapsedMs,
      etaSeconds: Math.max(0, Math.round(Math.max(0, totalFrames - completedFrames) / throughput)),
    };
  }
}

export function exportPercentage(status: ExportStatus, completedFrames: number, totalFrames: number) {
  if (status === 'completed') return 100;
  if (status === 'finalizing') return 99;
  if (totalFrames <= 0) return 0;
  return Math.min(99, Math.max(0, Math.floor((completedFrames / totalFrames) * 100)));
}

export function formatExportDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${remainder.toString().padStart(2, '0')}s`;
  return `${remainder}s`;
}
