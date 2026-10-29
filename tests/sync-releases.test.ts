import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ReleaseCatalog } from '../src/lib/catalog.js';
import { isOfficialAsset, syncReleases, UPSTREAM, validateDownloadUrl } from '../scripts/sync-releases.js';
import { MAX_ASSET_BYTES, MAX_PUBLIC_BYTES, sha256, validateCatalog, verifyCatalog } from '../scripts/verify-catalog.js';

const api = `https://api.github.com/repos/${UPSTREAM}`;
const time = () => new Date('2026-01-02T03:04:05.000Z');
const payload = (name = 'Official translation') => Buffer.from(`{\n  "name": ${JSON.stringify(name)}, "description": "中文", "main": {"key": "值"}\n}\n`);
const urlFor = (tag: string, name: string) => `https://github.com/${UPSTREAM}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
function asset(id = 100, tag = 'v1.0.0', bytes = payload(), overrides: Record<string, unknown> = {}) {
  const name = `official-${tag}.json`;
  return {
    id, name, label: '官方翻译', size: bytes.length, browser_download_url: urlFor(tag, name),
    updated_at: '2026-01-01T00:00:00Z', digest: `sha256:${sha256(bytes)}`, ...overrides,
  };
}
function release(id = 1, tag = 'v1.0.0', assets = [asset(id * 100, tag)], overrides: Record<string, unknown> = {}) {
  return {
    id, tag_name: tag, name: `Release ${tag}`, body: '<script>alert("x")</script>\n**notes**',
    published_at: '2026-01-01T00:00:00Z', html_url: `https://github.com/${UPSTREAM}/releases/tag/${tag}`,
    draft: false, prerelease: false, assets, ...overrides,
  };
}
interface Calls { url: string; headers: Headers; redirect: RequestRedirect | undefined }
function fixture() {
  let tagPages: unknown[][] = [[{ name: 'v1.0.0', commit: { sha: 'same-commit' } }]];
  let releasePages: unknown[][] = [[release()]];
  const downloads = new Map<string, Uint8Array | (() => Response)>([[asset().browser_download_url, payload()]]);
  const calls: Calls[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect });
    const parsed = new URL(url);
    const endpoint = parsed.pathname.endsWith('/tags') ? 'tags' : parsed.pathname.endsWith('/releases') ? 'releases' : null;
    if (parsed.origin === 'https://api.github.com' && endpoint) {
      const pages = endpoint === 'tags' ? tagPages : releasePages;
      const page = Number(parsed.searchParams.get('page') ?? 1);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (page < pages.length) headers.link = `<${api}/${endpoint}?per_page=100&page=${page + 1}>; rel="next", <${api}/${endpoint}?page=${pages.length}>; rel="last"`;
      return new Response(JSON.stringify(pages[page - 1] ?? []), { headers });
    }
    const bytes = downloads.get(url);
    if (typeof bytes === 'function') return bytes();
    if (!bytes) return new Response('missing', { status: 404 });
    return new Response(bytes as BodyInit);
  };
  return {
    fetcher, calls, downloads,
    tags(...pages: unknown[][]) { tagPages = pages; },
    releases(...pages: unknown[][]) { releasePages = pages; },
  };
}
async function workspace(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'official-sync-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const options = (root: string, mock: ReturnType<typeof fixture>) => ({ root, fetch: mock.fetcher, now: time, token: 'test-secret', outputFile: null });
const readCatalog = async (root: string) => JSON.parse(await readFile(path.join(root, 'data/releases.json'), 'utf8')) as ReleaseCatalog;
const localAsset = (root: string, catalog: ReleaseCatalog, index = 0) => path.join(root, 'public', catalog.releases[index]!.assets[0]!.path);

test('paginates every tag and release page and catches up beyond twelve tags', async (t) => {
  const root = await workspace(t);
  const mock = fixture();
  const tags = Array.from({ length: 17 }, (_, i) => ({ name: `v1.0.${i}`, commit: { sha: 'shared-commit' } }));
  const releases = tags.map((tag, index) => release(index + 1, tag.name));
  mock.tags(tags.slice(0, 8), tags.slice(8, 13), tags.slice(13));
  mock.releases(releases.slice(0, 7), releases.slice(7));
  for (const entry of releases) mock.downloads.set(entry.assets[0]!.browser_download_url, payload());
  const result = await syncReleases(options(root, mock));
  assert.equal(result.changed, true);
  assert.equal(result.catalog.releases.length, 17);
  assert.deepEqual(result.pendingTags, []);
  assert.equal(new Set(result.catalog.releases.map((entry) => entry.id)).size, 17);
  assert.ok(mock.calls.some((call) => call.url.includes('/tags?per_page=100&page=3')));
  assert.ok(mock.calls.some((call) => call.url.includes('/releases?per_page=100&page=2')));
  assert.equal((await verifyCatalog({ root })).assets, 17);
});

test('pending tags retry when a release and eligible assets arrive on later runs', async (t) => {
  const root = await workspace(t);
  const mock = fixture();
  mock.tags([{ name: 'v1.0.0' }, { name: 'v1.1.0' }, { name: 'v1.2.0' }]);
  mock.releases([release(), release(2, 'v1.1.0', [])]);
  const first = await syncReleases(options(root, mock));
  assert.deepEqual(first.pendingTags, ['v1.1.0', 'v1.2.0']);
  const stillPending = await syncReleases(options(root, mock));
  assert.deepEqual(stillPending.pendingTags, first.pendingTags);
  assert.equal(stillPending.changed, false);
  const added = [release(2, 'v1.1.0'), release(3, 'v1.2.0')];
  mock.releases([release(), ...added]);
  for (const entry of added) mock.downloads.set(entry.assets[0]!.browser_download_url, payload());
  const second = await syncReleases(options(root, mock));
  assert.deepEqual(second.pendingTags, []);
  assert.equal(second.catalog.releases.length, 3);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'data/sync-state.json'), 'utf8')), {
    checkedAt: time().toISOString(), pendingTags: [],
  });
});

