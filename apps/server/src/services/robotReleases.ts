// Robot self-update: the newest Autoflow-Robot-<version>.zip in the installers folder
// (put there by update-server.ps1 -Installers) is what robots update to.
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface RobotRelease {
  version: string;
  file: string;
  size: number;
  /** Robots check the download against this before installing it. */
  sha256: string;
  url: string;
}

const NAME = /^Autoflow-Robot-(\d+\.\d+\.\d+)\.zip$/;
/** A package written to in the last moments may still be downloading: robots would get half a file. */
const SETTLE_MS = 15_000;

/** -1, 0 or 1 like a sort comparator; "0.10.0" is newer than "0.9.1". */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export class RobotReleases {
  private hashes = new Map<string, { key: string; sha256: Promise<string> }>();

  constructor(private readonly dir: string) {}

  /** Newest (fully copied) robot package on this server, without reading it. */
  newest(): { version: string; file: string } | null {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return null;
    }
    const found = names
      .map((file) => ({ file, version: NAME.exec(file)?.[1] }))
      .filter((f): f is { file: string; version: string } => !!f.version)
      .sort((a, b) => compareVersions(b.version, a.version));
    return found.find((f) => this.settled(f.file)) ?? null;
  }

  private settled(file: string): boolean {
    try {
      return Date.now() - statSync(join(this.dir, file)).mtimeMs > SETTLE_MS;
    } catch {
      return false;
    }
  }

  async latest(): Promise<RobotRelease | null> {
    const newest = this.newest();
    if (!newest) return null;
    const path = join(this.dir, newest.file);
    const stat = statSync(path);
    const key = `${stat.size}:${stat.mtimeMs}`;
    let cached = this.hashes.get(newest.file);
    if (!cached || cached.key !== key) {
      cached = { key, sha256: hashFile(path) };
      this.hashes.set(newest.file, cached);
    }
    return { ...newest, size: stat.size, sha256: await cached.sha256, url: `/downloads/${encodeURIComponent(newest.file)}` };
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}
