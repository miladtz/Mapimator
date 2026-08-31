import type {
  CameraState,
  Layer,
  MapMode,
  Project,
  ProjectAsset,
  SegmentLayerAnimation,
  TransitionLayerConfig,
  Transition,
  View,
  ViewLayerConfig,
} from './project';
import { hasConsistentViewMapMode, normalizePinLabelAngle, normalizeSegmentAnimation } from './project';
import { globeFocusOf, normalizeGlobeFocus, normalizeQuaternion } from './globeMath';
import { validateCustomFrameDimensions } from './projectFrameFormat';
import { normalizeTransitionTiming } from './transitionTiming';

type LegacyView = Omit<View, 'layerConfigs' | 'transitionLayerConfigs' | 'mapMode'> & {
  mapMode?: MapMode;
  layerConfigs?: Record<string, ViewLayerConfig>;
  transitionLayerConfigs?: Record<string, TransitionLayerConfig>;
  layers?: Layer[];
  transitionLayers?: Layer[];
  layerAnimations?: Record<string, SegmentLayerAnimation>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const oneOf = <T extends string>(value: unknown, values: readonly T[]): value is T =>
  typeof value === 'string' && values.includes(value as T);

const layerTypes = ['region', 'pin', 'text', 'shape', 'arrow', 'image', 'route', 'geo-effect'] as const;
const effectTypes = [
  'impact-pulse',
  'strike-marker',
  'smoke-plume',
  'missile-arc',
  'front-line',
  'territory-expansion',
  'hotspot',
  'control-zone',
  'refugee-flow',
  'blockade-line',
  'disputed-border',
  'influence-zone',
] as const;
const optionalStrings = [
  'text',
  'countryId',
  'textLanguage',
  'textDirection',
  'numberStyle',
  'geoEffectType',
  'assetId',
  'pinStyle',
  'pinBorderColor',
  'pinLabelColor',
  'pinLabelBorderColor',
  'pinLabelPosition',
  'pinAppear',
  'pinAppearType',
  'pinCustomAssetId',
  'pinCustomAnchor',
  'pinTintColor',
] as const;
const optionalNumbers = [
  'x2',
  'y2',
  'width',
  'height',
  'fontSize',
  'effectSize',
  'effectDuration',
  'pinSize',
  'pinBorderWidth',
  'pinLabelSize',
  'pinLabelOpacity',
  'pinLabelBorderWidth',
  'pinLabelAngle',
  'pinLabelGap',
  'pinAppearDelay',
  'pinAppearDuration',
] as const;
const optionalBooleans = ['effectRepeat', 'pinLabelVisible', 'pinAppearEnabled', 'pinTintEnabled'] as const;

const validateCamera = (value: unknown, path: string): CameraState => {
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.zoom))
    throw new Error(`${path} must contain finite x, y, and zoom values.`);
  if (value.bearing !== undefined && !isFiniteNumber(value.bearing))
    throw new Error(`${path}.bearing must be finite.`);
  if (value.pitch !== undefined && (!isFiniteNumber(value.pitch) || value.pitch < -85 || value.pitch > 85))
    throw new Error(`${path}.pitch must be between -85 and 85 degrees.`);
  if (value.globeOrientation !== undefined) {
    if (!isRecord(value.globeOrientation)) throw new Error(`${path}.globeOrientation must be an object.`);
    for (const component of ['x', 'y', 'z', 'w'] as const)
      if (!isFiniteNumber(value.globeOrientation[component]))
        throw new Error(`${path}.globeOrientation.${component} must be finite.`);
  }
  if (value.globeFocus !== undefined) {
    if (!isRecord(value.globeFocus)) throw new Error(`${path}.globeFocus must be an object.`);
    for (const component of ['x', 'y', 'z'] as const)
      if (!isFiniteNumber(value.globeFocus[component]))
        throw new Error(`${path}.globeFocus.${component} must be finite.`);
    if (
      Math.hypot(value.globeFocus.x as number, value.globeFocus.y as number, value.globeFocus.z as number) <
      1e-12
    )
      throw new Error(`${path}.globeFocus must have non-zero length.`);
  }
  return value as unknown as CameraState;
};

