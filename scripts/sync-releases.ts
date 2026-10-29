import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { DownloadAsset, ReleaseCatalog, ReleaseEntry } from '../src/lib/catalog.js';
import { assertSafePath, assetMatches, MAX_ASSET_BYTES, sha256, validateCatalog } from './verify-catalog.js';

export const UPSTREAM = 'dodo23333/cu-chinese-wiki-translations';
const API_ORIGIN = 'https://api.github.com';
const REPOSITORY_API = `${API_ORIGIN}/repos/${UPSTREAM}`;

type Fetch = typeof globalThis.fetch;
interface UpstreamAsset {
  id: string;
  name: string;
  label: string;
  size: number;
  browser_download_url: string;
  updated_at: string;
  digest?: string;
}
interface UpstreamRelease {
  id: string;
  tag_name: string;
  name: string;
  body: string;
  published_at: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  assets: UpstreamAsset[];
}
export interface SyncOptions {
  root?: string;
  fetch?: Fetch;
  now?: () => Date;
  token?: string;
  outputFile?: string | null;
}
export interface SyncResult {
  changed: boolean;
  pendingTags: string[];
  catalog: ReleaseCatalog;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid upstream ${field}`);
  return value;
}
function identifier(value: unknown): string {
  if ((typeof value !== 'string' && typeof value !== 'number')
    || (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0))) throw new Error('Invalid upstream id');
  const result = String(value);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new Error('Unsafe upstream id');
  return result;
}

export function isOfficialAsset(asset: { name: string; label?: string | null }): boolean {
  return /\.json$/i.test(asset.name) && (/official/i.test(asset.name) || /基于官方翻译/.test(asset.label ?? ''));
}

export function validateDownloadUrl(value: string): URL {
  const url = new URL(value);
  const prefix = `/${UPSTREAM}/releases/download/`;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password
    || url.hash || !url.pathname.startsWith(prefix)) throw new Error(`Unsafe release download URL: ${value}`);
  const segments = url.pathname.slice(prefix.length).split('/');
  if (segments.length !== 2 || segments.some((part, index) => {
    const decoded = decodeURIComponent(part);
    return !decoded || /[\\\0]/.test(decoded) || (index === 1 && decoded.includes('/'))
      || decoded.split('/').some((piece) => !piece || piece === '.' || piece === '..');
  })) throw new Error(`Invalid repository release download path: ${value}`);
  return url;
}

function parseAsset(value: unknown): UpstreamAsset {
  if (!record(value)) throw new Error('Invalid upstream asset');
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0 || (value.size as number) > MAX_ASSET_BYTES) {
    throw new Error(`Invalid upstream asset size: ${value.name}`);
  }
  const digest = value.digest === null || value.digest === undefined ? undefined : text(value.digest, 'asset digest');
  if (digest !== undefined && !/^sha256:[a-fA-F0-9]{64}$/.test(digest)) throw new Error('Invalid upstream SHA-256 digest');
  return {
    id: identifier(value.id), name: text(value.name, 'asset name'), label: value.label == null ? '' : text(value.label, 'asset label'),
    size: value.size as number, browser_download_url: text(value.browser_download_url, 'asset URL'),
    updated_at: text(value.updated_at, 'asset updated_at'), ...(digest === undefined ? {} : { digest }),
  };
}

function parseRelease(value: unknown): UpstreamRelease {
  if (!record(value) || typeof value.draft !== 'boolean' || typeof value.prerelease !== 'boolean'
    || !Array.isArray(value.assets)) throw new Error('Invalid upstream release');
  const assets = value.assets.filter((asset) => {
    if (!record(asset)) throw new Error('Invalid upstream asset');
    return isOfficialAsset({ name: text(asset.name, 'asset name'), label: asset.label == null ? '' : text(asset.label, 'asset label') });
  }).map(parseAsset);
  if (new Set(assets.map((asset) => asset.id)).size !== assets.length) throw new Error('Duplicate upstream asset id');
  return {
    id: identifier(value.id), tag_name: text(value.tag_name, 'release tag'),
    name: value.name == null ? '' : text(value.name, 'release name'), body: value.body == null ? '' : text(value.body, 'release notes'),
    published_at: value.published_at === null ? null : text(value.published_at, 'release publication date'),
    html_url: text(value.html_url, 'release URL'), draft: value.draft, prerelease: value.prerelease, assets,
  };
}

function nextPage(link: string | null, current: string): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(/,(?=\s*<)/)) {
    const match = part.match(/^\s*<([^>]+)>\s*;(.*)$/);
    if (match && /(?:^|;)\s*rel\s*=\s*(?:"[^"]*\bnext\b[^"]*"|next)(?:\s*;|\s*$)/i.test(match[2]!)) {
      return new URL(match[1]!, current).href;
    }
  }
  return undefined;
}

async function pages(endpoint: 'tags' | 'releases', fetcher: Fetch, token?: string): Promise<unknown[]> {
  let url: string | undefined = `${REPOSITORY_API}/${endpoint}?per_page=100`;
  const visited = new Set<string>();
  const values: unknown[] = [];
  while (url) {
    const parsed = new URL(url);
    if (parsed.origin !== API_ORIGIN || parsed.pathname !== `/repos/${UPSTREAM}/${endpoint}` || parsed.username || parsed.password) {
      throw new Error(`Unsafe API pagination URL: ${url}`);
    }
    if (visited.has(url)) throw new Error('Cyclic API pagination');
    visited.add(url);
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetcher(url, { headers, redirect: 'manual' });
    if (!response.ok) throw new Error(`GitHub ${endpoint} request failed: ${response.status}`);
    const page: unknown = await response.json();
    if (!Array.isArray(page)) throw new Error(`Invalid GitHub ${endpoint} response`);
    values.push(...page);
    url = nextPage(response.headers.get('link'), url);
  }
  return values;
}

export function validateTranslation(bytes: Uint8Array): void {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Downloaded translation is not valid UTF-8 JSON'); }
  if (!record(value) || typeof value.name !== 'string' || typeof value.description !== 'string' || !record(value.main)) {
    throw new Error('Downloaded translation must have string name/description and a main dictionary');
  }
}

async function download(url: string, size: number, digest: string | undefined, fetcher: Fetch): Promise<Uint8Array> {
  let target = validateDownloadUrl(url);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetcher(target.href, { redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === 5) throw new Error('Invalid or excessive download redirects');
    target = new URL(location, target);
    if (target.protocol !== 'https:' || target.port || target.username || target.password
      || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) {
      throw new Error('Unsafe download redirect');
    }
    if (target.hostname === 'github.com') validateDownloadUrl(target.href);
  }
  if (!response?.ok) throw new Error(`Download failed: ${response?.status}`);
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_ASSET_BYTES || Number(length) !== size)) {
    await response.body?.cancel();
    throw new Error('Download Content-Length does not match asset size or limit');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_ASSET_BYTES || total > size) throw new Error('Download exceeds expected size or 20 MiB limit');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
  }
  if (total !== size) throw new Error(`Download size mismatch: expected ${size}, received ${total}`);
  const bytes = Buffer.concat(chunks, total);
  if (digest && sha256(bytes) !== digest.slice(7).toLowerCase()) throw new Error('Download SHA-256 digest mismatch');
  validateTranslation(bytes);
  return bytes;
}

async function atomicWrite(root: string, relativePath: string, bytes: string | Uint8Array): Promise<void> {
  const target = await assertSafePath(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  const temporaryPath = `${relativePath}.${randomUUID()}.tmp`;
  const temporary = await assertSafePath(root, temporaryPath);
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, target);
}

async function readCatalog(root: string): Promise<{ catalog: ReleaseCatalog; exists: boolean }> {
  const file = await assertSafePath(root, 'data/releases.json');
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    validateCatalog(value);
    return { catalog: value, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { catalog: { schemaVersion: 1, upstream: UPSTREAM, releases: [] }, exists: false };
    }
    throw error;
  }
}

export async function syncReleases(options: SyncOptions = {}): Promise<SyncResult> {
  const root = path.resolve(options.root ?? process.cwd());
  const fetcher = options.fetch ?? globalThis.fetch;
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const token = options.token ?? process.env.GITHUB_TOKEN;
  const { catalog: previous, exists: catalogExists } = await readCatalog(root);
  await assertSafePath(root, 'data/sync-state.json');
  await assertSafePath(root, 'public/.sync');
  const [tagValues, releaseValues] = await Promise.all([pages('tags', fetcher, token), pages('releases', fetcher, token)]);
  const tags = new Set(tagValues.map((tag) => {
    if (!record(tag)) throw new Error('Invalid upstream tag');
    return text(tag.name, 'tag name');
  }));
  const releases = releaseValues.filter((release) => {
    if (!record(release) || typeof release.draft !== 'boolean') throw new Error('Invalid upstream release');
    return !release.draft && tags.has(text(release.tag_name, 'release tag'));
  }).map(parseRelease);
  const next: ReleaseCatalog = structuredClone(previous);
  next.upstream = UPSTREAM;
  const pendingTags = [...tags].filter((tag) => !releases.some((release) => release.tag_name === tag && release.assets.length > 0)).sort();
  const publicRoot = path.join(root, 'public');
  let repaired = false;
  const handled = new Set<string>();
  const seenReleases = new Set<string>();
  for (const release of releases) {
    if (!release.assets.length) continue;
    if (seenReleases.has(release.id)) throw new Error(`Duplicate upstream release id: ${release.id}`);
    seenReleases.add(release.id);
    const prior = previous.releases.find((entry) => entry.source === 'upstream' && entry.id === release.id && entry.tag === release.tag_name);
    const assets: DownloadAsset[] = [];
    for (const upstreamAsset of release.assets) {
      validateDownloadUrl(upstreamAsset.browser_download_url);
      const old = prior?.assets.find((asset) => asset.id === upstreamAsset.id);
      const metadataMatches = old && old.size === upstreamAsset.size && old.sourceUrl === upstreamAsset.browser_download_url
        && old.upstreamUpdatedAt === upstreamAsset.updated_at && old.digest === upstreamAsset.digest;
      let asset: DownloadAsset;
      if (metadataMatches && await assetMatches(publicRoot, old)) {
        asset = { ...old, name: upstreamAsset.name, label: upstreamAsset.label };
      } else {
        const bytes = await download(upstreamAsset.browser_download_url, upstreamAsset.size, upstreamAsset.digest, fetcher);
        const hash = sha256(bytes);
        const assetPath = `downloads/releases/${release.id}/${upstreamAsset.id}-${hash.slice(0, 16)}.json`;
        asset = {
          id: upstreamAsset.id, name: upstreamAsset.name, label: upstreamAsset.label, path: assetPath,
          size: bytes.byteLength, sha256: hash, sourceUrl: upstreamAsset.browser_download_url,
          upstreamUpdatedAt: upstreamAsset.updated_at, ...(upstreamAsset.digest === undefined ? {} : { digest: upstreamAsset.digest }),
        };
        await atomicWrite(publicRoot, assetPath, bytes);
        if (old && metadataMatches) repaired = true;
      }
      assets.push(asset);
      handled.add(asset.path);
    }
    const entry: ReleaseEntry = {
      id: release.id, tag: release.tag_name, version: release.tag_name, title: release.name || release.tag_name,
      publishedAt: release.published_at, notes: release.body, source: 'upstream', releaseUrl: release.html_url,
      prerelease: release.prerelease, assets,
    };
    const existingIndex = next.releases.findIndex((candidate) => candidate.source === 'upstream' && candidate.id === entry.id);
    if (existingIndex === -1) next.releases.push(entry);
    else next.releases[existingIndex] = entry;
  }
  for (const release of next.releases) {
    for (const asset of release.assets) {
      if (handled.has(asset.path) || await assetMatches(publicRoot, asset)) continue;
      if (!asset.sourceUrl) throw new Error(`Cannot repair asset without source URL: ${asset.path}`);
      const bytes = await download(asset.sourceUrl, asset.size, `sha256:${asset.sha256}`, fetcher);
      await atomicWrite(publicRoot, asset.path, bytes);
      repaired = true;
    }
  }
  validateCatalog(next);
  const catalogChanged = !catalogExists || !isDeepStrictEqual(next, previous);
  const changed = catalogChanged || repaired;
  if (catalogChanged) await atomicWrite(root, 'data/releases.json', `${JSON.stringify(next, null, 2)}\n`);
  await atomicWrite(root, 'data/sync-state.json', `${JSON.stringify({ checkedAt, pendingTags }, null, 2)}\n`);
  const outputFile = options.outputFile === undefined ? process.env.GITHUB_OUTPUT : options.outputFile;
  if (outputFile) await appendFile(outputFile, `changed=${changed}\npending_count=${pendingTags.length}\n`);
  return { changed, pendingTags, catalog: next };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--root')) {
    console.error('Usage: tsx scripts/sync-releases.ts [--root directory]');
    process.exitCode = 1;
  } else {
    syncReleases({ root: args[1] }).then((result) => {
      console.log(`Official translations mirrored; changed=${result.changed}, pending=${result.pendingTags.length}`);
    }).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  }
}
