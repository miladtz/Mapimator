import { createRoot } from 'react-dom/client';
import interFontUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import vazirmatnArabicFontUrl from '@fontsource-variable/vazirmatn/files/vazirmatn-arabic-wght-normal.woff2?url';
import { MapScene } from '../components/OfflineMap';
import {
  MAP_STYLES,
  createLayer,
  createProject,
  type CameraState,
  type Layer,
  type Project,
} from './project';
import { compileViews, evaluateProjectAtTime } from './viewCompiler';

export const MILESTONE_FRAME_WIDTH = 1920;
export const MILESTONE_FRAME_HEIGHT = 1080;

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
  if (width !== MILESTONE_FRAME_WIDTH || height !== MILESTONE_FRAME_HEIGHT)
    throw new Error('Renderer milestones support exactly 1920x1080.');

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
  width = MILESTONE_FRAME_WIDTH,
  height = MILESTONE_FRAME_HEIGHT,
) {
  return renderProjectFrameCanvas(project, time, width, height, canvasToPng);
}

export async function renderProjectFrameRgba(
  project: Project,
  time: number,
  width = MILESTONE_FRAME_WIDTH,
  height = MILESTONE_FRAME_HEIGHT,
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

export async function renderProjectFrameSequence(
  project: Project,
  consumeFrame: (frame: RenderedProjectFrame) => void | Promise<void>,
): Promise<RenderedProjectSequence> {
  if (project.canvas.fps !== 30) throw new Error('Renderer milestone 2 supports exactly 30fps.');
  if (project.canvas.width !== MILESTONE_FRAME_WIDTH || project.canvas.height !== MILESTONE_FRAME_HEIGHT)
    throw new Error('Renderer milestone 2 supports exactly 1920x1080.');

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
  consumeFrame: (frame: Omit<RenderedProjectFrame, 'blob'> & { pixels: Uint8Array }) => void | Promise<void>,
): Promise<RenderedProjectSequence> {
  if (project.canvas.fps !== 30) throw new Error('Renderer milestone 3 supports exactly 30fps.');
  if (project.canvas.width !== MILESTONE_FRAME_WIDTH || project.canvas.height !== MILESTONE_FRAME_HEIGHT)
    throw new Error('Renderer milestone 3 supports exactly 1920x1080.');

  const duration = compileViews(project.views).duration;
  const totalFrames = Math.ceil(duration * project.canvas.fps);
  for (let index = 0; index < totalFrames; index += 1) {
    const time = index / project.canvas.fps;
    const pixels = await renderProjectFrameRgba(project, time);
    await consumeFrame({ pixels, index, time, totalFrames });
  }
  return { duration, fps: project.canvas.fps, totalFrames };
}

export function createRendererMilestoneProject(): Project {
  const camera: CameraState = { x: -72, y: 26, zoom: 1.12 };
  const region: Layer = { ...createLayer('region'), id: 'milestone-region', countryId: 'iran' };
  const arrow: Layer = {
    ...createLayer('arrow'),
    id: 'milestone-arrow',
    x: 510,
    y: 338,
    x2: 675,
    y2: 282,
  };
  const english: Layer = {
    ...createLayer('text'),
    id: 'milestone-english',
    name: 'English label',
    text: 'Iraq',
    x: 585,
    y: 218,
    fontSize: 25,
    textLanguage: 'english',
    textDirection: 'ltr',
  };
  const persian: Layer = {
    ...createLayer('text'),
    id: 'milestone-persian',
    name: 'Persian label',
    text: 'ایران',
    x: 675,
    y: 342,
    fontSize: 30,
    textLanguage: 'persian',
    textDirection: 'rtl',
    numberStyle: 'persian',
  };
  const effect: Layer = {
    ...createLayer('geo-effect'),
    id: 'milestone-impact-pulse',
    x: 650,
    y: 292,
    effectSize: 58,
    effectRepeat: false,
  };
  const project = createProject('Renderer milestone 1');
  project.metadata = {
    name: 'Renderer milestone 1',
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  };
  project.canvas = {
    width: MILESTONE_FRAME_WIDTH,
    height: MILESTONE_FRAME_HEIGHT,
    fps: 30,
    layoutId: 'landscape',
    safeArea: 96,
    showSafeArea: false,
  };
  project.mapSettings = { styleId: 'documentary-dark', labelLanguage: 'both' };
  project.layers = [region, arrow, english, persian, effect];
  project.views = [
    {
      id: 'milestone-view',
      name: 'Milestone state',
      holdDuration: 3,
      transitionDuration: 0,
      transitionPreset: 'linear',
      camera,
      layers: structuredClone(project.layers),
      thumbnailColor: '#28415a',
    },
  ];
  return project;
}

export function createRendererTransitionProject(): Project {
  const project = createRendererMilestoneProject();
  project.metadata = {
    name: 'Renderer milestone 2',
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  };

  const firstLayers = structuredClone(project.layers);
  const secondLayers = structuredClone(project.layers);
  const firstRegion = firstLayers.find((layer) => layer.id === 'milestone-region');
  const secondRegion = secondLayers.find((layer) => layer.id === 'milestone-region');
  const firstArrow = firstLayers.find((layer) => layer.id === 'milestone-arrow');
  const secondArrow = secondLayers.find((layer) => layer.id === 'milestone-arrow');
  const secondEnglish = secondLayers.find((layer) => layer.id === 'milestone-english');
  const firstPersian = firstLayers.find((layer) => layer.id === 'milestone-persian');
  const secondPersian = secondLayers.find((layer) => layer.id === 'milestone-persian');
  const firstEffect = firstLayers.find((layer) => layer.id === 'milestone-impact-pulse');
  const secondEffect = secondLayers.find((layer) => layer.id === 'milestone-impact-pulse');

  if (
    !firstRegion ||
    !secondRegion ||
    !firstArrow ||
    !secondArrow ||
    !secondEnglish ||
    !firstPersian ||
    !secondPersian ||
    !firstEffect ||
    !secondEffect
  )
    throw new Error('The deterministic transition fixture is incomplete.');

  firstRegion.opacity = 0.35;
  secondRegion.opacity = 0.9;
  Object.assign(firstArrow, { x: 470, y: 355, x2: 610, y2: 305 });
  Object.assign(secondArrow, { x: 570, y: 330, x2: 790, y2: 235 });
  Object.assign(secondEnglish, { x: 635, y: 190 });
  firstPersian.opacity = 0;
  Object.assign(secondPersian, { x: 735, y: 305, opacity: 1 });
  Object.assign(firstEffect, { x: 610, y: 320, opacity: 0.35 });
  Object.assign(secondEffect, { x: 755, y: 250, opacity: 1 });

  project.layers = structuredClone(secondLayers);
  project.views = [
    {
      id: 'milestone-transition-from',
      name: 'Transition start',
      holdDuration: 0,
      transitionDuration: 2,
      transitionPreset: 'linear',
      camera: { x: -120, y: 38, zoom: 1.04 },
      layers: firstLayers,
      thumbnailColor: '#28415a',
    },
    {
      id: 'milestone-transition-to',
      name: 'Transition end',
      holdDuration: 0.1,
      transitionDuration: 0,
      transitionPreset: 'linear',
      camera: { x: -245, y: -18, zoom: 1.4 },
      layers: secondLayers,
      thumbnailColor: '#49315f',
    },
  ];
  return project;
}
