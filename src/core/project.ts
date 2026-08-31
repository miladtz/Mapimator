export type AppLanguage = 'en' | 'fa';
export type MapStyleId = 'documentary-dark' | 'documentary-light' | 'modern' | 'ink' | 'terrain';
export type BasemapRenderer = 'legacy' | 'online';
export type MapLabelLanguageMode = 'en' | 'fa' | 'both' | 'none';
export type OnlineBasemapStyleId = '3d' | 'liberty' | 'dark' | 'bright';
export type LayerType = 'region' | 'pin' | 'text' | 'shape' | 'arrow' | 'image' | 'route' | 'geo-effect';
export type GeoEffectType =
  | 'impact-pulse'
  | 'strike-marker'
  | 'smoke-plume'
  | 'missile-arc'
  | 'front-line'
  | 'territory-expansion'
  | 'hotspot'
  | 'control-zone'
  | 'refugee-flow'
  | 'blockade-line'
  | 'disputed-border'
  | 'influence-zone';
export type TextLanguage = 'auto' | 'persian' | 'english';
export type PinStyle = 'dot' | 'map-pin' | 'location' | 'target' | 'star' | 'circle' | 'custom';
export type PinLabelPosition = 'top' | 'bottom' | 'left' | 'right';
export type PinAppear = 'none' | 'fade' | 'pop';
export type PinAppearType = 'fade' | 'pop' | 'drop';
export type PinCustomAnchor = 'bottom-center' | 'center';
export type TransitionType = 'smooth' | 'pan' | 'zoom' | 'fly-to';
export type WipeType = 'fade-out';
/**
 * Per-layer animation configuration owned by a View OR Transition segment.
 * Segment animations are independent from the camera motion and from each
 * other: the same project Layer may Fade in one View, Drop in a Transition,
 * and have no animation in another.
 *
 * Lifecycle within the segment (segment starts at T):
 *   appear:     [T + appearDelay, T + appearDelay + appearDuration)
 *   layer hold: [appearEnd, appearEnd + layerHoldDuration)
 *   wipe out:   [layerHoldEnd, layerHoldEnd + wipeDuration)
 *
 * All durations are independent of the camera transition duration.
 */
export interface SegmentLayerAnimation {
  /** Enable the entering appear animation. Only meaningful when the layer
   *  is entering this segment (absent from the previous segment); a layer
   *  that is continuously present never replays appear. */
  appearEnabled?: boolean;
  /** Appear animation type (fade/pop/drop). */
  appearType?: PinAppearType;
  /** Delay in seconds before the appear animation starts. */
  appearDelay?: number;
  /** Duration in seconds of the appear animation. */
  appearDuration?: number;
  /** Hold at full state after appear completes, in seconds. */
  layerHoldDuration?: number;
  /** Enable fade-out at the end of the layer lifecycle. */
  wipeEnabled?: boolean;
  /** Wipe animation type. */
  wipeType?: WipeType;
  /** Duration in seconds of the wipe. */
  wipeDuration?: number;
}
export type TransitionPreset =
  'smooth' | 'cinematic' | 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'bezier';
