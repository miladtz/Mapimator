import { createRoot } from 'react-dom/client';
import interFontUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import vazirmatnArabicFontUrl from '@fontsource-variable/vazirmatn/files/vazirmatn-arabic-wght-normal.woff2?url';
import { MapScene } from '../components/OfflineMap';
import type { MapMode } from '../components/OfflineMap';
import { MAP_STYLES, type Project } from './project';
import { projectExportSettings, validateExportSettings, type ExportVideoSettings } from './exportPresets';
import { compileTimeline, evaluateProjectAtTime } from './viewCompiler';
import { resolveProjectAssetUrls } from './projectAssets';

export const EXPORT_FRAME_WIDTH = 1920;
export const EXPORT_FRAME_HEIGHT = 1080;

const nextPaint = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

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

const inlineComputedStyles = (source: Element, clone: Element) => {
  const computed = getComputedStyle(source);
  const cloneElement = clone as HTMLElement | SVGElement;
  for (const property of computed)
    cloneElement.style.setProperty(property, computed.getPropertyValue(property));
  for (let index = 0; index < source.children.length; index += 1)
    inlineComputedStyles(source.children[index], clone.children[index]);
};

const svgToCanvas = async (svg: SVGSVGElement, width: number, height: number) => {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineComputedStyles(svg, clone);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

  const fontStyles = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  fontStyles.textContent = await getEmbeddedFontStyles();
  clone.prepend(fontStyles);

  const svgBlob = new Blob([new XMLSerializer().serializeToString(clone)], {
    type: 'image/svg+xml;charset=utf-8',
  });
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    image.src = svgUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Unable to create the deterministic frame canvas.');
    context.drawImage(image, 0, 0, width, height);
    return canvas;
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

async function renderProjectFrameCanvas<T>(
  project: Project,
  time: number,
  width: number,
  height: number,
  mapMode: MapMode,
  consumeCanvas: FrameCanvasConsumer<T>,
) {
  validateExportSettings({ width, height, fps: 30 });

  const state = evaluateProjectAtTime(project, time);
  const assetUrls = await resolveProjectAssetUrls(project);
  const style = MAP_STYLES.find((candidate) => candidate.id === project.mapSettings.styleId);
  if (!style) throw new Error(`Unknown map style: ${project.mapSettings.styleId}`);

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
  try {
    root.render(
      <MapScene
        style={style}
        mapMode={mapMode}
        layers={state.layers}
        camera={state.camera}
        labelLanguage={project.mapSettings.labelLanguage}
        width={width}
        height={height}
        viewBox={exportViewBox(width, height)}
        assetUrls={assetUrls}
      />,
    );
    await document.fonts.load('700 36px Inter');
    await document.fonts.load('700 36px Vazirmatn');
    await document.fonts.ready;
    await nextPaint();
    const svg = await waitForSceneSvg(host);
    return await consumeCanvas(await svgToCanvas(svg, width, height));
  } finally {
    root.unmount();
    host.remove();
    freezeStyles.remove();
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

export interface RenderedRgbaSequence extends RenderedProjectSequence {
  renderMs: number;
  consumeMs: number;
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
  for (let index = 0; index < totalFrames; index += 1) {
    signal?.throwIfAborted();
    const time = index / settings.fps;
    const renderStarted = performance.now();
    const pixels = await renderProjectFrameRgba(project, time, settings.width, settings.height, mapMode);
    const frameRenderMs = performance.now() - renderStarted;
    renderMs += frameRenderMs;
    signal?.throwIfAborted();
    const consumeStarted = performance.now();
    await consumeFrame({ pixels, index, time, totalFrames, renderMs: frameRenderMs });
    consumeMs += performance.now() - consumeStarted;
  }
  return { duration, fps: settings.fps, totalFrames, renderMs, consumeMs };
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
  await getEmbeddedFontStyles();
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
  const indexById = new Map(project.views.map((view, index) => [view.id, index]));
  try {
    for (const viewId of viewIds) {
      signal?.throwIfAborted();
      const index = indexById.get(viewId);
      if (index === undefined) continue;
      const segment = sequence.segments[index];
      if (!segment) continue;
      const state = evaluateProjectAtTime(project, segment.start);
      root.render(
        <MapScene
          style={style}
          mapMode={mapMode}
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
      const canvas = await svgToCanvas(svg, width, height);
      signal?.throwIfAborted();
      onThumbnail({ viewId, dataUrl: canvasToJpegDataUrl(canvas) });
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  } finally {
    root.unmount();
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
