import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { restoreData, persistData } from '../scripts/data-store.ts';
import { markPublished, shouldDeploy } from '../scripts/deployment-state.ts';
import { compareReleases, type ReleaseEntry } from '../src/lib/catalog.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 'Site test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Site test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
}).trim();

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'site-store-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^site-store-test-/);
    await rm(directory, { recursive: true, force: true });
  });
  const remote = path.join(directory, 'remote.git');
  const root = path.join(directory, 'source');
  await mkdir(root);
  git(directory, 'init', '--bare', remote);
  git(root, 'init', '-b', 'main');
  git(root, 'remote', 'add', 'origin', remote);
  await mkdir(path.join(root, 'data'));
  await mkdir(path.join(root, 'public/downloads'), { recursive: true });
  await writeFile(path.join(root, 'data/releases.json'), '{"releases":[]}\n');
  await writeFile(path.join(root, 'public/downloads/中文补丁.json'), '{}');
  await writeFile(path.join(root, 'README.md'), 'source document');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'source baseline');
  return { root, directory };
}

test('data branch bootstrap/persist/restore leaves source HEAD and index untouched', async (t) => {
  const { root } = await fixture(t);
  assert.equal(await restoreData(root), false);
  const sourceHead = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'data/sync-state.json'), '{"checkedAt":"2026-10-29"}');
  const snapshot = await persistData(root);
  assert.match(snapshot, /^[a-f0-9]{40}$/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), sourceHead);
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
  assert.equal(await persistData(root), snapshot);
  const files = git(root, 'ls-tree', '-r', '--name-only', snapshot);
  assert.equal(files.includes('README.md'), false);
  await writeFile(path.join(root, 'public/downloads/中文补丁.json'), 'corrupted');
  assert.equal(await restoreData(root), true);
  assert.equal(await readFile(path.join(root, 'public/downloads/中文补丁.json'), 'utf8'), '{}');
  assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'source document');
});

test('check-state-only commits stay separate from source history', async (t) => {
  const { root } = await fixture(t);
  const first = await persistData(root);
  await writeFile(path.join(root, 'data/sync-state.json'), '{"checkedAt":"later"}');
  const second = await persistData(root);
  assert.notEqual(second, first);
  assert.equal(git(root, 'rev-parse', `${second}^`), first);
  assert.equal(git(root, 'branch', '--show-current'), 'main');
});

test('failed publication remains eligible until marked; check timestamps do not redeploy', async (t) => {
  const { root } = await fixture(t);
  assert.equal(await shouldDeploy(root), true);
  assert.equal(await shouldDeploy(root), true);
  await markPublished(root);
  assert.equal(await shouldDeploy(root), false);
  await writeFile(path.join(root, 'data/sync-state.json'), '{"checkedAt":"later"}');
  assert.equal(await shouldDeploy(root), false);
  await writeFile(path.join(root, 'data/releases.json'), '{"releases":[1]}');
  assert.equal(await shouldDeploy(root), true);
});

test('release order uses numeric versions and prerelease identifiers', () => {
  const entry = (version: string): ReleaseEntry => ({ id: version, tag: `v${version}`, version, title: version, source: 'upstream', publishedAt: null, notes: '', prerelease: version.includes('-'), assets: [] });
  const versions = ['1.9.0', '1.10.0-rc.2', '1.10.0', '1.10.0-rc.10', '1.8.3'];
  assert.deepEqual(versions.map(entry).sort(compareReleases).map((r) => r.version), ['1.10.0', '1.10.0-rc.10', '1.10.0-rc.2', '1.9.0', '1.8.3']);
});