export type TextDirection = 'auto' | 'rtl' | 'ltr';
export type NumberStyle = 'persian' | 'english';
export type ProjectAssetKind = 'image';
export type ProjectImageMediaType = 'image/png' | 'image/jpeg';
export interface ProjectImageAsset {
  id: string;
  kind: ProjectAssetKind;
  filename: string;
  mediaType: ProjectImageMediaType;
  sha256: string;
  size: number;
  width: number;
  height: number;
  packagePath: string;
}
export type ProjectAsset = ProjectImageAsset;
export type CanvasLayoutId = 'landscape' | 'portrait' | 'square' | 'portrait-4-5' | 'classic-4-3' | 'custom';
export interface CanvasLayout {
  id: CanvasLayoutId;
  name: string;
  width: number;
  height: number;
  logicalWidth: number;
  logicalHeight: number;
  safeArea: number;
}
export const CANVAS_LAYOUTS: CanvasLayout[] = [
  {
    id: 'landscape',
    name: 'Landscape 16:9',
    width: 1920,
    height: 1080,
    logicalWidth: 960,
    logicalHeight: 540,
    safeArea: 96,
  },
  {
    id: 'portrait',
    name: 'Portrait 9:16',
    width: 1080,
    height: 1920,
    logicalWidth: 540,
    logicalHeight: 960,
    safeArea: 96,
  },
  {
    id: 'square',
    name: 'Square 1:1',
    width: 1080,
    height: 1080,
    logicalWidth: 720,
    logicalHeight: 720,
    safeArea: 80,
  },
  {
    id: 'portrait-4-5',
    name: 'Portrait 4:5',
    width: 1080,
    height: 1350,
    logicalWidth: 648,
    logicalHeight: 810,
    safeArea: 90,
  },
  {
    id: 'classic-4-3',
    name: 'Classic 4:3',
    width: 1440,
    height: 1080,
    logicalWidth: 800,
    logicalHeight: 600,
    safeArea: 80,
  },
];

export interface MapStylePreset {
  id: MapStyleId;
  name: string;
  landColor: string;
  waterColor: string;
  countryBorderColor: string;
  countryBorderWidth: number;
  countryLabelColor: string;
  backgroundColor: string;
  lakeColor: string;
  riverColor: string;
  coastlineColor: string;
  cityColor: string;
  physicalLabelColor: string;
  continentLabelColor: string;
  texture: 'none' | 'modern' | 'ink' | 'terrain';
}
export interface BasemapCapability {
  id: 'vector' | 'satellite';
  available: boolean;
  source: 'natural-earth' | null;
  reason?: string;
}
export interface Layer {
  id: string;
  type: LayerType;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  color: string;
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  text?: string;
  countryId?: string;
  width?: number;
  height?: number;
  textLanguage?: TextLanguage;
  textDirection?: TextDirection;
  numberStyle?: NumberStyle;
  fontSize?: number;
  geoEffectType?: GeoEffectType;
  effectSize?: number;
  effectDuration?: number;
  effectRepeat?: boolean;
  assetId?: string;
  // Pin-specific appearance. Older projects omit these and inherit deterministic defaults.
  pinStyle?: PinStyle;
  pinSize?: number;
  pinBorderColor?: string;
  pinBorderWidth?: number;
  pinLabelVisible?: boolean;
  pinLabelSize?: number;
  pinLabelOpacity?: number;
  pinLabelColor?: string;
  pinLabelBorderColor?: string;
  pinLabelBorderWidth?: number;
  pinLabelAngle?: number;
  /** @deprecated Read only when migrating pre-angle projects. */
  pinLabelPosition?: PinLabelPosition;
  pinLabelGap?: number;
  pinAppear?: PinAppear;
  /** Enable appear animation. When false/undefined, pin appears instantly. */
  pinAppearEnabled?: boolean;
  /** Appear animation type. */
  pinAppearType?: PinAppearType;
  /** Delay in seconds before appear animation starts. */
  pinAppearDelay?: number;
  /** Duration in seconds of the appear animation. */
  pinAppearDuration?: number;
  /** Custom icon asset ID (content-addressed project asset). */
  pinCustomAssetId?: string;
  /** Anchor point for custom icon. */
  pinCustomAnchor?: PinCustomAnchor;
  /** Apply a deterministic color tint to the custom icon image. */
  pinTintEnabled?: boolean;
  /** Tint color applied to the custom icon image. */
  pinTintColor?: string;
  /** Transient evaluator output (appear/pop scale). Never persisted. */
  pinPopScale?: number;
  /** Transient evaluator output (drop Y offset in screen px). Never persisted. */
  pinDropOffsetY?: number;
  /** Render-only View/Transition appearance multiplier; never authored or persisted. */
  pinSceneOpacity?: number;
}
export interface CameraState {
  x: number;
  y: number;
  zoom: number;
  /** Clockwise degrees from north-up. Legacy projects default to zero. */
  bearing?: number;
  /** Reserved for Milestone 6B. It remains zero in the 6A renderer. */
  pitch?: number;
  /**
   * Globe-only physical sphere orientation. Flat projects omit this field.
   * Components are a normalized quaternion in object-to-world order.
   */
  globeOrientation?: Quaternion;
  /** Globe-only normalized object-local geographic point used as the camera anchor. */
  globeFocus?: GlobeFocus;
}
export interface GlobeFocus {
  x: number;
  y: number;
  z: number;
}
export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}
export const IDENTITY_QUATERNION: Quaternion = { x: 0, y: 0, z: 0, w: 1 };
export type MapMode = 'flat' | 'globe';
/** The first View establishes one renderer mode for the complete sequence. */
export const sequenceMapMode = (project: Pick<Project, 'views'>): MapMode | undefined =>
  project.views[0]?.mapMode;
