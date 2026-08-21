export type VersionInput = number | string;
export type CompatibilityCategory = 'COMPATIBLE' | 'COMPATIBLE_WITH_WARNING' | 'INCOMPATIBLE' | 'UNKNOWN';
export type CompatibilitySeverity = 'warning' | 'error' | 'unknown';

export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (string | number)[];
}

export interface DatasetRequirement {
  id: string;
  version: string;
  required?: boolean;
}

export interface DatasetRegistryEntry {
  id: string;
  version: string;
  displayName: string;
  description?: string;
  required: boolean;
  installed: boolean;
}

export interface PortableExtensionRequirement {
  id: string;
  version: string;
  required: boolean;
}

export interface ExtensionRegistryEntry {
  id: string;
  version: string;
  displayName: string;
  installed: boolean;
}

export interface CompatibilityManifestInput {
  packageVersion: VersionInput;
  projectSchemaVersion: VersionInput;
  requiredDataPackages: readonly DatasetRequirement[];
  extensions?: readonly PortableExtensionRequirement[];
}

export interface CompatibilityDiagnostic {
  code: string;
  severity: CompatibilitySeverity;
  subject: 'package' | 'project-schema' | 'dataset' | 'extension' | 'metadata';
  id?: string;
  displayName?: string;
  requiredVersion?: string;
  installedVersion?: string;
  message: string;
}

export interface CompatibilityResult {
  category: CompatibilityCategory;
  packageVersion?: string;
  projectSchemaVersion?: string;
  diagnostics: CompatibilityDiagnostic[];
}

export const CURRENT_PACKAGE_VERSION = '2.0.0';
export const CURRENT_PROJECT_SCHEMA_VERSION = '1.0.0';

export const DATASET_REGISTRY: readonly DatasetRegistryEntry[] = [
  {
    id: 'mapmotion-offline-starter-world',
    version: '0.1.0',
    displayName: 'MapMotion Offline Starter World',
    description: 'Bundled political basemap and country labels.',
    required: true,
    installed: true,
  },
] as const;

export const EXTENSION_REGISTRY: readonly ExtensionRegistryEntry[] = [];

const VERSION_PATTERN =
  /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemanticVersion(value: VersionInput): SemanticVersion | null {
  const source = typeof value === 'number' ? String(value) : value;
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null;
  const match = VERSION_PATTERN.exec(source);
  if (!match) return null;
  const prereleaseParts = match[4]?.split('.') ?? [];
  if (
    prereleaseParts.some(
      (identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'),
    )
  )
    return null;
  const prerelease = prereleaseParts.length
    ? prereleaseParts.map((identifier) => {
        if (/^\d+$/.test(identifier)) {
          const numeric = Number(identifier);
          return Number.isSafeInteger(numeric) ? numeric : identifier;
        }
        return identifier;
      })
    : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease,
  };
}

export function formatSemanticVersion(version: SemanticVersion): string {
  const prerelease = version.prerelease.length ? `-${version.prerelease.join('.')}` : '';
  return `${version.major}.${version.minor}.${version.patch}${prerelease}`;
}

export function compareSemanticVersions(left: SemanticVersion, right: SemanticVersion): -1 | 0 | 1 {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === 'number' && typeof rightPart !== 'number') return -1;
    if (typeof leftPart !== 'number' && typeof rightPart === 'number') return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

const versionDiagnostic = (
  subject: 'package' | 'project-schema',
  required: VersionInput,
  currentValue: string,
): CompatibilityDiagnostic[] => {
  const requested = parseSemanticVersion(required);
  const current = parseSemanticVersion(currentValue)!;
  const label = subject === 'package' ? 'portable package' : 'project schema';
  if (!requested)
    return [
      {
        code: subject === 'package' ? 'INVALID_PACKAGE_VERSION' : 'INVALID_PROJECT_SCHEMA_VERSION',
        severity: 'unknown',
        subject: 'metadata',
        requiredVersion: String(required),
        installedVersion: currentValue,
        message: `The ${label} version is not valid semantic version metadata: ${String(required)}.`,
      },
    ];
  const normalized = formatSemanticVersion(requested);
  if (requested.major > current.major)
    return [
      {
        code: subject === 'package' ? 'UNSUPPORTED_PACKAGE_MAJOR' : 'UNSUPPORTED_PROJECT_SCHEMA_MAJOR',
        severity: 'error',
        subject,
        requiredVersion: normalized,
        installedVersion: currentValue,
        message: `The ${label} requires unsupported major version ${normalized}; this installation supports ${currentValue}.`,
      },
    ];
  if (requested.major < current.major)
    return [
      {
        code: subject === 'package' ? 'LEGACY_PACKAGE_VERSION' : 'LEGACY_PROJECT_SCHEMA_VERSION',
        severity: 'warning',
        subject,
        requiredVersion: normalized,
        installedVersion: currentValue,
        message: `The ${label} uses legacy version ${normalized}; compatibility migration will target ${currentValue}.`,
      },
    ];
  if (compareSemanticVersions(requested, current) > 0)
    return [
      {
        code: subject === 'package' ? 'NEWER_PACKAGE_MINOR' : 'NEWER_PROJECT_SCHEMA_MINOR',
        severity: 'warning',
        subject,
        requiredVersion: normalized,
        installedVersion: currentValue,
        message: `The ${label} version ${normalized} is newer than ${currentValue}, but remains within the supported major version.`,
      },
    ];
  return [];
};

