import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import interFontUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import vazirmatnArabicFontUrl from '@fontsource-variable/vazirmatn/files/vazirmatn-arabic-wght-normal.woff2?url';
import { MapScene } from '../components/OfflineMap';
import { GlobeOverlay } from '../components/WebGLGlobe';
import type { MapMode } from '../components/OfflineMap';
import { MAP_STYLES, type Project } from './project';
import { projectExportSettings, validateExportSettings, type ExportVideoSettings } from './exportPresets';
import { compileTimeline, evaluateProjectAtTime } from './viewCompiler';
import { resolveProjectAssetUrls } from './projectAssets';
import { GlobeWebGLRenderer } from './globeRenderer';

export const EXPORT_FRAME_WIDTH = 1920;
export const EXPORT_FRAME_HEIGHT = 1080;

const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const waitForSceneSvg = (host: HTMLElement) =>
  new Promise<SVGSVGElement>((resolve, reject) => {
    const mounted = host.querySelector('svg');
    if (mounted) return resolve(mounted);
    const observer = new MutationObserver(() => {
      const svg = host.querySelector('svg');
      if (!svg) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve(svg);
    });
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      reject(new Error('The deterministic map scene did not mount.'));
    }, 5000);
    observer.observe(host, { childList: true, subtree: true });
  });

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });

const fetchFontDataUrl = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load bundled render font: ${response.status}`);
  return blobToDataUrl(await response.blob());
};

let embeddedFontStylesPromise: Promise<string> | undefined;

const getEmbeddedFontStyles = () => {
  embeddedFontStylesPromise ??= Promise.all([
    fetchFontDataUrl(interFontUrl),
    fetchFontDataUrl(vazirmatnArabicFontUrl),
  ]).then(
    ([inter, vazirmatnArabic]) => `
      @font-face { font-family: Inter; src: url('${inter}') format('woff2'); font-weight: 100 900; }
      @font-face { font-family: Vazirmatn; src: url('${vazirmatnArabic}') format('woff2'); font-weight: 100 900; }
    `,
  );
  return embeddedFontStylesPromise;
};

let exportSceneStylesPromise: Promise<string> | undefined;

const getExportSceneStyles = () => {
  exportSceneStylesPromise ??= getEmbeddedFontStyles().then((fonts) => {
    const rules: string[] = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.type !== CSSRule.FONT_FACE_RULE) rules.push(rule.cssText);
        }
      } catch {
        // Bundled styles are same-origin. Ignore any host-injected stylesheet
        // that the browser does not allow the renderer to inspect.
      }
    }
    return `${rules.join('\n')}\n${fonts}\n* { animation: none !important; transition: none !important; }\ntext { text-rendering: geometricPrecision; }\npath { shape-rendering: geometricPrecision; }`;
  });
  return exportSceneStylesPromise;
};

interface RasterTimings {
  serializeMs: number;
  blobMs: number;
  imageDecodeMs: number;
  canvasDrawMs: number;
}

const svgToCanvas = async (
  svg: SVGSVGElement,
  width: number,
  height: number,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  exportStyles: string,
): Promise<RasterTimings> => {
  const serializeStarted = performance.now();
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

  const fontStyles = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  fontStyles.textContent = exportStyles;
  clone.prepend(fontStyles);

  const serialized = new XMLSerializer().serializeToString(clone);
  const serializeMs = performance.now() - serializeStarted;
  const blobStarted = performance.now();
  const svgBlob = new Blob([serialized], {
    type: 'image/svg+xml;charset=utf-8',
  });
  const blobMs = performance.now() - blobStarted;
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    image.src = svgUrl;
    const decodeStarted = performance.now();
    await image.decode();
    const imageDecodeMs = performance.now() - decodeStarted;
    const drawStarted = performance.now();
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return {
      serializeMs,
      blobMs,
      imageDecodeMs,
      canvasDrawMs: performance.now() - drawStarted,
    };
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
};

const canvasToPng = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Unable to encode the deterministic PNG frame.'))),
      'image/png',
    ),
  );

const canvasToJpegDataUrl = (canvas: HTMLCanvasElement, quality = 0.82) =>
  canvas.toDataURL('image/jpeg', quality);

type FrameCanvasConsumer<T> = (canvas: HTMLCanvasElement) => T | Promise<T>;

export interface FrameRenderTimings extends RasterTimings {
  evaluateMs: number;
  sceneMs: number;
  rgbaMs: number;
}

class PreparedFrameRenderer {
  private constructor(
    private readonly project: Project,
    private readonly width: number,
    private readonly height: number,
    private readonly mapMode: MapMode,
    private readonly style: (typeof MAP_STYLES)[number],
    private readonly assetUrls: Record<string, string>,
    private readonly exportStyles: string,
    private readonly host: HTMLDivElement,
    private readonly freezeStyles: HTMLStyleElement,
    private readonly root: ReturnType<typeof createRoot>,
    private readonly canvas: HTMLCanvasElement,
    private readonly context: CanvasRenderingContext2D,
    private readonly globeCanvas: HTMLCanvasElement,
    private readonly globeRenderer: GlobeWebGLRenderer | null,
    private readonly overlayCanvas: HTMLCanvasElement,
    private readonly overlayContext: CanvasRenderingContext2D,
  ) {}

  static async create(project: Project, width: number, height: number, mapMode: MapMode) {
    validateExportSettings({ width, height, fps: 30 });
    const style = MAP_STYLES.find((candidate) => candidate.id === project.mapSettings.styleId);
    if (!style) throw new Error(`Unknown map style: ${project.mapSettings.styleId}`);
    const [assetUrls, exportStyles] = await Promise.all([
      resolveProjectAssetUrls(project),
      getExportSceneStyles(),
    ]);
    await Promise.all([document.fonts.load('700 36px Inter'), document.fonts.load('700 36px Vazirmatn')]);
    await document.fonts.ready;
    const host = document.createElement('div');
    host.className = 'export-frame-scene';
    Object.assign(host.style, {
      position: 'fixed',
      left: '-20000px',
      top: '0',
      width: `${width}px`,
      height: `${height}px`,
      overflow: 'hidden',
    });
    const freezeStyles = document.createElement('style');
    freezeStyles.textContent =
      '.export-frame-scene *, .export-frame-scene *::before { animation: none !important; transition: none !important; }';
    document.head.append(freezeStyles);
    document.body.append(host);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Unable to create the deterministic frame canvas.');
    const globeCanvas = document.createElement('canvas');
    globeCanvas.width = width;
    globeCanvas.height = height;
    const needsGlobe =
      project.views.some((view) => view.mapMode === 'globe') ||
      (project.views.length === 0 && mapMode === 'globe');
    const globeRenderer = needsGlobe ? new GlobeWebGLRenderer(globeCanvas) : null;
    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = width;
    overlayCanvas.height = height;
    const overlayContext = overlayCanvas.getContext('2d');
    if (!overlayContext) throw new Error('Unable to create the Globe overlay canvas.');
    return new PreparedFrameRenderer(
      project,
      width,
      height,
      mapMode,
      style,
      assetUrls,
      exportStyles,
      host,
      freezeStyles,
      createRoot(host),
      canvas,
      context,
      globeCanvas,
      globeRenderer,
      overlayCanvas,
      overlayContext,
    );
  }

  async render<T>(time: number, consumeCanvas: FrameCanvasConsumer<T>) {
    const evaluateStarted = performance.now();
    const state = evaluateProjectAtTime(this.project, time);
    const evaluateMs = performance.now() - evaluateStarted;
    const sceneStarted = performance.now();
    const resolvedMapMode = this.project.views.length > 0 ? state.mapMode : this.mapMode;
    if (resolvedMapMode === 'globe') {
      if (!this.globeRenderer) throw new Error('The deterministic Globe renderer is unavailable.');
      this.globeRenderer.render(state.camera, this.style);
      const pixels = this.globeRenderer.readPixels();
      this.context.putImageData(new ImageData(pixels, this.width, this.height), 0, 0);
      flushSync(() => {
        this.root.render(
          <GlobeOverlay
            width={this.width}
            height={this.height}
            renderer={this.globeRenderer}
            camera={state.camera}
            style={this.style}
            layers={state.layers}
            labelLanguage={this.project.mapSettings.labelLanguage}
            selectedId={null}
          />,
        );
      });
      const svg = this.host.querySelector<SVGSVGElement>('svg');
      if (!svg) throw new Error('The deterministic Globe overlay did not mount.');
      const raster = await svgToCanvas(
        svg,
        this.width,
        this.height,
        this.overlayCanvas,
        this.overlayContext,
        this.exportStyles,
      );
      this.context.drawImage(this.overlayCanvas, 0, 0);
      const rgbaStarted = performance.now();
      const value = await consumeCanvas(this.canvas);
      return {
        value,
        timings: {
          evaluateMs,
          sceneMs: performance.now() - sceneStarted,
          ...raster,
          rgbaMs: performance.now() - rgbaStarted,
        } satisfies FrameRenderTimings,
      };
    }
    flushSync(() => {
      this.root.render(
        <MapScene
          style={this.style}
          mapMode="flat"
          layers={state.layers}
          camera={state.camera}
          labelLanguage={this.project.mapSettings.labelLanguage}
          width={this.width}
          height={this.height}
          viewBox={exportViewBox(this.width, this.height)}
          assetUrls={this.assetUrls}
        />,
      );
    });
    const sceneMs = performance.now() - sceneStarted;
    const svg = this.host.querySelector<SVGSVGElement>('svg');
    if (!svg) throw new Error('The deterministic map scene did not mount.');
    const raster = await svgToCanvas(
      svg,
      this.width,
      this.height,
      this.canvas,
      this.context,
      this.exportStyles,
    );
    const rgbaStarted = performance.now();
    const value = await consumeCanvas(this.canvas);
    return {
      value,
      timings: {
        evaluateMs,
        sceneMs,
        ...raster,
        rgbaMs: performance.now() - rgbaStarted,
      } satisfies FrameRenderTimings,
    };
  }

  dispose() {
    this.root.unmount();
    this.globeRenderer?.dispose();
    this.host.remove();
    this.freezeStyles.remove();
  }
}

async function renderProjectFrameCanvas<T>(
  project: Project,
  time: number,
  width: number,
  height: number,
  mapMode: MapMode,
  consumeCanvas: FrameCanvasConsumer<T>,
) {
  const renderer = await PreparedFrameRenderer.create(project, width, height, mapMode);
  try {
    return (await renderer.render(time, consumeCanvas)).value;
  } finally {
    renderer.dispose();
  }
}

export async function renderProjectFrame(
  project: Project,
  time: number,
  width = EXPORT_FRAME_WIDTH,
  height = EXPORT_FRAME_HEIGHT,
  mapMode: MapMode = 'flat',
) {
  return renderProjectFrameCanvas(project, time, width, height, mapMode, canvasToPng);
}

export async function renderProjectFrameRgba(
  project: Project,
  time: number,
  width = EXPORT_FRAME_WIDTH,
  height = EXPORT_FRAME_HEIGHT,
  mapMode: MapMode = 'flat',
) {
  return renderProjectFrameCanvas(project, time, width, height, mapMode, (canvas) => {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Unable to read the deterministic frame canvas.');
    const pixels = context.getImageData(0, 0, width, height).data;
    return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  });
}

export interface RenderedProjectFrame {
  blob: Blob;
  index: number;
  time: number;
  totalFrames: number;
}

export interface RenderedProjectSequence {
  duration: number;
  fps: number;
  totalFrames: number;
}

/**
 * DEV diagnostic for inspecting adjacent raw renderer frames before H.264.
 * Frames are delivered one at a time so even a diagnostic range remains
 * bounded-memory. This is deliberately not connected to application UI.
 */
export async function renderProjectPngFrameRange(
  project: Project,
  startFrame: number,
  endFrame: number,
  consumeFrame: (frame: RenderedProjectFrame) => void | Promise<void>,
  settings: ExportVideoSettings = projectExportSettings(project),
  mapMode: MapMode = 'flat',
) {
  validateExportSettings(settings);
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame < startFrame)
    throw new Error('PNG diagnostic frame range is invalid.');
  const duration = compileTimeline(project).duration;
  const totalFrames = Math.ceil(duration * settings.fps);
  if (endFrame >= totalFrames) throw new Error(`PNG diagnostic end frame must be below ${totalFrames}.`);
  const renderer = await PreparedFrameRenderer.create(project, settings.width, settings.height, mapMode);
  try {
    for (let index = startFrame; index <= endFrame; index += 1) {
      const time = index / settings.fps;
      const rendered = await renderer.render(time, canvasToPng);
      await consumeFrame({ blob: rendered.value, index, time, totalFrames });
    }
  } finally {
    renderer.dispose();
  }
}

export interface RenderedRgbaSequence extends RenderedProjectSequence {
  prepareMs: number;
  renderMs: number;
  consumeMs: number;
  evaluateMs: number;
  sceneMs: number;
  serializeMs: number;
  blobMs: number;
  imageDecodeMs: number;
  canvasDrawMs: number;
  rgbaMs: number;
}

export async function renderProjectFrameSequence(
  project: Project,
  consumeFrame: (frame: RenderedProjectFrame) => void | Promise<void>,
  settings: ExportVideoSettings = projectExportSettings(project),
  mapMode: MapMode = 'flat',
): Promise<RenderedProjectSequence> {
  validateExportSettings(settings);

  const duration = compileTimeline(project).duration;
  const totalFrames = Math.ceil(duration * settings.fps);
  for (let index = 0; index < totalFrames; index += 1) {
    const time = index / settings.fps;
    const blob = await renderProjectFrame(project, time, settings.width, settings.height, mapMode);
    await consumeFrame({ blob, index, time, totalFrames });
  }
  return { duration, fps: settings.fps, totalFrames };
}

export async function renderProjectRgbaSequence(
  project: Project,
  consumeFrame: (
    frame: Omit<RenderedProjectFrame, 'blob'> & { pixels: Uint8Array; renderMs: number },
  ) => void | Promise<void>,
  signal?: AbortSignal,
  settings: ExportVideoSettings = projectExportSettings(project),
  mapMode: MapMode = 'flat',
): Promise<RenderedRgbaSequence> {
  validateExportSettings(settings);

  const duration = compileTimeline(project).duration;
  const totalFrames = Math.ceil(duration * settings.fps);
  let renderMs = 0;
  let consumeMs = 0;
  const stageTotals: FrameRenderTimings = {
    evaluateMs: 0,
    sceneMs: 0,
    serializeMs: 0,
    blobMs: 0,
    imageDecodeMs: 0,
    canvasDrawMs: 0,
    rgbaMs: 0,
  };
  const prepareStarted = performance.now();
  const renderer = await PreparedFrameRenderer.create(project, settings.width, settings.height, mapMode);
  const prepareMs = performance.now() - prepareStarted;
  try {
    for (let index = 0; index < totalFrames; index += 1) {
      signal?.throwIfAborted();
      const time = index / settings.fps;
      const renderStarted = performance.now();
      const frame = await renderer.render(time, (canvas) => {
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Unable to read the deterministic frame canvas.');
        const pixels = context.getImageData(0, 0, settings.width, settings.height).data;
        return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      });
      const frameRenderMs = performance.now() - renderStarted;
      renderMs += frameRenderMs;
      for (const key of Object.keys(stageTotals) as (keyof FrameRenderTimings)[])
        stageTotals[key] += frame.timings[key];
      signal?.throwIfAborted();
      const consumeStarted = performance.now();
      await consumeFrame({ pixels: frame.value, index, time, totalFrames, renderMs: frameRenderMs });
      consumeMs += performance.now() - consumeStarted;
    }
  } finally {
    renderer.dispose();
  }
  return { duration, fps: settings.fps, totalFrames, prepareMs, renderMs, consumeMs, ...stageTotals };
}
export const VIEW_THUMBNAIL_WIDTH = 320;
export const VIEW_THUMBNAIL_HEIGHT = 180;

export interface ViewThumbnailResult {
  viewId: string;
  dataUrl: string;
}

/**
 * Renders small deterministic map thumbnails for the given Views through the
 * same project evaluator used by Preview and Export. One hidden scene host is
 * reused for the whole batch and the loop yields to the main thread between
 * Views so the editor stays responsive while thumbnails fill in.
 */
export async function renderViewThumbnails(
  project: Project,
  viewIds: string[],
  width = VIEW_THUMBNAIL_WIDTH,
  height = VIEW_THUMBNAIL_HEIGHT,
  mapMode: MapMode = 'flat',
  onThumbnail: (result: ViewThumbnailResult) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (viewIds.length === 0) return;
  const sequence = compileTimeline(project);
  const style = MAP_STYLES.find((candidate) => candidate.id === project.mapSettings.styleId);
  if (!style) throw new Error(`Unknown map style: ${project.mapSettings.styleId}`);
  const assetUrls = await resolveProjectAssetUrls(project);
  const exportStyles = await getExportSceneStyles();
  await document.fonts.load('400 12px Inter');
  await document.fonts.load('400 12px Vazirmatn');
  await document.fonts.ready;

  const host = document.createElement('div');
  host.className = 'export-frame-scene';
  Object.assign(host.style, {
    position: 'fixed',
    left: '-20000px',
    top: '0',
    width: `${width}px`,
    height: `${height}px`,
    overflow: 'hidden',
  });
  const freezeStyles = document.createElement('style');
  freezeStyles.textContent =
    '.export-frame-scene *, .export-frame-scene *::before { animation: none !important; transition: none !important; }';
  document.head.append(freezeStyles);
  document.body.append(host);
  const root = createRoot(host);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Unable to create the deterministic thumbnail canvas.');
  const globeCanvas = document.createElement('canvas');
  globeCanvas.width = width;
  globeCanvas.height = height;
  const needsGlobe =
    project.views.some((view) => view.mapMode === 'globe') ||
    (project.views.length === 0 && mapMode === 'globe');
  const globeRenderer = needsGlobe ? new GlobeWebGLRenderer(globeCanvas) : null;
  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.width = width;
  overlayCanvas.height = height;
  const overlayContext = overlayCanvas.getContext('2d');
  if (!overlayContext) throw new Error('Unable to create the deterministic Globe thumbnail overlay.');
  const indexById = new Map(project.views.map((view, index) => [view.id, index]));
  try {
    for (const viewId of viewIds) {
      signal?.throwIfAborted();
      const index = indexById.get(viewId);
      if (index === undefined) continue;
      const segment = sequence.segments[index];
      if (!segment) continue;
      const state = evaluateProjectAtTime(project, segment.start);
      const resolvedMapMode = project.views.length > 0 ? state.mapMode : mapMode;
      if (resolvedMapMode === 'globe') {
        if (!globeRenderer) throw new Error('The deterministic Globe thumbnail renderer is unavailable.');
        globeRenderer.render(state.camera, style);
        context.putImageData(new ImageData(globeRenderer.readPixels(), width, height), 0, 0);
        root.render(
          <GlobeOverlay
            width={width}
            height={height}
            renderer={globeRenderer}
            camera={state.camera}
            style={style}
            layers={state.layers}
            labelLanguage={project.mapSettings.labelLanguage}
            selectedId={null}
          />,
        );
        await nextPaint();
        const overlay = await waitForSceneSvg(host);
        await svgToCanvas(overlay, width, height, overlayCanvas, overlayContext, exportStyles);
        context.drawImage(overlayCanvas, 0, 0);
        signal?.throwIfAborted();
        onThumbnail({ viewId, dataUrl: canvasToJpegDataUrl(canvas) });
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        continue;
      }
      root.render(
        <MapScene
          style={style}
          mapMode="flat"
          layers={state.layers}
          camera={state.camera}
          labelLanguage={project.mapSettings.labelLanguage}
          width={width}
          height={height}
          viewBox={exportViewBox(width, height)}
          assetUrls={assetUrls}
        />,
      );
      await nextPaint();
      await document.fonts.ready;
      const svg = await waitForSceneSvg(host);
      await svgToCanvas(svg, width, height, canvas, context, exportStyles);
      signal?.throwIfAborted();
      onThumbnail({ viewId, dataUrl: canvasToJpegDataUrl(canvas) });
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  } finally {
    root.unmount();
    globeRenderer?.dispose();
    host.remove();
    freezeStyles.remove();
  }
}

const exportViewBox = (width: number, height: number) => {
  const sceneWidth = 1000;
  const sceneHeight = 560;
  const targetAspect = width / height;
  const sceneAspect = sceneWidth / sceneHeight;
  if (targetAspect < sceneAspect) {
    const fittedWidth = sceneHeight * targetAspect;
    return `${(sceneWidth - fittedWidth) / 2} 0 ${fittedWidth} ${sceneHeight}`;
  }
  const fittedHeight = sceneWidth / targetAspect;
  return `0 ${(sceneHeight - fittedHeight) / 2} ${sceneWidth} ${fittedHeight}`;
};