export const hasConsistentViewMapMode = (views: readonly Pick<View, 'mapMode'>[]) =>
  views.length < 2 || views.every((view) => view.mapMode === views[0]?.mapMode);
/**
 * A View's own configuration for one project Layer, keyed by the stable
 * project layer id. It stores ONLY usage + animation — never copied Layer
 * visual state. Layer visual properties are read from `Project.layers`
 * (the single canonical definition), so changing a Project Layer changes it
 * everywhere it is used.
 */
export interface ViewLayerConfig {
  /** Whether this project Layer is used in this View Hold. */
  included: boolean;
  /** Optional per-layer animation lifecycle during this View Hold. */
  animation?: SegmentLayerAnimation;
}
/**
 * A Transition's own configuration for one project Layer, keyed by the stable
 * project layer id. It stores ONLY usage + animation — never copied Layer
 * visual state. Layer visual properties come from `Project.layers`.
 */
export interface TransitionLayerConfig {
  /** Whether this project Layer exists in this Transition. */
  included: boolean;
  /** Per-layer animation lifecycle config (independent per segment). */
  animation?: SegmentLayerAnimation;
}
export interface View {
  id: string;
  name: string;
  holdDuration: number;
  camera: CameraState;
  /** Canonical renderer mode owned by this temporal camera anchor. */
  mapMode: MapMode;
  /**
   * NEW MODEL: the View's own per-layer configuration, keyed by project layer id.
   * New projects store membership + animation here. Legacy projects omit this
   * and keep `layers` (full clones); helpers below normalize both forms.
   */
  layerConfigs: Record<string, ViewLayerConfig>;
  /**
   * NEW MODEL: the outgoing transition's per-layer configuration, keyed by
   * project layer id. Legacy projects omit this and keep `transitionLayers` +
   * `layerAnimations`.
   */
  /** LEGACY INPUT ONLY: outgoing transition state migrated to Project.transitions. */
  transitionLayerConfigs?: Record<string, TransitionLayerConfig>;
  transitionDuration?: number;
  transitionPreset?: TransitionPreset;
  transitionType?: TransitionType;
  /**
   * LEGACY INPUT ONLY: accepted and removed by project migration. Runtime
   * projects and newly persisted projects never contain Layer snapshots.
   */
  layers?: Layer[];
  /**
   * LEGACY: the outgoing transition's OWN layer membership/state as full
   * Layer clones (committed schema). Kept for migration.
   */
  transitionLayers?: Layer[];
  /** LEGACY: per-layer animation config for the outgoing transition. */
  layerAnimations?: Record<string, SegmentLayerAnimation>;
  thumbnailColor: string;
}
export interface Transition {
  id: string;
  fromViewId: string;
  toViewId: string;
  duration: number;
  referenceDuration: number;
  speed: number;
  timingSource: 'duration' | 'speed';
  preset: TransitionPreset;
  type: TransitionType;
  layerConfigs: Record<string, TransitionLayerConfig>;
}
export interface Project {
  version: 1;
  metadata: { name: string; createdAt: string; updatedAt: string };
  canvas: {
    width: number;
    height: number;
    fps: 24 | 25 | 30 | 50 | 60;
    layoutId: CanvasLayoutId;
    safeArea: number;
    showSafeArea: boolean;
  };
  mapSettings: {
    styleId: MapStyleId;
    labelLanguage: MapLabelLanguageMode;
    onlineLabelPolicyVersion: 1;
    basemapRenderer: BasemapRenderer;
    onlineStyleId: OnlineBasemapStyleId;
  };
  layers: Layer[];
  views: View[];
  transitions: Transition[];
  assets: ProjectAsset[];
  animation: Record<string, never>;
  exportSettings: Record<string, never>;
}

