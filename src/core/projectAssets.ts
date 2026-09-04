import { invoke } from '@tauri-apps/api/core';
import type { Project, ProjectAsset } from './project';

interface NativeAssetBytes {
  bytes: number[];
}

export interface AssetStorageIssue {
  code: string;
  message: string;
  assetId?: string;
}

export interface AssetStorageDiagnostics {
  storedAssets: number;
  referencedAssets: number;
  orphanMetadata: string[];
  orphanFiles: string[];
  storageBytes: number;
  duplicatePayloads: number;
  hashFailures: number;
  missingFiles: number;
  integrityFailures: number;
  issues: AssetStorageIssue[];
  elapsedMs: number;
}

export interface AssetCleanupResult {
  removed: string[];
  diagnostics: AssetStorageDiagnostics;
}

export interface ProjectAssetCleanupResult extends AssetCleanupResult {
  project: Project;
}

const dataUrlCache = new Map<string, Promise<string>>();

const bytesToDataUrl = (bytes: number[], mediaType: string) => {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    chunks.push(String.fromCharCode(...bytes.slice(offset, offset + chunkSize)));
  return `data:${mediaType};base64,${btoa(chunks.join(''))}`;
};

export async function ingestProjectImage(sourcePath: string): Promise<ProjectAsset> {
  return invoke<ProjectAsset>('ingest_project_image', { sourcePath });
}

/**
 * Ingest raw PNG/JPEG bytes (e.g. decoded from a reusable app-level Pin
 * Style) into the project-owned content-addressed asset store.
 */
export async function ingestProjectImageBytes(bytes: number[], filename: string): Promise<ProjectAsset> {
  return invoke<ProjectAsset>('ingest_project_image_bytes', { bytes, filename });
}

export function resolveProjectAssetDataUrl(asset: ProjectAsset): Promise<string> {
  let pending = dataUrlCache.get(asset.id);
  if (!pending) {
    pending = invoke<NativeAssetBytes>('read_project_asset', { assetId: asset.id }).then(({ bytes }) =>
      bytesToDataUrl(bytes, asset.mediaType),
    );
    dataUrlCache.set(asset.id, pending);
  }
  return pending;
}

export async function resolveProjectAssetUrls(project: Project): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      project.assets.map(async (asset) => [asset.id, await resolveProjectAssetDataUrl(asset)]),
    ),
  );
}

export function findReferencedAssets(project: Project): Set<string> {
  const referenced = new Set<string>();
  const collect = (layers: Project['layers']) => {
    for (const layer of layers) {
      if (layer.type === 'image' && layer.assetId) referenced.add(layer.assetId);
      if (layer.type === 'pin' && layer.pinCustomAssetId) referenced.add(layer.pinCustomAssetId);
    }
  };
  // Assets are project-level: custom icons and images live exclusively on the
  // canonical Project Layer definition. Migration adopts any legacy-only
  // layer before this runtime path is reached.
  collect(project.layers);
  const collectTimelineAssets = (
    configs: Record<string, import('./project').ViewLayerConfig | import('./project').TransitionLayerConfig>,
  ) => {
    for (const config of Object.values(configs)) {
      const animation = config.animation;
      if (animation?.routeDefaults?.vehicleAssetId) referenced.add(animation.routeDefaults.vehicleAssetId);
      for (const timing of Object.values(animation?.routeSegmentAnimations ?? {}))
        if (timing.vehicleAssetId) referenced.add(timing.vehicleAssetId);
    }
  };
  for (const view of project.views) collectTimelineAssets(view.layerConfigs);
  for (const transition of project.transitions) collectTimelineAssets(transition.layerConfigs);
  return referenced;
}

export function findOrphanMetadata(project: Project): ProjectAsset[] {
  const referenced = findReferencedAssets(project);
  return project.assets.filter((asset) => !referenced.has(asset.id));
}

export async function scanProjectAssets(project: Project): Promise<AssetStorageDiagnostics> {
  return invoke<AssetStorageDiagnostics>('scan_project_assets', {
    assets: project.assets,
    referencedIds: [...findReferencedAssets(project)].sort(),
  });
}

export async function findStoredAssets(): Promise<AssetStorageDiagnostics> {
  return invoke<AssetStorageDiagnostics>('scan_project_assets', { assets: [], referencedIds: [] });
}

export async function validateProjectAssetStorage(project: Project): Promise<AssetStorageDiagnostics> {
  const diagnostics = await scanProjectAssets(project);
  const projectAssetIds = new Set(project.assets.map((asset) => asset.id));
  const relevantIssues = diagnostics.issues.filter(
    (issue) => issue.code === 'missing_metadata' || (issue.assetId && projectAssetIds.has(issue.assetId)),
  );
  if (relevantIssues.length) throw new Error(relevantIssues.map((issue) => issue.message).join('\n'));
  return diagnostics;
}

export async function cleanupProjectAssets(project: Project): Promise<ProjectAssetCleanupResult> {
  const referencedIds = [...findReferencedAssets(project)].sort();
  const referenced = new Set(referencedIds);
  const liveAssets = project.assets.filter((asset) => referenced.has(asset.id));
  const result = await invoke<AssetCleanupResult>('cleanup_project_assets', {
    assets: liveAssets,
    referencedIds,
  });
  for (const id of result.removed) dataUrlCache.delete(id);
  return { ...result, project: { ...project, assets: liveAssets } };
}
