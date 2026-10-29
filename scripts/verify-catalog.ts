import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DownloadAsset, ReleaseCatalog } from '../src/lib/catalog.js';

export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_PUBLIC_BYTES = 700 * 1024 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function string(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
}

export function validateAssetPath(value: string): void {
  if (!value || value.includes('\\') || /[\0?#%]/.test(value) || path.posix.isAbsolute(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe public asset path: ${value}`);
  }
}

export function validateCatalog(value: unknown): asserts value is ReleaseCatalog {
  if (!object(value) || value.schemaVersion !== 1 || typeof value.upstream !== 'string'
    || !Array.isArray(value.releases)) throw new Error('Invalid schemaVersion 1 release catalog');
  const releaseIds = new Set<string>();
  const paths = new Map<string, { sha256: string; size: number }>();
  for (const release of value.releases) {
    if (!object(release)) throw new Error('Invalid release entry');
    for (const key of ['id', 'tag', 'version', 'title', 'notes']) string(release[key], `release.${key}`);
    if (!release.id || releaseIds.has(release.id as string)) throw new Error(`Duplicate or empty release id: ${release.id}`);
    releaseIds.add(release.id as string);
    if (release.source !== 'upstream' && release.source !== 'legacy') throw new Error('Invalid release source');
    if (typeof release.prerelease !== 'boolean' || !(release.publishedAt === null || typeof release.publishedAt === 'string')
      || !Array.isArray(release.assets) || release.assets.length === 0) throw new Error(`Invalid release: ${release.id}`);
    if (release.releaseUrl !== undefined) string(release.releaseUrl, 'release.releaseUrl');
    const assetIds = new Set<string>();
    for (const asset of release.assets) {
      if (!object(asset)) throw new Error('Invalid asset entry');
      for (const key of ['id', 'name', 'label', 'path', 'sha256']) string(asset[key], `asset.${key}`);
      if (!asset.id || assetIds.has(asset.id as string)) throw new Error(`Duplicate or empty asset id: ${asset.id}`);
      assetIds.add(asset.id as string);
      validateAssetPath(asset.path as string);
      if (!Number.isSafeInteger(asset.size) || (asset.size as number) < 0 || (asset.size as number) > MAX_ASSET_BYTES) {
        throw new Error(`Invalid asset size: ${asset.name}`);
      }
      if (!/^[a-f0-9]{64}$/.test(asset.sha256 as string)) throw new Error(`Invalid SHA-256: ${asset.name}`);
      const prior = paths.get(asset.path as string);
      if (prior && (prior.sha256 !== asset.sha256 || prior.size !== asset.size)) {
        throw new Error(`Conflicting catalog references to path: ${asset.path}`);
      }
      paths.set(asset.path as string, { sha256: asset.sha256 as string, size: asset.size as number });
      for (const key of ['sourceUrl', 'upstreamUpdatedAt', 'digest']) {
        if (asset[key] !== undefined) string(asset[key], `asset.${key}`);
      }
      if (asset.digest !== undefined && !/^sha256:[a-fA-F0-9]{64}$/.test(asset.digest as string)) {
        throw new Error(`Invalid supplied digest: ${asset.name}`);
      }
      if (asset.digest !== undefined && (asset.digest as string).slice(7).toLowerCase() !== asset.sha256) {
        throw new Error(`Supplied digest disagrees with SHA-256: ${asset.name}`);
      }
    }
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function assertSafePath(root: string, relativePath: string): Promise<string> {
  validateAssetPath(relativePath);
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, ...relativePath.split('/'));
  if (!target.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error(`Path escapes root: ${relativePath}`);
  let current = absoluteRoot;
  const parts = [null, ...relativePath.split('/')];
  for (const part of parts) {
    if (part !== null) current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

export async function assetMatches(publicRoot: string, asset: DownloadAsset): Promise<boolean> {
  const target = await assertSafePath(publicRoot, asset.path);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.size !== asset.size || stat.size > MAX_ASSET_BYTES) return false;
    return sha256(await readFile(target)) === asset.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export interface VerifyOptions {
  root?: string;
  budgetBytes?: number;
}

export async function verifyCatalog(options: VerifyOptions = {}): Promise<{ releases: number; assets: number; publicBytes: number }> {
  const root = path.resolve(options.root ?? process.cwd());
  const catalogFile = await assertSafePath(root, 'data/releases.json');
  const catalog: unknown = JSON.parse(await readFile(catalogFile, 'utf8'));
  validateCatalog(catalog);
  const publicRoot = path.join(root, 'public');
  let assets = 0;
  for (const release of catalog.releases) {
    for (const asset of release.assets) {
      if (!await assetMatches(publicRoot, asset)) throw new Error(`Missing, corrupt, or wrong-size asset: ${asset.path}`);
      assets++;
    }
  }
  let publicBytes = 0;
  const budget = options.budgetBytes ?? MAX_PUBLIC_BYTES;
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error('Invalid public site budget');
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${target}`);
      if (stat.isDirectory()) await walk(target);
      else if (stat.isFile()) {
        publicBytes += stat.size;
        if (publicBytes > budget) throw new Error(`Public site exceeds ${budget} byte budget (${publicBytes} bytes)`);
      } else throw new Error(`Unsupported public file: ${target}`);
    }
  }
  await assertSafePath(root, 'public/.verification');
  try { await realpath(publicRoot); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && assets === 0) {
      return { releases: catalog.releases.length, assets, publicBytes };
    }
    throw error;
  }
  await walk(publicRoot);
  return { releases: catalog.releases.length, assets, publicBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--root')) {
    console.error('Usage: tsx scripts/verify-catalog.ts [--root directory]');
    process.exitCode = 1;
  } else {
    verifyCatalog({ root: args[1] }).then((result) => {
      console.log(`Verified ${result.releases} releases, ${result.assets} assets, ${result.publicBytes} public bytes`);
    }).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  }
}