export const MAP_STYLES: MapStylePreset[] = [
  {
    id: 'documentary-dark',
    name: 'Documentary Dark',
    landColor: '#27364b',
    waterColor: '#0b1322',
    countryBorderColor: '#87a4c3',
    countryBorderWidth: 1.2,
    countryLabelColor: '#e7eff9',
    backgroundColor: '#101a2a',
    lakeColor: '#13243a',
    riverColor: '#477aa1',
    coastlineColor: '#9ab4ce',
    cityColor: '#f4c56a',
    physicalLabelColor: '#7396b5',
    continentLabelColor: '#71849a',
    texture: 'none',
  },
  {
    id: 'documentary-light',
    name: 'Documentary Light',
    landColor: '#dfe8ec',
    waterColor: '#b7d6df',
    countryBorderColor: '#537282',
    countryBorderWidth: 1.1,
    countryLabelColor: '#183246',
    backgroundColor: '#edf3f5',
    lakeColor: '#a6cfdb',
    riverColor: '#6aa8bd',
    coastlineColor: '#496c7c',
    cityColor: '#a33c2d',
    physicalLabelColor: '#47788b',
    continentLabelColor: '#80979f',
    texture: 'none',
  },
  {
    id: 'modern',
    name: 'Modern',
    landColor: '#d6e2dc',
    waterColor: '#88b9c6',
    countryBorderColor: '#ffffff',
    countryBorderWidth: 0.85,
    countryLabelColor: '#173a3f',
    backgroundColor: '#8bbbc7',
    lakeColor: '#89becb',
    riverColor: '#5d9fab',
    coastlineColor: '#f4fbf8',
    cityColor: '#e45b45',
    physicalLabelColor: '#296d78',
    continentLabelColor: '#58817c',
    texture: 'modern',
  },
  {
    id: 'ink',
    name: 'Ink',
    landColor: '#e8e0cd',
    waterColor: '#f3eedf',
    countryBorderColor: '#2b2925',
    countryBorderWidth: 0.9,
    countryLabelColor: '#171614',
    backgroundColor: '#f3eedf',
    lakeColor: '#f3eedf',
    riverColor: '#676159',
    coastlineColor: '#171614',
    cityColor: '#8b3028',
    physicalLabelColor: '#71695f',
    continentLabelColor: '#9b9387',
    texture: 'ink',
  },
  {
    id: 'terrain',
    name: 'Terrain',
    landColor: '#9caf7c',
    waterColor: '#8eb9c7',
    countryBorderColor: '#f2ead4',
    countryBorderWidth: 0.8,
    countryLabelColor: '#263222',
    backgroundColor: '#8eb9c7',
    lakeColor: '#76aab9',
    riverColor: '#4f8fa4',
    coastlineColor: '#e9e2c9',
    cityColor: '#9b382d',
    physicalLabelColor: '#416f79',
    continentLabelColor: '#607457',
    texture: 'terrain',
  },
];

