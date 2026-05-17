import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { embeddedPackageAssets } from './generated/package-assets.js';

export interface PackageAssetOptions {
  packageRoot?: string;
}

export function readPackageAssetSync(relativePath: string, opts: PackageAssetOptions = {}): string {
  const normalized = normalizePackageAssetPath(relativePath);
  const disk = readDiskPackageAsset(normalized, opts.packageRoot);
  if (disk !== null) return disk;

  const embedded = embeddedPackageAssets[normalized];
  if (embedded !== undefined) return embedded;

  throw new Error(`Package asset not found: ${normalized}`);
}

export async function readPackageAsset(relativePath: string, opts: PackageAssetOptions = {}): Promise<string> {
  return readPackageAssetSync(relativePath, opts);
}

export function packageAssetExistsSync(relativePath: string, opts: PackageAssetOptions = {}): boolean {
  const normalized = normalizePackageAssetPath(relativePath);
  if (diskPackageAssetPath(normalized, opts.packageRoot)) return true;
  return embeddedPackageAssets[normalized] !== undefined;
}

export function normalizePackageAssetPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Invalid package asset path: ${relativePath}`);
  }
  return normalized;
}

function readDiskPackageAsset(relativePath: string, packageRoot?: string): string | null {
  const path = diskPackageAssetPath(relativePath, packageRoot);
  if (!path) return null;
  return readFileSync(path, 'utf-8');
}

function diskPackageAssetPath(relativePath: string, packageRoot?: string): string | null {
  if (!packageRoot || packageRoot.startsWith('embedded://')) return null;
  const path = resolve(packageRoot, relativePath);
  return existsSync(path) ? path : null;
}
