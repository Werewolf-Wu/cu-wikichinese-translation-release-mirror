export interface DownloadAsset {
  id: string;
  name: string;
  label: string;
  /** Site-relative path inside public/, without an initial slash. */
  path: string;
  size: number;
  sha256: string;
  sourceUrl?: string;
  upstreamUpdatedAt?: string;
  digest?: string;
}

export interface ReleaseEntry {
  id: string;
  tag: string;
  version: string;
  title: string;
  publishedAt: string | null;
  notes: string;
  source: 'upstream' | 'legacy';
  releaseUrl?: string;
  prerelease: boolean;
  assets: DownloadAsset[];
}

export interface ReleaseCatalog {
  schemaVersion: 1;
  upstream: string;
  releases: ReleaseEntry[];
}

/** Numeric version comparison with stable releases before their prereleases. */
export function compareReleases(a: ReleaseEntry, b: ReleaseEntry): number {
  const parse = (version: string) => {
    const match = version.replace(/^v/i, '').match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:-([^+]+))?(?:\+.*)?$/);
    return match ? { parts: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)], pre: match[4] ?? '' } : null;
  };
  const av = parse(a.version);
  const bv = parse(b.version);
  if (av && bv) {
    for (let i = 0; i < 3; i++) {
      const difference = bv.parts[i]! - av.parts[i]!;
      if (difference) return difference;
    }
    if (av.pre !== bv.pre) {
      if (!av.pre) return -1;
      if (!bv.pre) return 1;
      const aa = av.pre.split('.');
      const ba = bv.pre.split('.');
      for (let i = 0; i < Math.max(aa.length, ba.length); i++) {
        if (aa[i] === undefined) return 1;
        if (ba[i] === undefined) return -1;
        if (aa[i] === ba[i]) continue;
        const an = /^\d+$/.test(aa[i]!);
        const bn = /^\d+$/.test(ba[i]!);
        if (an && bn) return Number(ba[i]) - Number(aa[i]);
        if (an !== bn) return an ? 1 : -1;
        return ba[i]!.localeCompare(aa[i]!, 'en');
      }
    }
  } else if (av || bv) {
    return av ? -1 : 1;
  }
  if (a.source !== b.source) return a.source === 'upstream' ? -1 : 1;
  return (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || a.tag.localeCompare(b.tag, 'en') || a.id.localeCompare(b.id, 'en');
}

export function sortedReleases(catalog: ReleaseCatalog): ReleaseEntry[] {
  return [...catalog.releases].sort(compareReleases);
}

export function latestStable(catalog: ReleaseCatalog): ReleaseEntry | undefined {
  return sortedReleases(catalog).find((release) => !release.prerelease && release.source === 'upstream')
    ?? sortedReleases(catalog).find((release) => !release.prerelease);
}

export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MB` : `${Math.round(bytes / 1024)} KB`;
}
