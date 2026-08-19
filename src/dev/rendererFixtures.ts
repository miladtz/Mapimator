import { createLayer, createProject, type CameraState, type Layer, type Project } from '../core/project';
import { EXPORT_FRAME_HEIGHT, EXPORT_FRAME_WIDTH } from '../core/frameRenderer';

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
    width: EXPORT_FRAME_WIDTH,
    height: EXPORT_FRAME_HEIGHT,
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

export function createTenSecondProjectFixture(): Project {
  const project = createRendererTransitionProject();
  project.metadata.name = 'Persisted ten second project';
  const first = structuredClone(project.views[0]);
  const second = structuredClone(project.views[1]);
  first.id = 'ten-view-1';
  first.name = 'Regional overview';
  first.holdDuration = 2;
  first.transitionDuration = 1;
  first.layers = first.layers
    .filter((layer) => layer.type === 'region' || layer.type === 'text')
    .map((layer) => ({ ...layer, opacity: layer.type === 'text' ? 1 : layer.opacity }));
  second.id = 'ten-view-2';
  second.name = 'Camera move and arrow';
  second.holdDuration = 2;
  second.transitionDuration = 1;
  second.layers = second.layers.filter((layer) => layer.type !== 'geo-effect');
  const thirdLayers = structuredClone(project.views[1].layers);
  const english = thirdLayers.find((layer) => layer.id === 'milestone-english');
  if (english) english.visible = false;
  const route = { ...createLayer('route'), id: 'ten-route', name: 'Final route' };
  thirdLayers.push(route);
  project.views = [
    first,
    second,
    {
      id: 'ten-view-3',
      name: 'Impact and visibility change',
      holdDuration: 4,
      transitionDuration: 0,
      transitionPreset: 'cinematic',
      camera: { x: -310, y: -48, zoom: 1.58 },
      layers: thirdLayers,
      thumbnailColor: '#5a312b',
    },
  ];
  project.layers = structuredClone(thirdLayers);
  return project;
}

export function createThirtySecondProjectFixture(): Project {
  const project = createTenSecondProjectFixture();
  project.metadata.name = 'Thirty second stability project';
  const finalLayers = structuredClone(project.layers);
  finalLayers.push(
    { ...createLayer('pin', 2), id: 'thirty-pin', text: 'Baghdad' },
    { ...createLayer('shape', 3), id: 'thirty-shape', opacity: 0.55 },
    {
      ...createLayer('geo-effect', 4),
      id: 'thirty-hotspot',
      name: 'Hotspot',
      geoEffectType: 'hotspot',
      color: '#f3b43f',
    },
  );
  const cameras: CameraState[] = [
    { x: -90, y: 30, zoom: 1.02 },
    { x: -145, y: 10, zoom: 1.14 },
    { x: -205, y: -12, zoom: 1.28 },
    { x: -260, y: -34, zoom: 1.42 },
    { x: -205, y: 4, zoom: 1.25 },
    { x: -125, y: 24, zoom: 1.08 },
  ];
  project.views = cameras.map((camera, index) => {
    const layers = structuredClone(finalLayers).map((layer, layerIndex) => ({
      ...layer,
      visible: !(index % 2 === 1 && layerIndex === 2),
      opacity: Math.max(0.25, layer.opacity - index * 0.04),
      x: layer.x + index * (layerIndex % 2 ? 10 : -7),
      y: layer.y + index * (layerIndex % 2 ? -5 : 8),
    }));
    return {
      id: `thirty-view-${index + 1}`,
      name: `Stability View ${index + 1}`,
      holdDuration: index === cameras.length - 1 ? 5 : 3,
      transitionDuration: index === cameras.length - 1 ? 0 : 2,
      transitionPreset: index % 2 ? 'cinematic' : 'smooth',
      camera,
      layers,
      thumbnailColor: index % 2 ? '#49315f' : '#28415a',
    } as const;
  });
  project.layers = structuredClone(project.views.at(-1)?.layers ?? finalLayers);
  return project;
}
