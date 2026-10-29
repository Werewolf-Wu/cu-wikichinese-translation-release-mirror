import { defineConfig } from 'astro/config';

const basePath = process.env.BASE_PATH || '/';
if (!basePath.startsWith('/') || /[?#\\]/.test(basePath)) {
  throw new Error('BASE_PATH 必须是以 / 开头的站点路径。');
}

export default defineConfig({
  output: 'static',
  site: process.env.SITE_URL || undefined,
  base: basePath,
  trailingSlash: 'always',
  server: { port: 4321 },
});