const validateLayer = (value: unknown, path: string): Layer => {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  if (!isString(value.id) || !value.id) throw new Error(`${path}.id must be a non-empty string.`);
  if (!oneOf(value.type, layerTypes)) throw new Error(`${path}.type is unsupported.`);
  if (!isString(value.name) || !isBoolean(value.visible) || !isBoolean(value.locked))
    throw new Error(`${path} has invalid name, visibility, or lock state.`);
  if (
    !isFiniteNumber(value.opacity) ||
    !isString(value.color) ||
    !isFiniteNumber(value.x) ||
    !isFiniteNumber(value.y)
  )
    throw new Error(`${path} has invalid visual properties.`);
  for (const key of optionalStrings)
    if (value[key] !== undefined && !isString(value[key]))
      throw new Error(`${path}.${key} must be a string.`);
  for (const key of optionalNumbers)
    if (value[key] !== undefined && !isFiniteNumber(value[key]))
      throw new Error(`${path}.${key} must be a finite number.`);
  for (const key of optionalBooleans)
    if (value[key] !== undefined && !isBoolean(value[key]))
      throw new Error(`${path}.${key} must be a boolean.`);
  if (
    value.pinStyle !== undefined &&
    !oneOf(value.pinStyle, ['dot', 'map-pin', 'location', 'target', 'star', 'circle', 'custom'] as const)
  )
    throw new Error(`${path}.pinStyle is unsupported.`);
  if (
    value.pinLabelPosition !== undefined &&
    !oneOf(value.pinLabelPosition, ['top', 'bottom', 'left', 'right'] as const)
  )
    throw new Error(`${path}.pinLabelPosition is unsupported.`);
  if (value.pinAppear !== undefined && !oneOf(value.pinAppear, ['none', 'fade', 'pop'] as const))
    throw new Error(`${path}.pinAppear is unsupported.`);
  if (value.pinAppearType !== undefined && !oneOf(value.pinAppearType, ['fade', 'pop', 'drop'] as const))
    throw new Error(`${path}.pinAppearType is unsupported.`);
  if (
    value.pinCustomAnchor !== undefined &&
    !oneOf(value.pinCustomAnchor, ['bottom-center', 'center'] as const)
  )
    throw new Error(`${path}.pinCustomAnchor is unsupported.`);
  if (value.pinAppearDelay !== undefined && (value.pinAppearDelay as number) < 0)
    throw new Error(`${path}.pinAppearDelay must be >= 0.`);
  if (value.pinAppearDuration !== undefined && (value.pinAppearDuration as number) <= 0)
    throw new Error(`${path}.pinAppearDuration must be > 0.`);
  if (value.pinSize !== undefined && (value.pinSize as number) <= 0)
    throw new Error(`${path}.pinSize must be > 0.`);
  if (
    value.pinLabelOpacity !== undefined &&
    ((value.pinLabelOpacity as number) < 0 || (value.pinLabelOpacity as number) > 1)
  )
    throw new Error(`${path}.pinLabelOpacity must be between 0 and 1.`);
  if (value.pinLabelBorderWidth !== undefined && (value.pinLabelBorderWidth as number) < 0)
    throw new Error(`${path}.pinLabelBorderWidth must be >= 0.`);
  if (value.textLanguage !== undefined && !oneOf(value.textLanguage, ['auto', 'persian', 'english'] as const))
    throw new Error(`${path}.textLanguage is unsupported.`);
  if (value.textDirection !== undefined && !oneOf(value.textDirection, ['auto', 'rtl', 'ltr'] as const))
    throw new Error(`${path}.textDirection is unsupported.`);
  if (value.numberStyle !== undefined && !oneOf(value.numberStyle, ['persian', 'english'] as const))
    throw new Error(`${path}.numberStyle is unsupported.`);
  if (value.geoEffectType !== undefined && !oneOf(value.geoEffectType, effectTypes))
    throw new Error(`${path}.geoEffectType is unsupported.`);
  return value as unknown as Layer;
};

