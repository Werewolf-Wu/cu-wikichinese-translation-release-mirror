import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const fixture = path.join(root, '.cache/browser-fixture');
await mkdir(path.join(fixture, 'data'), { recursive: true });
for (const file of ['src', 'public', 'package.json', 'tsconfig.json', 'astro.config.mjs']) {
  await cp(path.join(root, file), path.join(fixture, file), { recursive: true });
}
const catalog = JSON.parse(await readFile(path.join(root, 'data/releases.json'), 'utf8'));
for (let i = 1; i <= 6; i++) {
  catalog.releases.push({
    ...catalog.releases.at(-1), id: `browser-fixture-${i}`, tag: `v0.0.${i}-fixture`, version: `0.0.${i}-fixture`,
    title: '浏览器测试数据', notes: '仅用于验证长历史列表。<script>window.injected = true</script>',
  });
}
await writeFile(path.join(fixture, 'data/releases.json'), JSON.stringify(catalog));
const result = spawnSync(process.execPath, ['scripts/astro.mjs', 'build', '--root', fixture], {
  cwd: root, stdio: 'inherit', env: { ...process.env, BASE_PATH: '/fixture-site', SITE_URL: 'https://example.invalid' },
});
if (result.status !== 0) process.exit(result.status ?? 1);
