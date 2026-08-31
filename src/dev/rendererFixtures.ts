import {
  createLayer,
  createProject,
  createTransition,
  createView,
  type CameraState,
  type Layer,
  type Project,
} from '../core/project';
import { EXPORT_FRAME_HEIGHT, EXPORT_FRAME_WIDTH } from '../core/frameRenderer';

const fixtureTransitionDurations = new Map<string, number>();
const makeView = (
  project: Project,
  id: string,
  name: string,
  camera: CameraState,
  included: string[],
  holdDuration: number,
  transitionDuration: number,
) => {
  const view = {
    ...createView(
      name,
      project.layers.filter((layer) => included.includes(layer.id)),
      camera,
      project.layers,
    ),
    id,
    holdDuration,
  };
  fixtureTransitionDurations.set(id, transitionDuration);
  return view;
};
const configureTransitions = (project: Project): Project => ({
  ...project,
  views: project.views,
  transitions: project.views.slice(0, -1).map((view, index) => ({
    ...createTransition(view.id, project.views[index + 1].id, project.layers),
    duration: fixtureTransitionDurations.get(view.id) ?? 0,
    layerConfigs: Object.fromEntries(
      project.layers.map((layer) => [
        layer.id,
        {
          included:
            index < project.views.length - 1 &&
            Boolean(
              view.layerConfigs[layer.id]?.included ||
              project.views[index + 1].layerConfigs[layer.id]?.included,
            ),
        },
      ]),
    ),
  })),
});

export function createRendererMilestoneProject(): Project {
  const layers: Layer[] = [
    { ...createLayer('region'), id: 'milestone-region', countryId: 'iran' },
    { ...createLayer('arrow'), id: 'milestone-arrow', x: 510, y: 338, x2: 675, y2: 282 },
    {
      ...createLayer('text'),
      id: 'milestone-english',
      name: 'English label',
      text: 'Iraq',
      x: 585,
      y: 218,
      fontSize: 25,
      textLanguage: 'english',
      textDirection: 'ltr',
    },
    {
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
    },
    {
      ...createLayer('geo-effect'),
      id: 'milestone-impact-pulse',
      x: 650,
      y: 292,
      effectSize: 58,
      effectRepeat: false,
    },
  ];
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
  project.mapSettings = {
    styleId: 'documentary-dark',
    labelLanguage: 'both',
    onlineLabelPolicyVersion: 1,
    basemapRenderer: 'legacy',
    onlineStyleId: 'liberty',
  };
  project.layers = layers;
  project.views = [
    makeView(
      project,
      'milestone-view',
      'Milestone state',
      { x: -72, y: 26, zoom: 1.12 },
      layers.map((layer) => layer.id),
      3,
      0,
    ),
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
  const ids = project.layers.map((layer) => layer.id);
  project.views = [
    makeView(
      project,
      'milestone-transition-from',
      'Transition start',
      { x: -120, y: 38, zoom: 1.04 },
      ids.filter((id) => id !== 'milestone-persian'),
      0,
      2,
    ),
    makeView(
      project,
      'milestone-transition-to',
      'Transition end',
      { x: -245, y: -18, zoom: 1.4 },
      ids,
      0.1,
      0,
    ),
  ];
  return configureTransitions(project);
}

export function createTenSecondProjectFixture(): Project {
  const project = createRendererTransitionProject();
  project.metadata.name = 'Persisted ten second project';
  project.layers.push({ ...createLayer('route'), id: 'ten-route', name: 'Final route' });
  const ids = project.layers.map((layer) => layer.id);
  project.views = [
    makeView(
      project,
      'ten-view-1',
      'Regional overview',
      { x: -120, y: 38, zoom: 1.04 },
      ['milestone-region', 'milestone-english', 'milestone-persian'],
      2,
      1,
    ),
    makeView(
      project,
      'ten-view-2',
      'Camera move and arrow',
      { x: -245, y: -18, zoom: 1.4 },
      ids.filter((id) => id !== 'milestone-impact-pulse' && id !== 'ten-route'),
      2,
      1,
    ),
    makeView(
      project,
      'ten-view-3',
      'Impact and visibility change',
      { x: -310, y: -48, zoom: 1.58 },
      ids.filter((id) => id !== 'milestone-english'),
      4,
      0,
    ),
  ];
  return configureTransitions(project);
}

export function createThirtySecondProjectFixture(): Project {
  const project = createTenSecondProjectFixture();
  project.metadata.name = 'Thirty second stability project';
  project.layers.push(
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
  const ids = project.layers.map((layer) => layer.id);
  project.views = cameras.map((camera, index) =>
    makeView(
      project,
      `thirty-view-${index + 1}`,
      `Stability View ${index + 1}`,
      camera,
      ids.filter((_, layerIndex) => !(index % 2 === 1 && layerIndex === 2)),
      index === cameras.length - 1 ? 5 : 3,
      index === cameras.length - 1 ? 0 : 2,
    ),
  );
  return configureTransitions(project);
}