const validateSegmentLayerAnimation = (value: unknown, path: string): SegmentLayerAnimation => {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  for (const key of ['appearDelay', 'appearDuration', 'layerHoldDuration', 'wipeDuration'] as const)
    if (value[key] !== undefined && !isFiniteNumber(value[key]))
      throw new Error(`${path}.${key} must be a finite number.`);
  for (const key of ['appearEnabled', 'wipeEnabled'] as const)
    if (value[key] !== undefined && !isBoolean(value[key]))
      throw new Error(`${path}.${key} must be a boolean.`);
  if (value.appearType !== undefined && !oneOf(value.appearType, ['fade', 'pop', 'drop'] as const))
    throw new Error(`${path}.appearType is unsupported.`);
  if (value.wipeType !== undefined && !oneOf(value.wipeType, ['fade-out'] as const))
    throw new Error(`${path}.wipeType is unsupported.`);
  if (value.appearDelay !== undefined && (value.appearDelay as number) < 0)
    throw new Error(`${path}.appearDelay must be >= 0.`);
  if (value.appearDuration !== undefined && (value.appearDuration as number) <= 0)
    throw new Error(`${path}.appearDuration must be > 0.`);
  if (value.layerHoldDuration !== undefined && (value.layerHoldDuration as number) < 0)
    throw new Error(`${path}.layerHoldDuration must be >= 0.`);
  if (value.wipeDuration !== undefined && (value.wipeDuration as number) <= 0)
    throw new Error(`${path}.wipeDuration must be > 0.`);
  return value as unknown as SegmentLayerAnimation;
};

const validateView = (value: unknown, index: number): LegacyView => {
  const path = `project.views[${index}]`;
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  if (!isString(value.id) || !isString(value.name) || !isString(value.thumbnailColor))
    throw new Error(`${path} has invalid identity fields.`);
  if (!isFiniteNumber(value.holdDuration) || value.holdDuration < 0)
    throw new Error(`${path} has invalid timing.`);
  if (value.mapMode !== undefined && !oneOf(value.mapMode, ['flat', 'globe'] as const))
    throw new Error(`${path}.mapMode is unsupported.`);
  if (
    value.transitionDuration !== undefined &&
    (!isFiniteNumber(value.transitionDuration) || value.transitionDuration < 0)
  )
    throw new Error(`${path}.transitionDuration is invalid.`);
  if (
    value.transitionPreset !== undefined &&
    !oneOf(value.transitionPreset, [
      'smooth',
      'cinematic',
      'linear',
      'ease-in',
      'ease-out',
      'ease-in-out',
      'bezier',
    ] as const)
  )
    throw new Error(`${path}.transitionPreset is unsupported.`);
  if (
    value.transitionType !== undefined &&
    !oneOf(value.transitionType, ['smooth', 'pan', 'zoom', 'fly-to'] as const)
  )
    throw new Error(`${path}.transitionType is unsupported.`);
  validateCamera(value.camera, `${path}.camera`);
  const validateViewLayerConfig = (config: unknown, configPath: string): ViewLayerConfig => {
    if (!isRecord(config) || typeof config.included !== 'boolean')
      throw new Error(`${configPath} must contain an included boolean.`);
    if (config.animation !== undefined)
      validateSegmentLayerAnimation(config.animation, `${configPath}.animation`);
    return config as unknown as ViewLayerConfig;
  };
  const validateTransitionLayerConfig = (config: unknown, configPath: string): TransitionLayerConfig => {
    if (!isRecord(config) || typeof config.included !== 'boolean')
      throw new Error(`${configPath} must contain an included boolean.`);
    if (config.animation !== undefined)
      validateSegmentLayerAnimation(config.animation, `${configPath}.animation`);
    return config as unknown as TransitionLayerConfig;
  };
  if (value.layers !== undefined) {
    if (!Array.isArray(value.layers)) throw new Error(`${path}.layers must be an array.`);
    value.layers.forEach((layer, layerIndex) => validateLayer(layer, `${path}.layers[${layerIndex}]`));
  }
  if (value.layerConfigs !== undefined) {
    if (!isRecord(value.layerConfigs)) throw new Error(`${path}.layerConfigs must be an object.`);
    for (const [layerId, config] of Object.entries(value.layerConfigs as Record<string, unknown>))
      validateViewLayerConfig(config, `${path}.layerConfigs[${layerId}]`);
  }
  if (value.transitionLayers !== undefined) {
    if (!Array.isArray(value.transitionLayers)) throw new Error(`${path}.transitionLayers must be an array.`);
    (value.transitionLayers as unknown[]).forEach((layer, layerIndex) =>
      validateLayer(layer, `${path}.transitionLayers[${layerIndex}]`),
    );
  }
  if (value.layerAnimations !== undefined) {
    if (!isRecord(value.layerAnimations)) throw new Error(`${path}.layerAnimations must be an object.`);
    for (const [layerId, anim] of Object.entries(value.layerAnimations as Record<string, unknown>))
      validateSegmentLayerAnimation(anim, `${path}.layerAnimations[${layerId}]`);
  }
  if (value.transitionLayerConfigs !== undefined) {
    if (!isRecord(value.transitionLayerConfigs))
      throw new Error(`${path}.transitionLayerConfigs must be an object.`);
    for (const [layerId, config] of Object.entries(value.transitionLayerConfigs as Record<string, unknown>))
      validateTransitionLayerConfig(config, `${path}.transitionLayerConfigs[${layerId}]`);
  }
  return value as unknown as LegacyView;
};

