import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const BRANCH = 'site-data';
const REMOTE_REF = `refs/remotes/origin/${BRANCH}`;
const git = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) => execFileSync('git', args, {
  cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
}).trim();

/** Restore only the data branch's catalog and mirrored downloads. */
export async function restoreData(root = process.cwd()): Promise<boolean> {
  const remote = git(['ls-remote', '--heads', 'origin', `refs/heads/${BRANCH}`], root);
  if (!remote) return false;
  git(['fetch', '--depth=1', 'origin', `refs/heads/${BRANCH}:${REMOTE_REF}`], root);
  const entries = git(['ls-tree', '-r', '-z', REMOTE_REF], root).split('\0').filter(Boolean);
  if (entries.some((entry) => {
    const [metadata, file] = entry.split('\t');
    return !metadata?.startsWith('100644 blob ') || !file
      || (!file.startsWith('data/') && !file.startsWith('public/downloads/'))
      || file.split('/').some((part) => !part || part === '.' || part === '..');
  })) {
    throw new Error('site-data must contain regular files under data/ and public/downloads/.');
  }
  await new Promise<void>((resolve, reject) => {
    const archive = spawn('git', ['archive', REMOTE_REF, 'data', 'public/downloads'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const extract = spawn('tar', ['-x', '-C', root], { stdio: ['pipe', 'ignore', 'pipe'] });
    let error = '';
    archive.stderr.on('data', (chunk) => { error += String(chunk); });
    extract.stderr.on('data', (chunk) => { error += String(chunk); });
    archive.stdout.pipe(extract.stdin);
    archive.on('error', reject);
    extract.on('error', reject);
    Promise.all([
      new Promise<number | null>((done) => archive.on('close', done)),
      new Promise<number | null>((done) => extract.on('close', done)),
    ]).then((codes) => codes.every((code) => code === 0) ? resolve() : reject(new Error(`Data restore failed: ${error}`))).catch(reject);
  });
  return true;
}

/** Commit data using an isolated index, without switching the source checkout. */
export async function persistData(root = process.cwd()): Promise<string> {
  const remote = git(['ls-remote', '--heads', 'origin', `refs/heads/${BRANCH}`], root);
  const parent = remote.split(/\s/)[0] || undefined;
  if (parent) git(['fetch', '--depth=1', 'origin', `refs/heads/${BRANCH}:${REMOTE_REF}`], root);
  const cache = path.resolve(root, '.cache');
  await mkdir(cache, { recursive: true });
  const index = path.join(cache, `data-index-${randomUUID()}`);
  const env = {
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'github-actions[bot]', GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  };
  git(['read-tree', '--empty'], root, env);
  git(['add', '--force', '--', 'data', 'public/downloads'], root, env);
  const tree = git(['write-tree'], root, env);
  if (parent && tree === git(['rev-parse', `${REMOTE_REF}^{tree}`], root)) return parent;
  const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'chore: update verified release mirror state'], root, env);
  git(['push', 'origin', `${commit}:refs/heads/${BRANCH}`], root, env);
  return commit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command !== 'restore' && command !== 'persist') {
    console.error('Usage: tsx scripts/data-store.ts restore|persist');
    process.exitCode = 1;
  } else {
    (command === 'restore' ? restoreData() : persistData()).then((result) => console.log(`${command}: ${result}`)).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  }
}