test('accepts legacy official label with _.v1.8.2.json and preserves existing legacy entries', async (t) => {
  const root = await workspace(t);
  const mock = fixture();
  const bytes = payload('旧版');
  const old: ReleaseCatalog = { schemaVersion: 1, upstream: UPSTREAM, releases: [{
    id: 'legacy-v1.0', tag: 'v1.0', version: 'v1.0', title: 'Legacy', publishedAt: null,
    notes: '', source: 'legacy', prerelease: false, assets: [{
      id: 'legacy-1', name: '旧版.json', label: '官方翻译', path: 'downloads/legacy/旧版.json', size: bytes.length, sha256: sha256(bytes),
    }],
  }] };
  await mkdir(path.join(root, 'data'), { recursive: true });
  await mkdir(path.join(root, 'public/downloads/legacy'), { recursive: true });
  await writeFile(path.join(root, 'data/releases.json'), JSON.stringify(old));
  await writeFile(localAsset(root, old), bytes);
  const eligible = asset(182, 'v1.8.2', payload(), { name: '_.v1.8.2.json', label: '基于官方翻译', browser_download_url: urlFor('v1.8.2', '_.v1.8.2.json') });
  mock.tags([{ name: 'v1.8.2' }]);
  mock.releases([release(18, 'v1.8.2', [eligible, asset(183, 'v1.8.2', payload(), { name: 'extra.json', label: '' })])]);
  mock.downloads.set(eligible.browser_download_url, payload());
  const result = await syncReleases(options(root, mock));
  assert.equal(result.catalog.releases.length, 2);
  assert.deepEqual(result.catalog.releases.find((entry) => entry.source === 'legacy'), old.releases[0]);
  assert.equal(result.catalog.releases.find((entry) => entry.source === 'upstream')!.assets.length, 1);
  assert.ok(isOfficialAsset({ name: 'OFFICIAL.json' }));
  assert.ok(!isOfficialAsset({ name: 'official.zip' }));
});

