import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../config/env.js';

/**
 * Evidence storage behind an interface.
 *
 * ADR-0006: screenshots and videos live on disk, not in SQLite. Keeping this
 * behind an interface makes a future move to object storage a one-file change
 * rather than a refactor of the capture pipeline.
 */
export interface EvidenceStorage {
  /** Absolute path for a new artifact, creating parent directories. */
  reserve(relativePath: string): Promise<string>;
  write(relativePath: string, data: Buffer): Promise<string>;
  read(relativePath: string): Promise<Buffer>;
  exists(absolutePath: string): Promise<boolean>;
  size(absolutePath: string): Promise<number>;
  remove(relativePath: string): Promise<void>;
  removeDirectory(relativePath: string): Promise<void>;
  /** Convert an absolute path back to a storage-relative key. */
  toRelative(absolutePath: string): string;
  absolute(relativePath: string): string;
}

export class LocalEvidenceStorage implements EvidenceStorage {
  constructor(private readonly root: string = paths.evidence) {}

  absolute(relativePath: string): string {
    const abs = path.resolve(this.root, relativePath);
    // Defence against traversal in any caller-supplied key.
    if (!abs.startsWith(path.resolve(this.root))) {
      throw new Error(`Refusing to access a path outside evidence storage: ${relativePath}`);
    }
    return abs;
  }

  toRelative(absolutePath: string): string {
    return path.relative(this.root, absolutePath).split(path.sep).join('/');
  }

  async reserve(relativePath: string): Promise<string> {
    const abs = this.absolute(relativePath);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    return abs;
  }

  async write(relativePath: string, data: Buffer): Promise<string> {
    const abs = await this.reserve(relativePath);
    await fsp.writeFile(abs, data);
    return abs;
  }

  async read(relativePath: string): Promise<Buffer> {
    return fsp.readFile(this.absolute(relativePath));
  }

  async exists(absolutePath: string): Promise<boolean> {
    try {
      await fsp.access(absolutePath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async size(absolutePath: string): Promise<number> {
    try {
      return (await fsp.stat(absolutePath)).size;
    } catch {
      return 0;
    }
  }

  async remove(relativePath: string): Promise<void> {
    await fsp.rm(this.absolute(relativePath), { force: true });
  }

  async removeDirectory(relativePath: string): Promise<void> {
    await fsp.rm(this.absolute(relativePath), { recursive: true, force: true });
  }
}

let storage: EvidenceStorage | null = null;
export function getStorage(): EvidenceStorage {
  if (!storage) storage = new LocalEvidenceStorage();
  return storage;
}
