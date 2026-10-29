import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DeploymentSignature { source: string; catalog: string; site: string; base: string }
export async function deploymentSignature(root = process.cwd()): Promise<DeploymentSignature> {
  return {
    source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    catalog: createHash('sha256').update(await readFile(path.join(root, 'data/releases.json'))).digest('hex'),
    site: process.env.SITE_URL || '', base: process.env.BASE_PATH || '/',
  };
}
export async function shouldDeploy(root = process.cwd()): Promise<boolean> {
  const current = await deploymentSignature(root);
  try {
    const previous = JSON.parse(await readFile(path.join(root, 'data/published.json'), 'utf8')) as DeploymentSignature;
    return JSON.stringify(previous) !== JSON.stringify(current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return true;
    throw error;
  }
}
export async function markPublished(root = process.cwd()): Promise<void> {
  await writeFile(path.join(root, 'data/published.json'), `${JSON.stringify(await deploymentSignature(root), null, 2)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'mark') await markPublished();
    else if (process.argv[2] === 'check') {
      const needed = await shouldDeploy() || process.env.MIRROR_REPAIRED === 'true';
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
      console.log(`Deployment needed: ${needed}`);
    } else throw new Error('Usage: tsx scripts/deployment-state.ts check|mark');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