test('asset id, digest, and updated_at replacements fetch and keep earlier SHA paths intact', async (t) => {
  const root = await workspace(t);
  const mock = fixture();
  let result = await syncReleases(options(root, mock));
  let previousPath = localAsset(root, result.catalog);
  let previousBytes = await readFile(previousPath);
  for (const change of ['id', 'digest', 'updated_at']) {
    const nextBytes = payload(change === 'id' ? 'Official translation' : change === 'digest' ? 'Official translatiom' : 'Official translatioo');
    const nextAsset = asset(101, 'v1.0.0', nextBytes,
      change === 'updated_at' ? { digest: null, updated_at: '2026-02-01T00:00:00Z' } : {});
    if (change === 'updated_at') {
      const before = asset(101, 'v1.0.0', payload('Official translatiom'), { digest: null });
      mock.releases([release(1, 'v1.0.0', [before])]);
      mock.downloads.set(before.browser_download_url, payload('Official translatiom'));
      result = await syncReleases(options(root, mock));
      previousPath = localAsset(root, result.catalog);
      previousBytes = await readFile(previousPath);
    }
    mock.releases([release(1, 'v1.0.0', [nextAsset])]);
    mock.downloads.set(nextAsset.browser_download_url, nextBytes);
    const count = mock.calls.length;
    result = await syncReleases(options(root, mock));
    assert.equal(result.changed, true);
    assert.ok(mock.calls.slice(count).some((call) => call.url === nextAsset.browser_download_url));
    assert.notEqual(localAsset(root, result.catalog), previousPath);
    assert.deepEqual(await readFile(previousPath), previousBytes);
    assert.deepEqual(await readFile(localAsset(root, result.catalog)), nextBytes);
    previousPath = localAsset(root, result.catalog);
    previousBytes = nextBytes;
  }
});

test('repairs corrupt and missing files, counts repairs as changed, and preserves catalog bytes', async (t) => {
  const root = await workspace(t);
  const mock = fixture();
  const first = await syncReleases(options(root, mock));
  const catalogPath = path.join(root, 'data/releases.json');
  const catalogBytes = await readFile(catalogPath);
  const file = localAsset(root, first.catalog);
  await writeFile(file, Buffer.alloc(payload().length, 120));
  const outputFile = path.join(root, 'output');
  const repaired = await syncReleases({ ...options(root, mock), outputFile });
  assert.equal(repaired.changed, true);
  assert.equal(await readFile(outputFile, 'utf8'), 'changed=true\npending_count=0\n');
  assert.deepEqual(await readFile(catalogPath), catalogBytes);
  assert.deepEqual(await readFile(file), payload());
  await rm(file);
  assert.equal((await syncReleases(options(root, mock))).changed, true);
  assert.deepEqual(await readFile(file), payload());
});

test('no-op preserves catalog bytes and mtime, updates state, and sends token only to API', async (t) => {
  const root = await workspace(t);
  const mock = fixture();
  const secondRelease = release(2, 'v2.0.0');
  mock.tags([{ name: 'v1.0.0' }, { name: 'v2.0.0' }]);
  mock.releases([release(), secondRelease]);
  mock.downloads.set(secondRelease.assets[0]!.browser_download_url, payload());
  const first = await syncReleases(options(root, mock));
  const catalogPath = path.join(root, 'data/releases.json');
  const reordered = structuredClone(first.catalog);
  reordered.releases.reverse();
  await writeFile(catalogPath, `${JSON.stringify(reordered, null, 4)}\n\n`);
  const bytes = await readFile(catalogPath);
  const mtime = (await stat(catalogPath)).mtimeMs;
  const count = mock.calls.length;
  const outputFile = path.join(root, 'output');
  const later = () => new Date('2026-02-03T04:05:06.000Z');
  const second = await syncReleases({ ...options(root, mock), now: later, outputFile });
  assert.equal(second.changed, false);
  assert.deepEqual(await readFile(catalogPath), bytes);
  assert.equal((await stat(catalogPath)).mtimeMs, mtime);
  assert.equal(mock.calls.slice(count).filter((call) => new URL(call.url).origin !== 'https://api.github.com').length, 0);
  assert.equal(JSON.parse(await readFile(path.join(root, 'data/sync-state.json'), 'utf8')).checkedAt, later().toISOString());
  assert.equal(await readFile(outputFile, 'utf8'), 'changed=false\npending_count=0\n');
  assert.deepEqual(await readFile(localAsset(root, first.catalog)), payload());
  for (const call of mock.calls) {
    assert.equal(call.headers.get('authorization'), new URL(call.url).origin === 'https://api.github.com' ? 'Bearer test-secret' : null);
    assert.equal(call.redirect, 'manual');
  }
  assert.equal(first.catalog.releases[0]!.notes, '<script>alert("x")</script>\n**notes**');
  const withoutToken = mock.calls.length;
  await syncReleases({ ...options(root, mock), token: '' });
  assert.ok(mock.calls.slice(withoutToken).every((call) => call.headers.get('authorization') === null));
});

