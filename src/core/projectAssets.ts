import { invoke } from '@tauri-apps/api/core';
import type { Project, ProjectAsset } from './project';

interface NativeAssetBytes {
  bytes: number[];
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
