import { invoke } from '@tauri-apps/api/core';
import type { Project, ProjectAsset } from './project';
import { canonicalProjectJson, validateAndMigrateProject } from './projectPersistence';
import { validateProjectAssetStorage } from './projectAssets';
import {
  compatibilityAllowsImport,
  DATASET_REGISTRY,
  evaluatePortableProjectCompatibility,
  formatSemanticVersion,
  parseSemanticVersion,
  type CompatibilityResult,
  type DatasetRequirement,
  type PortableExtensionRequirement,
  type VersionInput,
} from './compatibility';

export const PORTABLE_PACKAGE_FORMAT = 'mapmotion-portable-project';
export const PORTABLE_PACKAGE_VERSION = '2.0.0';
export const PROJECT_SCHEMA_VERSION = '1.0.0';
export const PORTABLE_MANIFEST_PATH = 'manifest.json';
export const PORTABLE_PROJECT_PATH = 'project.json';

export const INSTALLED_DATA_PACKAGES = [
  ...DATASET_REGISTRY.filter((dataset) => dataset.installed).map(({ id, version }) => ({ id, version })),
] as const;

export interface PortableProjectManifest {
  format: typeof PORTABLE_PACKAGE_FORMAT;
  packageVersion: VersionInput;
  projectSchemaVersion: VersionInput;
  projectName: string;
  requiredDataPackages: DatasetRequirement[];
  extensions?: PortableExtensionRequirement[];
  contents: { manifest: typeof PORTABLE_MANIFEST_PATH; project: typeof PORTABLE_PROJECT_PATH };
  assets?: ProjectAsset[];
}