test('any bad eligible download leaves catalog and successful-check state unchanged', async (t) => {
  const root = await workspace(t);
  const mock = fixture();
  await syncReleases(options(root, mock));
  const before = await readFile(path.join(root, 'data/releases.json'));
  const state = await readFile(path.join(root, 'data/sync-state.json'));
  mock.tags([{ name: 'v1.0.0' }, { name: 'v2.0.0' }, { name: 'v3.0.0' }]);
  const good = release(2, 'v2.0.0');
  const bad = release(3, 'v3.0.0');
  mock.releases([release(), good, bad]);
  mock.downloads.set(good.assets[0]!.browser_download_url, payload());
  mock.downloads.set(bad.assets[0]!.browser_download_url, Buffer.alloc(payload().length, 120));
  await assert.rejects(syncReleases(options(root, mock)), /digest mismatch/);
  assert.deepEqual(await readFile(path.join(root, 'data/releases.json')), before);
  assert.deepEqual(await readFile(path.join(root, 'data/sync-state.json')), state);
  assert.equal((await readCatalog(root)).releases.length, 1);
});

test('same commit tags remain distinct, draft is pending, and prerelease flag is retained', async (t) => {
  const root = await workspace(t);
  const mock = fixture();
  const tags = ['v1.0.0', 'v1.1.0', 'v2.0.0-beta.1', 'v3.0.0'];
  mock.tags(tags.map((name) => ({ name, commit: { sha: 'same-commit' } })));
  const entries = tags.map((tag, i) => release(i + 1, tag, [asset((i + 1) * 100, tag)], {
    draft: i === 3, prerelease: i === 2,
  }));
  mock.releases(entries);
  for (const entry of entries) mock.downloads.set(entry.assets[0]!.browser_download_url, payload());
  const result = await syncReleases(options(root, mock));
  assert.deepEqual(result.pendingTags, ['v3.0.0']);
  assert.deepEqual(new Set(result.catalog.releases.map((entry) => entry.tag)), new Set(tags.slice(0, 3)));
  assert.equal(result.catalog.releases.find((entry) => entry.tag === 'v2.0.0-beta.1')!.prerelease, true);
  assert.ok(!mock.calls.some((call) => call.url === entries[3]!.assets[0]!.browser_download_url));
});

test('download redirects receive no API token', async (t) => {
  const root = await workspace(t);
  const mock = fixture();
  const redirected = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/data';
  mock.downloads.set(asset().browser_download_url, () => new Response(null, { status: 302, headers: { location: redirected } }));
  mock.downloads.set(redirected, payload());
  await syncReleases(options(root, mock));
  assert.equal(mock.calls.find((call) => call.url === redirected)!.headers.get('authorization'), null);
});

test('rejects unsafe URLs, oversize assets, size mismatch, malformed JSON, and bad JSON shape', async (t) => {
  for (const unsafe of [
    `http://github.com/${UPSTREAM}/releases/download/v1/a.json`,
    `https://github.com/another/repo/releases/download/v1/a.json`,
    `https://example.com/${UPSTREAM}/releases/download/v1/a.json`,
    `https://github.com/${UPSTREAM}/raw/main/official.json`,
    `https://user:secret@github.com/${UPSTREAM}/releases/download/v1/a.json`,
  ]) assert.throws(() => validateDownloadUrl(unsafe));
  for (const scenario of ['limit', 'size', 'json', 'shape', 'digest', 'redirect', 'length', 'stream', 'utf8']) {
    const root = await workspace(t);
    const mock = fixture();
    let bytes = payload();
    let upstream = asset();
    if (scenario === 'limit') upstream = asset(100, 'v1.0.0', bytes, { size: MAX_ASSET_BYTES + 1 });
    if (scenario === 'size') bytes = Buffer.from('short');
    if (scenario === 'json') { bytes = Buffer.from('{'); upstream = asset(100, 'v1.0.0', bytes); }
    if (scenario === 'shape') { bytes = Buffer.from('{"name":"x","description":"y","main":[]}'); upstream = asset(100, 'v1.0.0', bytes); }
    if (scenario === 'digest') upstream = asset(100, 'v1.0.0', bytes, { digest: `sha256:${'0'.repeat(64)}` });
    if (scenario === 'utf8') { bytes = Buffer.from([0xff]); upstream = asset(100, 'v1.0.0', bytes); }
    if (scenario === 'stream') upstream = asset(100, 'v1.0.0', bytes, { size: MAX_ASSET_BYTES, digest: null });
    mock.releases([release(1, 'v1.0.0', [upstream])]);
    mock.downloads.set(upstream.browser_download_url, scenario === 'redirect'
      ? () => new Response(null, { status: 302, headers: { location: 'http://example.com/data' } })
      : scenario === 'length' ? () => new Response(bytes, { headers: { 'content-length': String(bytes.length + 1) } })
      : scenario === 'stream' ? () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(MAX_ASSET_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      } })) : bytes);
    await assert.rejects(syncReleases(options(root, mock)), /size|limit|JSON|dictionary|digest|redirect/i);
    await assert.rejects(readFile(path.join(root, 'data/releases.json')), { code: 'ENOENT' });
  }
});

