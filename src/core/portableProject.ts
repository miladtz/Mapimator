import { invoke } from '@tauri-apps/api/core';
import type { Project } from './project';
import { canonicalProjectJson, validateAndMigrateProject } from './projectPersistence';

export const PORTABLE_PACKAGE_FORMAT = 'mapmotion-portable-project';
export const PORTABLE_PACKAGE_VERSION = 1;
export const PORTABLE_MANIFEST_PATH = 'manifest.json';
export const PORTABLE_PROJECT_PATH = 'project.json';

export interface DataPackageRequirement {
  id: string;
  version: string;
}

export const INSTALLED_DATA_PACKAGES = [
  { id: 'mapmotion-offline-starter-world', version: '0.1' },
] as const satisfies readonly DataPackageRequirement[];

export interface PortableProjectManifest {
  format: typeof PORTABLE_PACKAGE_FORMAT;
  packageVersion: typeof PORTABLE_PACKAGE_VERSION;
  projectSchemaVersion: Project['version'];
  projectName: string;
  requiredDataPackages: DataPackageRequirement[];
  contents: { manifest: typeof PORTABLE_MANIFEST_PATH; project: typeof PORTABLE_PROJECT_PATH };
}

interface NativePortablePayload {
  manifestJson: string;
  projectJson: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const createManifest = (project: Project): PortableProjectManifest => ({
  format: PORTABLE_PACKAGE_FORMAT,
  packageVersion: PORTABLE_PACKAGE_VERSION,
  projectSchemaVersion: project.version,
  projectName: project.metadata.name,
  requiredDataPackages: INSTALLED_DATA_PACKAGES.map((requirement) => ({ ...requirement })),
  contents: { manifest: PORTABLE_MANIFEST_PATH, project: PORTABLE_PROJECT_PATH },
});

const validateManifest = (value: unknown): PortableProjectManifest => {
  if (!isRecord(value)) throw new Error('Portable project manifest must be an object.');
  if (value.format !== PORTABLE_PACKAGE_FORMAT) throw new Error('This is not a MapMotion portable project.');
  if (value.packageVersion !== PORTABLE_PACKAGE_VERSION)
    throw new Error(`Unsupported portable package version: ${String(value.packageVersion)}.`);
  if (value.projectSchemaVersion !== 1)
    throw new Error(`Unsupported project schema version: ${String(value.projectSchemaVersion)}.`);
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
      typeof requirement.version !== 'string'
    )
      throw new Error('Portable project data requirement is malformed.');
    const installed = INSTALLED_DATA_PACKAGES.find((candidate) => candidate.id === requirement.id);
    if (!installed || installed.version !== requirement.version)
      throw new Error(
        `Required standard data package is unavailable: ${requirement.id}@${requirement.version}.`,
      );
  }
  return value as unknown as PortableProjectManifest;
};

export async function exportPortableProject(project: Project, outputPath: string) {
  validateAndMigrateProject(project);
  if (project.assets.length)
    throw new Error('Portable project-owned assets are not supported until Phase 9 Milestone 2.');
  const manifest = createManifest(project);
  await invoke('export_portable_project', {
    outputPath,
    manifestJson: JSON.stringify(manifest, null, 2),
    projectJson: canonicalProjectJson(project),
  });
  return manifest;
}

export async function importPortableProject(inputPath: string): Promise<Project> {
  const payload = await invoke<NativePortablePayload>('import_portable_project', { inputPath });
  let manifestValue: unknown;
  let projectValue: unknown;
  try {
    manifestValue = JSON.parse(payload.manifestJson);
  } catch {
    throw new Error('Portable project manifest JSON is malformed.');
  }
  const manifest = validateManifest(manifestValue);
  try {
    projectValue = JSON.parse(payload.projectJson);
  } catch {
    throw new Error('Portable project payload JSON is malformed.');
  }
  const project = validateAndMigrateProject(projectValue);
  if (project.version !== manifest.projectSchemaVersion)
    throw new Error('Portable project schema version does not match its manifest.');
  if (project.metadata.name !== manifest.projectName)
    throw new Error('Portable project name does not match its manifest.');
  if (project.assets.length)
    throw new Error('This portable project contains assets that require a later MapMotion version.');
  return project;
}