const evaluateDependency = (
  requirement: DatasetRequirement | PortableExtensionRequirement,
  installed: { version: string; displayName: string; installed: boolean } | undefined,
  subject: 'dataset' | 'extension',
): CompatibilityDiagnostic[] => {
  const required = requirement.required !== false;
  const label = subject === 'dataset' ? 'dataset' : 'extension';
  const requestedVersion = parseSemanticVersion(requirement.version);
  if (!requestedVersion)
    return [
      {
        code: `INVALID_${subject.toUpperCase()}_VERSION`,
        severity: 'unknown',
        subject: 'metadata',
        id: requirement.id,
        requiredVersion: requirement.version,
        message: `Compatibility metadata for ${label} ${requirement.id} has an invalid version.`,
      },
    ];
  if (!installed?.installed)
    return [
      {
        code: required
          ? `MISSING_REQUIRED_${subject.toUpperCase()}`
          : `MISSING_OPTIONAL_${subject.toUpperCase()}`,
        severity: required ? 'error' : 'warning',
        subject,
        id: requirement.id,
        displayName: installed?.displayName,
        requiredVersion: formatSemanticVersion(requestedVersion),
        message: `${required ? 'Required' : 'Optional'} ${label} is unavailable: ${installed?.displayName ?? requirement.id}@${formatSemanticVersion(requestedVersion)}.`,
      },
    ];
  const installedVersion = parseSemanticVersion(installed.version);
  if (!installedVersion)
    return [
      {
        code: `INVALID_INSTALLED_${subject.toUpperCase()}_VERSION`,
        severity: 'unknown',
        subject: 'metadata',
        id: requirement.id,
        displayName: installed.displayName,
        requiredVersion: formatSemanticVersion(requestedVersion),
        installedVersion: installed.version,
        message: `Installed ${label} ${installed.displayName} has invalid version metadata.`,
      },
    ];
  const comparison = compareSemanticVersions(installedVersion, requestedVersion);
  if (comparison < 0)
    return [
      {
        code: required
          ? `INSTALLED_${subject.toUpperCase()}_TOO_OLD`
          : `OPTIONAL_${subject.toUpperCase()}_TOO_OLD`,
        severity: required ? 'error' : 'warning',
        subject,
        id: requirement.id,
        displayName: installed.displayName,
        requiredVersion: formatSemanticVersion(requestedVersion),
        installedVersion: formatSemanticVersion(installedVersion),
        message: `${installed.displayName} ${formatSemanticVersion(installedVersion)} is older than required ${formatSemanticVersion(requestedVersion)}.`,
      },
    ];
  if (comparison > 0)
    return [
      {
        code: `INSTALLED_${subject.toUpperCase()}_NEWER`,
        severity: 'warning',
        subject,
        id: requirement.id,
        displayName: installed.displayName,
        requiredVersion: formatSemanticVersion(requestedVersion),
        installedVersion: formatSemanticVersion(installedVersion),
        message: `${installed.displayName} ${formatSemanticVersion(installedVersion)} is newer than requested ${formatSemanticVersion(requestedVersion)}.`,
      },
    ];
  return [];
};

export function evaluatePortableProjectCompatibility(
  manifest: CompatibilityManifestInput,
  datasets: readonly DatasetRegistryEntry[] = DATASET_REGISTRY,
  extensions: readonly ExtensionRegistryEntry[] = EXTENSION_REGISTRY,
): CompatibilityResult {
  const diagnostics = [
    ...versionDiagnostic('package', manifest.packageVersion, CURRENT_PACKAGE_VERSION),
    ...versionDiagnostic('project-schema', manifest.projectSchemaVersion, CURRENT_PROJECT_SCHEMA_VERSION),
  ];
  const datasetIds = new Set<string>();
  for (const requirement of manifest.requiredDataPackages) {
    if (!datasetIds.add(requirement.id)) {
      diagnostics.push({
        code: 'DUPLICATE_DATASET_REQUIREMENT',
        severity: 'unknown',
        subject: 'metadata',
        id: requirement.id,
        message: `Dataset compatibility requirement is declared more than once: ${requirement.id}.`,
      });
      continue;
    }
    diagnostics.push(
      ...evaluateDependency(
        requirement,
        datasets.find((entry) => entry.id === requirement.id),
        'dataset',
      ),
    );
  }
  const extensionIds = new Set<string>();
  for (const requirement of manifest.extensions ?? []) {
    if (!extensionIds.add(requirement.id)) {
      diagnostics.push({
        code: 'DUPLICATE_EXTENSION_REQUIREMENT',
        severity: 'unknown',
        subject: 'metadata',
        id: requirement.id,
        message: `Extension compatibility requirement is declared more than once: ${requirement.id}.`,
      });
      continue;
    }
    diagnostics.push(
      ...evaluateDependency(
        requirement,
        extensions.find((entry) => entry.id === requirement.id),
        'extension',
      ),
    );
  }
  const category: CompatibilityCategory = diagnostics.some((diagnostic) => diagnostic.severity === 'unknown')
    ? 'UNKNOWN'
    : diagnostics.some((diagnostic) => diagnostic.severity === 'error')
      ? 'INCOMPATIBLE'
      : diagnostics.length
        ? 'COMPATIBLE_WITH_WARNING'
        : 'COMPATIBLE';
  const packageVersion = parseSemanticVersion(manifest.packageVersion);
  const projectSchemaVersion = parseSemanticVersion(manifest.projectSchemaVersion);
  return {
    category,
    packageVersion: packageVersion ? formatSemanticVersion(packageVersion) : undefined,
    projectSchemaVersion: projectSchemaVersion ? formatSemanticVersion(projectSchemaVersion) : undefined,
    diagnostics,
  };
}

export const compatibilityAllowsImport = (result: CompatibilityResult) =>
  result.category === 'COMPATIBLE' || result.category === 'COMPATIBLE_WITH_WARNING';