export const BASEMAP_CAPABILITIES: BasemapCapability[] = [
  { id: 'vector', available: true, source: 'natural-earth' },
  {
    id: 'satellite',
    available: false,
    source: null,
    reason: 'Requires a separately licensed, versioned offline imagery pyramid.',
  },
];
export const layerLabel: Record<LayerType, string> = {
  region: 'Region',
  pin: 'Pin',
  text: 'Text',
  shape: 'Shape',
  arrow: 'Arrow',
  image: 'Image',
  route: 'Route',
  'geo-effect': 'Geo Effect',
};
export const createLayer = (type: LayerType, offset = 0): Layer => {
  const id = `${type}-${crypto.randomUUID()}`;
  const x = 540 + offset * 18;
  const y = 260 + offset * 15;
  const defaults: Record<LayerType, Partial<Layer>> = {
    region: { name: 'Iran highlight', color: '#e8533e', countryId: 'iran', x: 650, y: 292 },
    pin: {
      name: 'Pin',
      color: '#f3b43f',
      text: '',
      pinStyle: 'location',
      pinSize: 15,
      pinBorderColor: '#ffffff',
      pinBorderWidth: 2.5,
      pinLabelVisible: true,
      pinLabelSize: 12,
      pinLabelOpacity: 1,
      pinLabelColor: '#ffffff',
      pinLabelBorderColor: '#ffffff',
      pinLabelBorderWidth: 1,
      pinLabelAngle: 0,
      pinLabelGap: 2,
      pinAppearEnabled: true,
      pinAppearType: 'fade',
      pinAppearDelay: 0,
      pinAppearDuration: 0.6,
      pinTintEnabled: false,
      pinTintColor: '#e8533e',
    },
    text: {
      name: 'Map headline',
      color: '#ffffff',
      text: 'A NEW CHAPTER',
      x: 500,
      y: 110,
      textLanguage: 'auto',
      textDirection: 'auto',
      numberStyle: 'english',
      fontSize: 19,
    },
    shape: { name: 'Callout shape', color: '#61c4e8', width: 100, height: 55 },
    arrow: { name: 'Advance arrow', color: '#ef694f', x: 560, y: 300, x2: 700, y2: 270 },
    image: { name: 'Image placeholder', color: '#7d9bbb', width: 118, height: 72 },
    route: { name: 'Route', color: '#64d5ba', x: 485, y: 275, x2: 675, y2: 325 },
    'geo-effect': {
      name: 'Impact pulse',
      color: '#ff7159',
      x: 650,
      y: 292,
      geoEffectType: 'impact-pulse',
      effectSize: 44,
      effectDuration: 1.4,
      effectRepeat: true,
    },
  };
  return {
    id,
    type,
    visible: true,
    locked: false,
    opacity: 1,
    color: '#ffffff',
    x,
    y,
    ...defaults[type],
  } as Layer;
};
/**
 * Deterministic defaults for Pin layers. Legacy pins (and any pin missing a
 * field) render exactly as the historical pin: a dot with a white border and
 * a right-side label, screen-relative size.
 */
export const PIN_DEFAULTS = {
  style: 'dot' as PinStyle,
  size: 13,
  borderColor: '#ffffff',
  borderWidth: 3,
  labelVisible: true,
  labelSize: 11,
  labelOpacity: 1,
  labelColor: '#ffffff',
  labelBorderColor: '#ffffff',
  labelBorderWidth: 1,
  labelAngle: 0,
  labelPosition: 'right' as PinLabelPosition,
  labelGap: 5,
  appear: 'fade' as PinAppear,
  appearEnabled: true,
  appearType: 'fade' as PinAppearType,
  appearDelay: 0,
  appearDuration: 0.6,
  tintEnabled: false,
  tintColor: '#e8533e',
};