const validateTransition = (value: unknown, index: number): Transition => {
  const path = `project.transitions[${index}]`;
  if (!isRecord(value) || !isString(value.id) || !isString(value.fromViewId) || !isString(value.toViewId))
    throw new Error(`${path} has invalid identity fields.`);
  if (!isFiniteNumber(value.duration) || value.duration < 0) throw new Error(`${path}.duration is invalid.`);
  if (
    value.referenceDuration !== undefined &&
    (!isFiniteNumber(value.referenceDuration) || value.referenceDuration < 0)
  )
    throw new Error(`${path}.referenceDuration is invalid.`);
  if (value.speed !== undefined && (!isFiniteNumber(value.speed) || value.speed <= 0))
    throw new Error(`${path}.speed is invalid.`);
  if (value.timingSource !== undefined && !oneOf(value.timingSource, ['duration', 'speed'] as const))
    throw new Error(`${path}.timingSource is invalid.`);
  if (
    !oneOf(value.preset, [
      'smooth',
      'cinematic',
      'linear',
      'ease-in',
      'ease-out',
      'ease-in-out',
      'bezier',
    ] as const)
  )
    throw new Error(`${path}.preset is unsupported.`);
  if (!oneOf(value.type, ['smooth', 'pan', 'zoom', 'fly-to'] as const))
    throw new Error(`${path}.type is unsupported.`);
  if (!isRecord(value.layerConfigs)) throw new Error(`${path}.layerConfigs must be an object.`);
  for (const [layerId, config] of Object.entries(value.layerConfigs)) {
    if (!isRecord(config) || typeof config.included !== 'boolean')
      throw new Error(`${path}.layerConfigs[${layerId}] is invalid.`);
    if (config.animation !== undefined)
      validateSegmentLayerAnimation(config.animation, `${path}.layerConfigs[${layerId}].animation`);
  }
  return normalizeTransitionTiming(value as unknown as Transition);
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ASSET_ID_PATTERN = /^asset_[a-f0-9]{64}$/;
const ASSET_PATH_PATTERN = /^assets\/[a-f0-9]{64}\.(png|jpg)$/;

const validateAsset = (value: unknown, index: number): ProjectAsset => {
  const path = `project.assets[${index}]`;
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  if (!isString(value.id) || !ASSET_ID_PATTERN.test(value.id)) throw new Error(`${path}.id is malformed.`);
  if (value.kind !== 'image') throw new Error(`${path}.kind is unsupported.`);
  if (
    !isString(value.filename) ||
    !value.filename ||
    value.filename.includes('/') ||
    value.filename.includes('\\')
  )
    throw new Error(`${path}.filename is malformed.`);
  if (!oneOf(value.mediaType, ['image/png', 'image/jpeg'] as const))
    throw new Error(`${path}.mediaType is unsupported.`);
  if (!isString(value.sha256) || !SHA256_PATTERN.test(value.sha256) || value.id !== `asset_${value.sha256}`)
    throw new Error(`${path} has inconsistent identity metadata.`);
  if (!Number.isSafeInteger(value.size) || (value.size as number) <= 0)
    throw new Error(`${path}.size must be a positive integer.`);
  if (
    !Number.isSafeInteger(value.width) ||
    (value.width as number) <= 0 ||
    !Number.isSafeInteger(value.height) ||
    (value.height as number) <= 0
  )
    throw new Error(`${path} has invalid dimensions.`);
  if (!isString(value.packagePath) || !ASSET_PATH_PATTERN.test(value.packagePath))
    throw new Error(`${path}.packagePath is unsafe or malformed.`);
  const extension = value.packagePath.slice(value.packagePath.lastIndexOf('.') + 1);
  if (
    (value.mediaType === 'image/png' && extension !== 'png') ||
    (value.mediaType === 'image/jpeg' && !['jpg', 'jpeg'].includes(extension))
  )
    throw new Error(`${path}.packagePath does not match its media type.`);
  return value as unknown as ProjectAsset;
};

export function validateAndMigrateProject(value: unknown): Project {
  if (!isRecord(value)) throw new Error('Project payload must be an object.');
  if (value.version !== 1) throw new Error(`Unsupported project schema version: ${String(value.version)}.`);
  if (
    !isRecord(value.metadata) ||
    !isString(value.metadata.name) ||
    !isString(value.metadata.createdAt) ||
    !isString(value.metadata.updatedAt)
  )
    throw new Error('Project metadata is malformed.');
  if (!isRecord(value.canvas)) throw new Error('Project canvas is malformed.');
  if (value.canvas.layoutId === undefined) {
    value.canvas.layoutId = 'landscape';
    value.canvas.width = 1920;
    value.canvas.height = 1080;
  }
  if (
    !isFiniteNumber(value.canvas.width) ||
    value.canvas.width <= 0 ||
    !isFiniteNumber(value.canvas.height) ||
    value.canvas.height <= 0 ||
    ![24, 25, 30, 50, 60].includes(value.canvas.fps as number) ||
    !oneOf(value.canvas.layoutId, [
      'landscape',
      'portrait',
      'square',
      'portrait-4-5',
      'classic-4-3',
      'custom',
    ] as const) ||
    !isFiniteNumber(value.canvas.safeArea) ||
    !isBoolean(value.canvas.showSafeArea)
  )
    throw new Error('Project canvas settings are malformed.');
  if (value.canvas.layoutId === 'custom') {
    try {
      validateCustomFrameDimensions(value.canvas.width, value.canvas.height);
    } catch (error) {
      throw new Error(`Project custom frame settings are malformed: ${String(error)}`);
    }
  }
  if (
    !isRecord(value.mapSettings) ||
    !oneOf(value.mapSettings.styleId, [
      'documentary-dark',
      'documentary-light',
      'modern',
      'ink',
      'terrain',
    ] as const) ||
    !oneOf(value.mapSettings.labelLanguage, ['en', 'fa', 'both', 'none'] as const) ||
    (value.mapSettings.onlineLabelPolicyVersion !== undefined &&
      value.mapSettings.onlineLabelPolicyVersion !== 1) ||
    (value.mapSettings.basemapRenderer !== undefined &&
      !oneOf(value.mapSettings.basemapRenderer, ['legacy', 'online'] as const)) ||
    (value.mapSettings.onlineStyleId !== undefined &&
      !oneOf(value.mapSettings.onlineStyleId, ['3d', 'liberty', 'dark', 'bright'] as const))
  )
    throw new Error('Project map settings are malformed.');
  const migrateOriginalOnlineLabels =
    value.mapSettings.basemapRenderer === 'online' &&
    value.mapSettings.onlineLabelPolicyVersion === undefined;
  value.mapSettings = {
    ...value.mapSettings,
    labelLanguage: migrateOriginalOnlineLabels ? 'both' : value.mapSettings.labelLanguage,
    onlineLabelPolicyVersion: 1,
    basemapRenderer: value.mapSettings.basemapRenderer === 'online' ? 'online' : 'legacy',
    onlineStyleId: oneOf(value.mapSettings.onlineStyleId, ['3d', 'liberty', 'dark', 'bright'] as const)
      ? value.mapSettings.onlineStyleId
      : 'liberty',
  };
  if (!Array.isArray(value.layers)) throw new Error('Project layers must be an array.');
  value.layers.forEach((layer, index) => validateLayer(layer, `project.layers[${index}]`));
  const projectLayerIds = new Set<string>();
  for (const layer of value.layers as Layer[])
    if (!projectLayerIds.add(layer.id)) throw new Error(`Duplicate project Layer ID: ${layer.id}.`);
  if (!Array.isArray(value.views)) throw new Error('Project views must be an array.');
  value.views.forEach(validateView);
  if (value.transitions !== undefined && !Array.isArray(value.transitions))
    throw new Error('Project transitions must be an array.');
  (value.transitions as unknown[] | undefined)?.forEach(validateTransition);
  if (!Array.isArray(value.assets) || !isRecord(value.animation) || !isRecord(value.exportSettings))
    throw new Error('Project assets, animation, or export settings are malformed.');
  const assetIds = new Set<string>();
  const packagePaths = new Set<string>();
  value.assets.forEach((asset, index) => {
    const validated = validateAsset(asset, index);
    if (!assetIds.add(validated.id)) throw new Error(`Duplicate project asset ID: ${validated.id}.`);
    if (!packagePaths.add(validated.packagePath))
      throw new Error(`Duplicate project asset package path: ${validated.packagePath}.`);
  });
  const validateReferences = (layers: Layer[], path: string) =>
    layers.forEach((layer, index) => {
      if (layer.assetId !== undefined) {
        if (layer.type !== 'image') throw new Error(`${path}[${index}] uses an asset on a non-image layer.`);
        if (!assetIds.has(layer.assetId))
          throw new Error(`${path}[${index}] references nonexistent asset ID: ${layer.assetId}.`);
      }
      if (layer.type === 'pin' && layer.pinCustomAssetId !== undefined) {
        if (!assetIds.has(layer.pinCustomAssetId))
          throw new Error(
            `${path}[${index}] references nonexistent custom icon asset ID: ${layer.pinCustomAssetId}.`,
          );
      }
    });
  validateReferences(value.layers as Layer[], 'project.layers');
  (value.views as LegacyView[]).forEach((view, index) => {
    const viewPath = `project.views[${index}]`;
    if (view.layers) validateReferences(view.layers, `${viewPath}.layers`);
    if (view.transitionLayers) validateReferences(view.transitionLayers, `${viewPath}.transitionLayers`);
  });
  // --- Migration: normalize legacy views to the canonical usage model ---
  // The canonical model stores per-segment USAGE + ANIMATION only, keyed by
  // project layer id; Layer visual state lives in `project.layers`.  Legacy
  // views store full clones in `layers` (membership = `visible`), plus
  // `transitionLayers`/`layerAnimations`.  Derive usage configs so every
  // consumer (evaluator, Layers panel, timeline) reads one shape.  Legacy
  // fields are consumed here and removed from the returned runtime Project.
  const legacyViews = value.views as LegacyView[];
  // Project.layers wins for an existing identity. If a malformed-but-readable
  // legacy project contains a View-only Layer identity, retain the first
  // deterministic snapshot as a canonical Project Layer so migration never
  // loses an object.
  const migratePinLabelAppearance = (layer: Layer): Layer => {
    if (layer.type !== 'pin') return layer;
    const legacyAngle =
      layer.pinLabelPosition === 'top'
        ? 90
        : layer.pinLabelPosition === 'left'
          ? 180
          : layer.pinLabelPosition === 'bottom'
            ? 270
            : 0;
    return {
      ...layer,
      pinLabelOpacity: layer.pinLabelOpacity ?? layer.opacity,
      pinLabelBorderColor: layer.pinLabelBorderColor ?? layer.pinBorderColor ?? '#ffffff',
      pinLabelBorderWidth: layer.pinLabelBorderWidth ?? layer.pinBorderWidth ?? 1,
      pinLabelAngle: normalizePinLabelAngle(layer.pinLabelAngle ?? legacyAngle),
    };
  };
  const registry = structuredClone(value.layers as Layer[]).map((layer) => ({
    ...migratePinLabelAppearance(layer),
    visible: true,
  }));
  const registryIds = new Set(registry.map((layer) => layer.id));
  for (const view of legacyViews) {
    for (const layer of [...(view.layers ?? []), ...(view.transitionLayers ?? [])]) {
      if (registryIds.has(layer.id)) continue;
      registryIds.add(layer.id);
      registry.push({ ...migratePinLabelAppearance(structuredClone(layer)), visible: true });
    }
  }
  const viewsWithUsage = legacyViews.map((view) => {
    const legacyViewConfigs = Object.fromEntries(
      (view.layers ?? []).map((layer) => [layer.id, { included: layer.visible }]),
    ) as Record<string, ViewLayerConfig>;
    const layerConfigs = view.layerConfigs ?? legacyViewConfigs;
    const legacyTransitionConfigs = Object.fromEntries(
      (view.transitionLayers ?? []).map((layer) => [
        layer.id,
        {
          included: layer.visible,
          animation: normalizeSegmentAnimation(view.layerAnimations?.[layer.id]),
        },
      ]),
    ) as Record<string, TransitionLayerConfig>;
    const hadTransitionUsage =
      view.transitionLayers !== undefined || view.transitionLayerConfigs !== undefined;
    const transitionLayerConfigs = hadTransitionUsage
      ? view.transitionLayers !== undefined
        ? legacyTransitionConfigs
        : view.transitionLayerConfigs
      : undefined;
    const {
      layers: _legacyLayers,
      transitionLayers: _legacyTransitionLayers,
      layerAnimations: _legacyAnimations,
      transitionLayerConfigs: _legacyTransitionConfigs,
      transitionDuration: _legacyTransitionDuration,
      transitionPreset: _legacyTransitionPreset,
      transitionType: _legacyTransitionType,
      ...runtimeView
    } = view;
    return {
      runtimeView,
      layerConfigs,
      transitionLayerConfigs,
      legacyTransitionDuration: view.transitionDuration,
      legacyTransitionPreset: view.transitionPreset,
      legacyTransitionType: view.transitionType,
    };
  });
  // Committed projects have NO transition layer data at all — the old
  // evaluator interpolated the union of source/destination View layers during
  // the camera transition.  Synthesize transition usages as that union so
  // membership (and therefore rendered presence) is preserved as closely as
  // practical.  Per-view visual positions are intentionally NOT preserved:
  // Layer visual state is now canonical in `project.layers`.
  const viewMemberOf = (configs: Record<string, ViewLayerConfig>): Set<string> =>
    new Set(
      Object.entries(configs)
        .filter(([, config]) => config.included)
        .map(([id]) => id),
    );
  const unioned = viewsWithUsage.map((entry, index) => {
    if (entry.transitionLayerConfigs !== undefined || index >= viewsWithUsage.length - 1) return entry;
    const destMembers = viewMemberOf(viewsWithUsage[index + 1].layerConfigs);
    const sourceMembers = viewMemberOf(entry.layerConfigs);
    const members = new Set([...sourceMembers, ...destMembers]);
    return {
      ...entry,
      transitionLayerConfigs: Object.fromEntries(
        registry.map((layer) => [layer.id, { included: members.has(layer.id) }]),
      ),
    };
  });
  // --- Backfill: every View's configs have entries for ALL project layers ---
  // Each segment config must have an explicit `included` flag for every
  // project layer.  Layers missing from a config default to included=false
  // (absent from that segment).  This makes the checkbox state fully
  // deterministic and keeps the sidebar listing complete.
  const backfilled = unioned.map(({ runtimeView, layerConfigs, transitionLayerConfigs }) => {
    const vc = Object.fromEntries(
      registry.map((layer) => {
        const config = layerConfigs[layer.id];
        return [
          layer.id,
          {
            included: config?.included ?? false,
            animation: normalizeSegmentAnimation(config?.animation),
          },
        ];
      }),
    );
    return {
      ...runtimeView,
      mapMode: runtimeView.mapMode === 'globe' ? 'globe' : 'flat',
      camera: {
        ...runtimeView.camera,
        bearing: runtimeView.camera.bearing ?? 0,
        pitch: runtimeView.camera.pitch ?? 0,
        ...(runtimeView.mapMode === 'globe'
          ? {
              globeOrientation: normalizeQuaternion(runtimeView.camera.globeOrientation),
              globeFocus: normalizeGlobeFocus(
                runtimeView.camera.globeFocus,
                globeFocusOf(runtimeView.camera),
              ),
            }
          : {}),
      },
      layerConfigs: vc,
    } as View;
  });
  const viewIds = new Set(backfilled.map((view) => view.id));
  const existingTransitions = ((value.transitions as unknown[] | undefined) ?? []).map(validateTransition);
  const transitions: Transition[] = existingTransitions.length
    ? existingTransitions.map((transition) => ({
        ...structuredClone(transition),
        layerConfigs: Object.fromEntries(
          registry.map((layer) => {
            const config = transition.layerConfigs[layer.id];
            return [
              layer.id,
              {
                included: config?.included ?? false,
                animation: normalizeSegmentAnimation(config?.animation),
              },
            ];
          }),
        ),
      }))
    : unioned.slice(0, -1).map((entry, index) => ({
        id: `transition-${entry.runtimeView.id}-${viewsWithUsage[index + 1].runtimeView.id}`,
        fromViewId: entry.runtimeView.id,
        toViewId: viewsWithUsage[index + 1].runtimeView.id,
        duration: entry.legacyTransitionDuration ?? 0,
        referenceDuration: entry.legacyTransitionDuration ?? 0,
        speed: 1,
        timingSource: 'duration' as const,
        preset: entry.legacyTransitionPreset ?? 'smooth',
        type: entry.legacyTransitionType ?? 'smooth',
        layerConfigs: Object.fromEntries(
          registry.map((layer) => {
            const config = entry.transitionLayerConfigs?.[layer.id] as TransitionLayerConfig | undefined;
            return [
              layer.id,
              {
                included: config?.included ?? false,
                animation: normalizeSegmentAnimation(config?.animation),
              },
            ];
          }),
        ),
      }));
  const transitionIds = new Set<string>();
  for (const transition of transitions) {
    if (!transitionIds.add(transition.id)) throw new Error(`Duplicate Transition ID: ${transition.id}.`);
    if (!viewIds.has(transition.fromViewId) || !viewIds.has(transition.toViewId))
      throw new Error(`Transition ${transition.id} references a missing View.`);
  }
  if (!hasConsistentViewMapMode(backfilled)) throw new Error('Project Views must all use the same map mode.');
  const { transitions: _inputTransitions, ...projectInput } = value;
  return { ...(projectInput as unknown as Project), layers: registry, views: backfilled, transitions };
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
};

export const canonicalProjectJson = (project: Project) =>
  JSON.stringify(canonicalize(validateAndMigrateProject(project)), null, 2);
