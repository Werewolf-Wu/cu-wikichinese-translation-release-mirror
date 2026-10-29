/** Prefix every local public asset with the configured Astro base path. */
export function sitePath(path: string): string {
  return `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}${path.replace(/^\/+/, '')}`;
}
