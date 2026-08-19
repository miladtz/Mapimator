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
import { evaluateProjectAtTime } from './viewCompiler';

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

const inlineComputedStyles = (source: Element, clone: Element) => {
  const computed = getComputedStyle(source);
  const cloneElement = clone as HTMLElement | SVGElement;
  for (const property of computed)
    cloneElement.style.setProperty(property, computed.getPropertyValue(property));
  for (let index = 0; index < source.children.length; index += 1)
    inlineComputedStyles(source.children[index], clone.children[index]);
};

const svgToPng = async (svg: SVGSVGElement, width: number, height: number) => {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineComputedStyles(svg, clone);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

  const [inter, vazirmatnArabic] = await Promise.all([
    fetchFontDataUrl(interFontUrl),
    fetchFontDataUrl(vazirmatnArabicFontUrl),
  ]);
  const fontStyles = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  fontStyles.textContent = `
    @font-face { font-family: Inter; src: url('${inter}') format('woff2'); font-weight: 100 900; }
    @font-face { font-family: Vazirmatn; src: url('${vazirmatnArabic}') format('woff2'); font-weight: 100 900; }
  `;
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
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Unable to encode the deterministic PNG frame.'))),
        'image/png',
      ),
    );
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
};

export async function renderProjectFrame(
  project: Project,
  time: number,
  width = MILESTONE_FRAME_WIDTH,
  height = MILESTONE_FRAME_HEIGHT,
) {
  if (width !== MILESTONE_FRAME_WIDTH || height !== MILESTONE_FRAME_HEIGHT)
    throw new Error('Renderer milestone 1 supports exactly 1920x1080.');

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
    return await svgToPng(svg, width, height);
  } finally {
    root.unmount();
    host.remove();
    freezeStyles.remove();
  }
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