export const pinStyleOf = (layer: Layer): PinStyle => layer.pinStyle ?? PIN_DEFAULTS.style;
export const pinSizeOf = (layer: Layer): number => layer.pinSize ?? PIN_DEFAULTS.size;
export const normalizePinLabelAngle = (angle: number): number => {
  if (!Number.isFinite(angle)) return 0;
  const normalized = angle % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};
export const pinLabelOffsetOf = (layer: Layer): { x: number; y: number } => {
  const angle = normalizePinLabelAngle(layer.pinLabelAngle ?? PIN_DEFAULTS.labelAngle);
  const radius = layer.pinLabelGap ?? PIN_DEFAULTS.labelGap;
  const radians = (angle * Math.PI) / 180;
  return { x: radius * Math.cos(radians), y: -radius * Math.sin(radians) };
};
export const pinAppearOf = (layer: Layer): PinAppear => layer.pinAppear ?? PIN_DEFAULTS.appear;
export const createProject = (name = 'Untitled map'): Project => {
  const now = new Date().toISOString();
  return {
    version: 1,
    metadata: { name, createdAt: now, updatedAt: now },
    canvas: { width: 1920, height: 1080, fps: 30, layoutId: 'landscape', safeArea: 96, showSafeArea: true },
    mapSettings: {
      styleId: 'documentary-dark',
      labelLanguage: 'en',
      onlineLabelPolicyVersion: 1,
      basemapRenderer: 'online',
      onlineStyleId: 'liberty',
    },
    layers: [],
    views: [],
    transitions: [],
    assets: [],
    animation: {},
    exportSettings: {},
  };
};
export const createView = (
  name: string,
  layers: Layer[],
  camera: CameraState,
  /** When provided, configs are created for ALL project layers (the master
   *  registry).  Layers present in `layers` are marked included=true; all
   *  others included=false.  This guarantees every segment config has an
   *  entry for every project layer ID — the checkbox state is fully explicit. */
  allLayers?: Layer[],
  mapMode: MapMode = 'flat',
): View => {
  const registry = allLayers ?? layers;
  // Backward compatibility: without allLayers, included = layer.visible
  // (old tests and legacy code rely on this).  With allLayers, included
  // means the layer is present in the `layers` array (visible flag ignored).
  const includedIds = allLayers ? new Set(layers.map((l) => l.id)) : undefined;
  return {
    id: `view-${crypto.randomUUID()}`,
    name,
    holdDuration: 0,
    camera: { ...camera },
    mapMode,
    // Usages only — no Layer visual state is copied.  Visual state is read
    // from Project.layers at render time.
    layerConfigs: Object.fromEntries(
      registry.map((layer) => [
        layer.id,
        { included: includedIds ? includedIds.has(layer.id) : layer.visible },
      ]),
    ),
    thumbnailColor: '#28415a',
  };
};
/**
 * Normalized View layer configuration: prefers the new `layerConfigs` model,
 * otherwise derives an equivalent usage record from legacy `layers` clones
 * (included = visible). Returns a fresh record so callers may mutate entries
 * safely. No Layer visual state is stored — only usage + animation.
 */
export const viewLayerConfigsOf = (view: View): Record<string, ViewLayerConfig> => {
  return { ...view.layerConfigs };
};
/**
 * Effective render layer list for a View Hold: the PROJECT definitions of the
 * layers this View includes.  Visual state is resolved from the canonical
 * `Project.layers` registry — never from View snapshots.
 */
export const viewLayersOf = (project: Project, view: View): Layer[] => {
  return project.layers
    .map((layer) => resolveSegmentLayer(project, { kind: 'view', id: view.id }, layer.id))
    .filter((layer): layer is Layer => layer !== null);
};
/** Set of project layer ids allocated to this View. */
export const viewMemberIds = (view: View): Set<string> =>
  new Set(
    Object.entries(viewLayerConfigsOf(view))
      .filter(([, config]) => config.included)
      .map(([id]) => id),
  );