test('verification checks containment, symlinks, size/SHA, and counts all public files toward budget', async (t) => {
  const root = await workspace(t);
  const mock = fixture();
  const result = await syncReleases(options(root, mock));
  const catalog = structuredClone(result.catalog);
  catalog.releases[0]!.assets[0]!.path = '../escape.json';
  assert.throws(() => validateCatalog(catalog), /Unsafe/);
  await writeFile(path.join(root, 'public/extra.bin'), Buffer.alloc(100));
  await assert.rejects(verifyCatalog({ root, budgetBytes: payload().length + 99 }), /budget/);
  assert.equal((await verifyCatalog({ root })).publicBytes, payload().length + 100);
  const file = localAsset(root, result.catalog);
  await writeFile(file, Buffer.alloc(payload().length, 120));
  await assert.rejects(verifyCatalog({ root }), /corrupt/);
  await writeFile(file, payload());
  const link = path.join(root, 'public/link');
  await symlink(tmpdir(), link);
  await assert.rejects(verifyCatalog({ root }), /Symbolic links/);
});

test('initializes an empty schema-one catalog and reports pending counts without repeated catalog changes', async (t) => {
  const root = await workspace(t);
  const mock = fixture();
  mock.releases([]);
  const outputFile = path.join(root, 'output');
  const first = await syncReleases({ ...options(root, mock), outputFile });
  assert.equal(first.changed, true);
  assert.deepEqual(first.pendingTags, ['v1.0.0']);
  assert.deepEqual(await readCatalog(root), { schemaVersion: 1, upstream: UPSTREAM, releases: [] });
  assert.deepEqual(await verifyCatalog({ root }), { releases: 0, assets: 0, publicBytes: 0 });
  assert.equal((await syncReleases({ ...options(root, mock), outputFile })).changed, false);
  assert.equal(await readFile(outputFile, 'utf8'), 'changed=true\npending_count=1\nchanged=false\npending_count=1\n');
});

test('default public budget allows exactly 700 MiB and rejects one additional byte', async (t) => {
  const root = await workspace(t);
  const mock = fixture();
  await syncReleases(options(root, mock));
  const sparseFile = path.join(root, 'public/site-budget.bin');
  await writeFile(sparseFile, '');
  await truncate(sparseFile, MAX_PUBLIC_BYTES - payload().length);
  assert.equal((await verifyCatalog({ root })).publicBytes, MAX_PUBLIC_BYTES);
  await truncate(sparseFile, MAX_PUBLIC_BYTES - payload().length + 1);
  await assert.rejects(verifyCatalog({ root }), /budget/);
});

test('rejects API pagination that would send credentials outside the repository API', async (t) => {
  const root = await workspace(t);
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response('[]', { headers: { link: '<https://example.com/tags?page=2>; rel="next"' } });
  };
  await assert.rejects(syncReleases({ root, fetch: fetcher, token: 'secret', outputFile: null }), /Unsafe API pagination/);
  assert.ok(calls.every((url) => new URL(url).origin === 'https://api.github.com'));
});
