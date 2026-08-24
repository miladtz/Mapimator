import type { CameraState, Layer, Project, ProjectAsset, View } from './project';

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
] as const;
const optionalNumbers = ['x2', 'y2', 'width', 'height', 'fontSize', 'effectSize', 'effectDuration'] as const;

const validateCamera = (value: unknown, path: string): CameraState => {
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.zoom))
    throw new Error(`${path} must contain finite x, y, and zoom values.`);
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
  if (value.effectRepeat !== undefined && !isBoolean(value.effectRepeat))
    throw new Error(`${path}.effectRepeat must be a boolean.`);
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

const validateView = (value: unknown, index: number): View => {
  const path = `project.views[${index}]`;
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  if (!isString(value.id) || !isString(value.name) || !isString(value.thumbnailColor))
    throw new Error(`${path} has invalid identity fields.`);
  if (
    !isFiniteNumber(value.holdDuration) ||
    value.holdDuration < 0 ||
    !isFiniteNumber(value.transitionDuration) ||
    value.transitionDuration < 0
  )
    throw new Error(`${path} has invalid timing.`);
  if (
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
  if (!Array.isArray(value.layers)) throw new Error(`${path}.layers must be an array.`);
  value.layers.forEach((layer, layerIndex) => validateLayer(layer, `${path}.layers[${layerIndex}]`));
  return value as unknown as View;
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
  if (
    !isRecord(value.mapSettings) ||
    !oneOf(value.mapSettings.styleId, [
      'documentary-dark',
      'documentary-light',
      'modern',
      'ink',
      'terrain',
    ] as const) ||
    !oneOf(value.mapSettings.labelLanguage, ['en', 'fa', 'both', 'none'] as const)
  )
    throw new Error('Project map settings are malformed.');
  if (!Array.isArray(value.layers)) throw new Error('Project layers must be an array.');
  value.layers.forEach((layer, index) => validateLayer(layer, `project.layers[${index}]`));
  if (!Array.isArray(value.views)) throw new Error('Project views must be an array.');
  value.views.forEach(validateView);
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
    });
  validateReferences(value.layers as Layer[], 'project.layers');
  (value.views as View[]).forEach((view, index) =>
    validateReferences(view.layers, `project.views[${index}].layers`),
  );
  return value as unknown as Project;
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

export const canonicalProjectJson = (project: Project) => JSON.stringify(canonicalize(project), null, 2);