/** View-hold animation config for a layer (or undefined). */
export const viewAnimOf = (view: View, layerId: string): SegmentLayerAnimation | undefined =>
  view.layerConfigs[layerId]?.animation;
/**
 * Normalized transition layer configuration: prefers the new
 * `transitionLayerConfigs` model, otherwise derives an equivalent record from
 * legacy `transitionLayers` + `layerAnimations`. Returns a fresh record.
 */
export const transitionLayerConfigsOf = (transition: Transition): Record<string, TransitionLayerConfig> => {
  return { ...transition.layerConfigs };
};
/**
 * Effective render layer list for a Transition segment: the PROJECT
 * definitions of the layers this transition includes.  Visual state comes
 * from the canonical `Project.layers` registry.
 */
export const transitionLayersOf = (project: Project, transition: Transition): Layer[] => {
  return project.layers
    .map((layer) => resolveSegmentLayer(project, { kind: 'transition', id: transition.id }, layer.id))
    .filter((layer): layer is Layer => layer !== null);
};
/** Set of project layer ids allocated to the outgoing transition. */
export const transitionMemberIds = (transition: Transition): Set<string> =>
  new Set(
    Object.entries(transitionLayerConfigsOf(transition))
      .filter(([, config]) => config.included)
      .map(([id]) => id),
  );
/**
 * Normalize a stored animation config: map legacy field names
 * (`holdDuration` → `layerHoldDuration`, drop `wipeDelay`) so consumers read
 * one shape regardless of which milestone wrote the file.
 */
export const normalizeSegmentAnimation = (
  anim: SegmentLayerAnimation | undefined,
): SegmentLayerAnimation | undefined => {
  if (!anim) return undefined;
  const out = { ...anim } as Record<string, unknown>;
  if (out.layerHoldDuration === undefined && out.holdDuration !== undefined) {
    out.layerHoldDuration = out.holdDuration;
    delete out.holdDuration;
  }
  delete out.wipeDelay;
  return out as SegmentLayerAnimation;
};
/** Animation config for a transition-owned layer (new or legacy model). */
export const transitionAnimOf = (
  transition: Transition,
  layerId: string,
): SegmentLayerAnimation | undefined =>
  normalizeSegmentAnimation(transition.layerConfigs[layerId]?.animation);

export type SegmentRef = { kind: 'view' | 'transition'; id: string };

/** Resolve a canonical Project Layer by stable identity. */
export function getProjectLayer(project: Project, layerId: string): Layer | undefined {
  return project.layers.find((layer) => layer.id === layerId);
}

/** Resolve one segment's usage record without reading visual Layer state. */
export function getSegmentLayerUsage(
  project: Project,
  segment: SegmentRef,
  layerId: string,
): ViewLayerConfig | TransitionLayerConfig | undefined {
  return segment.kind === 'view'
    ? project.views.find((view) => view.id === segment.id)?.layerConfigs[layerId]
    : project.transitions.find((transition) => transition.id === segment.id)?.layerConfigs[layerId];
}

/** Immutably update exactly one View usage. Editor selection/mode state is intentionally outside this model. */
export function setViewLayerIncluded(
  project: Project,
  viewId: string,
  layerId: string,
  included: boolean,
): Project {
  const viewIndex = project.views.findIndex((view) => view.id === viewId);
  if (viewIndex < 0) return project;
  const view = project.views[viewIndex];
  const current = view.layerConfigs[layerId] ?? { included: false };
  if (current.included === included) return project;
  const views = [...project.views];
  views[viewIndex] = {
    ...view,
    layerConfigs: {
      ...view.layerConfigs,
      [layerId]: { ...current, included },
    },
  };
  return { ...project, views };
}