interface NativeImportedAsset extends ProjectAsset {
  bytes: number[];
}
interface NativePortablePayload {
  manifestJson: string;
  projectJson: string;
  assets: NativeImportedAsset[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const createManifest = (project: Project): PortableProjectManifest => ({
  format: PORTABLE_PACKAGE_FORMAT,
  packageVersion: PORTABLE_PACKAGE_VERSION,
  projectSchemaVersion: PROJECT_SCHEMA_VERSION,
  projectName: project.metadata.name,
  requiredDataPackages: DATASET_REGISTRY.filter((dataset) => dataset.required).map(({ id, version }) => ({
    id,
    version,
    required: true,
  })),
  extensions: [],
  contents: { manifest: PORTABLE_MANIFEST_PATH, project: PORTABLE_PROJECT_PATH },
  assets: [...project.assets].sort((left, right) => left.packagePath.localeCompare(right.packagePath)),
});

const validateManifest = (value: unknown): PortableProjectManifest => {
  if (!isRecord(value)) throw new Error('Portable project manifest must be an object.');
  if (value.format !== PORTABLE_PACKAGE_FORMAT) throw new Error('This is not a MapMotion portable project.');
  if (!['number', 'string'].includes(typeof value.packageVersion))
    throw new Error('Portable package version metadata is malformed.');
  if (!['number', 'string'].includes(typeof value.projectSchemaVersion))
    throw new Error('Portable project schema version metadata is malformed.');
  if (typeof value.projectName !== 'string')
    throw new Error('Portable project manifest has no valid project name.');
  if (
    !isRecord(value.contents) ||
    value.contents.manifest !== PORTABLE_MANIFEST_PATH ||
    value.contents.project !== PORTABLE_PROJECT_PATH
  )
    throw new Error('Portable project content declaration is malformed.');
  if (!Array.isArray(value.requiredDataPackages))
    throw new Error('Portable project data requirements are malformed.');
  for (const requirement of value.requiredDataPackages) {
    if (
      !isRecord(requirement) ||
      typeof requirement.id !== 'string' ||
      typeof requirement.version !== 'string' ||
      (requirement.required !== undefined && typeof requirement.required !== 'boolean')
    )
      throw new Error('Portable project data requirement is malformed.');
  }
  if (value.extensions !== undefined && !Array.isArray(value.extensions))
    throw new Error('Portable project extension declarations are malformed.');
  for (const extension of (value.extensions ?? []) as unknown[]) {
    if (
      !isRecord(extension) ||
      typeof extension.id !== 'string' ||
      typeof extension.version !== 'string' ||
      typeof extension.required !== 'boolean'
    )
      throw new Error('Portable project extension declaration is malformed.');
  }
  const packageVersion = parseSemanticVersion(value.packageVersion as VersionInput);
  if (packageVersion?.major === 1 && value.assets !== undefined)
    throw new Error('Milestone 1 portable manifests cannot declare project assets.');
  if (packageVersion?.major !== 1 && !Array.isArray(value.assets))
    throw new Error('Portable project asset declarations are malformed.');
  return value as unknown as PortableProjectManifest;
};

const sameAssetMetadata = (left: ProjectAsset, right: ProjectAsset) =>
  left.id === right.id &&
  left.kind === right.kind &&
  left.filename === right.filename &&
  left.mediaType === right.mediaType &&
  left.sha256 === right.sha256 &&
  left.size === right.size &&
  left.width === right.width &&
  left.height === right.height &&
  left.packagePath === right.packagePath;

export async function exportPortableProject(project: Project, outputPath: string) {
  validateAndMigrateProject(project);
  const manifest = createManifest(project);
  await invoke('export_portable_project', {
    outputPath,
    manifestJson: JSON.stringify(manifest, null, 2),
    projectJson: canonicalProjectJson(project),
    assets: manifest.assets,
  });
  return manifest;
}

export class PortableProjectCompatibilityError extends Error {
  constructor(readonly compatibility: CompatibilityResult) {
    super(
      compatibility.diagnostics.map((diagnostic) => diagnostic.message).join('\n') ||
        `Portable project compatibility is ${compatibility.category}.`,
    );
    this.name = 'PortableProjectCompatibilityError';
  }
}

export interface ImportedPortableProject {
  project: Project;
  compatibility: CompatibilityResult;
}

const migratePackageManifest = (manifest: PortableProjectManifest): PortableProjectManifest => ({
  ...manifest,
  packageVersion: formatSemanticVersion(parseSemanticVersion(manifest.packageVersion)!),
  projectSchemaVersion: formatSemanticVersion(parseSemanticVersion(manifest.projectSchemaVersion)!),
  requiredDataPackages: manifest.requiredDataPackages.map((requirement) => ({
    ...requirement,
    required: requirement.required !== false,
  })),
  extensions: manifest.extensions ?? [],
  assets: manifest.assets ?? [],
});

export async function importPortableProjectDetailed(inputPath: string): Promise<ImportedPortableProject> {
  // 1. Native archive validation and bounded extraction.
  const payload = await invoke<NativePortablePayload>('import_portable_project', { inputPath });
  let manifestValue: unknown;
  let projectValue: unknown;
  try {
    manifestValue = JSON.parse(payload.manifestJson);
  } catch {
    throw new Error('Portable project manifest JSON is malformed.');
  }
  // 2. Manifest structure validation.
  const sourceManifest = validateManifest(manifestValue);
  // 3. Compatibility evaluation.
  const compatibility = evaluatePortableProjectCompatibility(sourceManifest);
  if (!compatibilityAllowsImport(compatibility)) throw new PortableProjectCompatibilityError(compatibility);
  // 4. Package-level normalization/migration.
  const manifest = migratePackageManifest(sourceManifest);
  try {
    projectValue = JSON.parse(payload.projectJson);
  } catch {
    throw new Error('Portable project payload JSON is malformed.');
  }
  // 5 and 6. Existing project-schema migration entry point and dataset compatibility were evaluated above.
  // 7. Authoritative project validation.
  const project = validateAndMigrateProject(projectValue);
  const declaredSchema = parseSemanticVersion(manifest.projectSchemaVersion)!;
  if (project.version !== declaredSchema.major)
    throw new Error('Portable project schema version does not match its manifest.');
  if (project.metadata.name !== manifest.projectName)
    throw new Error('Portable project name does not match its manifest.');
  const declared = manifest.assets ?? [];
  if (declared.length !== project.assets.length || declared.length !== payload.assets.length)
    throw new Error('Portable project asset declarations do not match its project payload.');
  for (const asset of project.assets) {
    const declaration = declared.find((candidate) => candidate.id === asset.id);
    const imported = payload.assets.find((candidate) => candidate.id === asset.id);
    if (
      !declaration ||
      !imported ||
      !sameAssetMetadata(asset, declaration) ||
      !sameAssetMetadata(asset, imported)
    )
      throw new Error(`Portable project asset metadata mismatch: ${asset.id}.`);
  }
  // Asset commit is transactional and happens only after every compatibility/project check succeeds.
  if (payload.assets.length) await invoke('commit_imported_assets', { assets: payload.assets });
  await validateProjectAssetStorage(project);
  return { project, compatibility };
}

export async function importPortableProject(inputPath: string): Promise<Project> {
  return (await importPortableProjectDetailed(inputPath)).project;
}
