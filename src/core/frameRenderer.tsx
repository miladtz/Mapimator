import { createRoot } from 'react-dom/client';
import interFontUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import vazirmatnArabicFontUrl from '@fontsource-variable/vazirmatn/files/vazirmatn-arabic-wght-normal.woff2?url';
import { MapScene } from '../components/OfflineMap';
import { MAP_STYLES, type Project } from './project';
import { compileViews, evaluateProjectAtTime } from './viewCompiler';

export const EXPORT_FRAME_WIDTH = 1920;
export const EXPORT_FRAME_HEIGHT = 1080;

const nextPaint = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

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

type FrameCanvasConsumer<T> = (canvas: HTMLCanvasElement) => T | Promise<T>;

async function renderProjectFrameCanvas<T>(
  project: Project,
  time: number,
  width: number,
  height: number,
  consumeCanvas: FrameCanvasConsumer<T>,
) {
  if (width !== EXPORT_FRAME_WIDTH || height !== EXPORT_FRAME_HEIGHT)
    throw new Error('Video export supports exactly 1920x1080.');

  const state = evaluateProjectAtTime(project, time);
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
        layers={state.layers}
        camera={state.camera}
        labelLanguage={project.mapSettings.labelLanguage}
        width={width}
        height={height}
      />,
    );
    await document.fonts.load('700 36px Inter');
    await document.fonts.load('700 36px Vazirmatn');
    await document.fonts.ready;
    await nextPaint();
    const svg = host.querySelector('svg');
    if (!svg) throw new Error('The deterministic map scene did not mount.');
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
) {
  return renderProjectFrameCanvas(project, time, width, height, canvasToPng);
}

export async function renderProjectFrameRgba(
  project: Project,
  time: number,
  width = EXPORT_FRAME_WIDTH,
  height = EXPORT_FRAME_HEIGHT,
) {
  return renderProjectFrameCanvas(project, time, width, height, (canvas) => {
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
): Promise<RenderedProjectSequence> {
  if (project.canvas.fps !== 30) throw new Error('Video export supports exactly 30fps.');
  if (project.canvas.width !== EXPORT_FRAME_WIDTH || project.canvas.height !== EXPORT_FRAME_HEIGHT)
    throw new Error('Video export supports exactly 1920x1080.');

  const duration = compileViews(project.views).duration;
  const totalFrames = Math.ceil(duration * project.canvas.fps);
  for (let index = 0; index < totalFrames; index += 1) {
    const time = index / project.canvas.fps;
    const blob = await renderProjectFrame(project, time);
    await consumeFrame({ blob, index, time, totalFrames });
  }
  return { duration, fps: project.canvas.fps, totalFrames };
}

export async function renderProjectRgbaSequence(
  project: Project,
  consumeFrame: (
    frame: Omit<RenderedProjectFrame, 'blob'> & { pixels: Uint8Array; renderMs: number },
  ) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<RenderedRgbaSequence> {
  if (project.canvas.fps !== 30) throw new Error('Video export supports exactly 30fps.');
  if (project.canvas.width !== EXPORT_FRAME_WIDTH || project.canvas.height !== EXPORT_FRAME_HEIGHT)
    throw new Error('Video export supports exactly 1920x1080.');

  const duration = compileViews(project.views).duration;
  const totalFrames = Math.ceil(duration * project.canvas.fps);
  let renderMs = 0;
  let consumeMs = 0;
  for (let index = 0; index < totalFrames; index += 1) {
    signal?.throwIfAborted();
    const time = index / project.canvas.fps;
    const renderStarted = performance.now();
    const pixels = await renderProjectFrameRgba(project, time);
    const frameRenderMs = performance.now() - renderStarted;
    renderMs += frameRenderMs;
    signal?.throwIfAborted();
    const consumeStarted = performance.now();
    await consumeFrame({ pixels, index, time, totalFrames, renderMs: frameRenderMs });
    consumeMs += performance.now() - consumeStarted;
  }
  return { duration, fps: project.canvas.fps, totalFrames, renderMs, consumeMs };
}