/** Immutably update exactly one Transition usage by stable Transition id. */
export function setTransitionLayerIncluded(
  project: Project,
  transitionId: string,
  layerId: string,
  included: boolean,
): Project {
  const transitionIndex = project.transitions.findIndex((transition) => transition.id === transitionId);
  if (transitionIndex < 0) return project;
  const transition = project.transitions[transitionIndex];
  const current = transition.layerConfigs[layerId] ?? { included: false };
  if (current.included === included) return project;
  const transitions = [...project.transitions];
  transitions[transitionIndex] = {
    ...transition,
    layerConfigs: {
      ...transition.layerConfigs,
      [layerId]: { ...current, included },
    },
  };
  return { ...project, transitions };
}

/** Combine a canonical Project Layer with segment membership for rendering. */
export function resolveSegmentLayer(project: Project, segment: SegmentRef, layerId: string): Layer | null {
  const usage = getSegmentLayerUsage(project, segment, layerId);
  const layer = usage?.included ? getProjectLayer(project, layerId) : undefined;
  return layer ? { ...structuredClone(layer), visible: true } : null;
}
/**
 * Initialize a Transition's layer configs from a source View's configs,
 * covering the full project layer registry.  Layers that the source View
 * includes are carried into the transition as included; all others are
 * included=false.  Existing animation configs on the View's transition
 * are preserved.  Call once when creating a new View (its outgoing
 * transition is the previous View's transition).
 */
export const initTransitionConfigsFromView = (
  sourceView: View,
  allLayers: Layer[],
): Record<string, TransitionLayerConfig> => {
  const viewConfigs = viewLayerConfigsOf(sourceView);
  return Object.fromEntries(
    allLayers.map((layer) => {
      const viewInc = viewConfigs[layer.id]?.included ?? false;
      return [layer.id, { included: viewInc }];
    }),
  );
};
export const createTransition = (
  fromViewId: string,
  toViewId: string,
  layers: Layer[],
  source?: View,
): Transition => ({
  id: `transition-${crypto.randomUUID()}`,
  fromViewId,
  toViewId,
  duration: 2.5,
  referenceDuration: 2.5,
  speed: 1,
  timingSource: 'duration',
  preset: 'smooth',
  type: 'smooth',
  layerConfigs: source
    ? initTransitionConfigsFromView(source, layers)
    : Object.fromEntries(layers.map((layer) => [layer.id, { included: false }])),
});

/** Add one canonical Project Layer and initialize every segment usage as excluded. */
export const addProjectLayer = (project: Project, layer: Layer): Project => ({
  ...project,
  layers: [...project.layers, { ...layer, visible: true }],
  views: project.views.map((view) => ({
    ...view,
    layerConfigs: { ...view.layerConfigs, [layer.id]: { included: false } },
  })),
  transitions: project.transitions.map((transition) => ({
    ...transition,
    layerConfigs: { ...transition.layerConfigs, [layer.id]: { included: false } },
  })),
});
/**
 * Centralized Project-layer deletion.  Removes the layer from the registry
 * and from EVERY View and Transition usage (including animation configs), so
 * Preview/Export never reference a missing layer id.
 */
export const deleteProjectLayer = (project: Project, layerId: string): Project => ({
  ...project,
  layers: project.layers.filter((l) => l.id !== layerId),
  assets: project.assets.filter((asset) =>
    project.layers.some(
      (layer) =>
        layer.id !== layerId &&
        ((layer.type === 'image' && layer.assetId === asset.id) ||
          (layer.type === 'pin' && layer.pinCustomAssetId === asset.id)),
    ),
  ),
  views: project.views.map((view) => {
    const next: View = { ...view };
    if (next.layerConfigs) {
      const layerConfigs = { ...next.layerConfigs };
      delete layerConfigs[layerId];
      next.layerConfigs = layerConfigs;
    }
    return next;
  }),
  transitions: project.transitions.map((transition) => {
    const layerConfigs = { ...transition.layerConfigs };
    delete layerConfigs[layerId];
    return { ...transition, layerConfigs };
  }),
});
