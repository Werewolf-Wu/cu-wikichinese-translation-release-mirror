import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep CLI telemetry disabled for local development and automated builds.
process.env.ASTRO_TELEMETRY_DISABLED = '1';
const require = createRequire(import.meta.url);
const astroRoot = path.dirname(require.resolve('astro/package.json'));
await import(pathToFileURL(path.join(astroRoot, 'bin/astro.mjs')).href);
