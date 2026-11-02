/**
 * Take a consistent backup of the Lenz data directory.
 *
 *   npx tsx tools/probe/backup-data.mts [label]
 *
 * Writes to `backups/<timestamp>[-label]/` at the repo root (gitignored, and
 * deliberately OUTSIDE `data/` so that wiping `data/` cannot take the backup
 * with it).
 *
 * The database is copied with SQLite's own online-backup API rather than a file
 * copy. The server runs in WAL mode, so a plain `cp` of `lenz.db` can miss
 * everything still sitting in `lenz.db-wal` and produce a backup that is
 * missing the most recent writes - exactly the ones you would most want back.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { paths } from '../../apps/server/src/config/env.js';

const label = process.argv[2] ? `-${process.argv[2].replace(/[^a-zA-Z0-9-_]/g, '')}` : '';
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const root = path.join(paths.root, 'backups', `${stamp}${label}`);

await fsp.mkdir(root, { recursive: true });
console.log(`Backing up to ${root}\n`);

/* ---- database ---- */
if (fs.existsSync(paths.db)) {
  const db = new Database(paths.db, { readonly: true });
  const target = path.join(root, 'lenz.db');
  // VACUUM INTO produces a single consistent file including WAL contents.
  db.exec(`VACUUM INTO '${target.split('\\').join('/').replace(/'/g, "''")}'`);
  db.close();
  const bytes = fs.statSync(target).size;
  const probe = new Database(target, { readonly: true });
  const counts = ['projects', 'executions', 'screenshots', 'videos', 'findings', 'interaction_events']
    .map((t) => {
      try {
        return `${t}=${(probe.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n}`;
      } catch {
        return `${t}=n/a`;
      }
    })
    .join(' ');
  probe.close();
  console.log(`  database   ${(bytes / 1024 / 1024).toFixed(1)}MB  ${counts}`);
} else {
  console.log('  database   not present');
}

/* ---- evidence and cache ---- */
async function copyDir(from: string, to: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(from)) return { files, bytes };
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      const r = await copyDir(src, dst);
      files += r.files;
      bytes += r.bytes;
    } else if (entry.isFile()) {
      await fsp.copyFile(src, dst);
      files++;
      bytes += (await fsp.stat(dst)).size;
    }
  }
  return { files, bytes };
}

for (const [name, dir] of [
  ['evidence', paths.evidence],
  ['figma-cache', path.join(paths.data, 'figma-cache')],
] as const) {
  const r = await copyDir(dir, path.join(root, name));
  console.log(`  ${name.padEnd(10)} ${(r.bytes / 1024 / 1024).toFixed(1)}MB  ${r.files} files`);
}

await fsp.writeFile(
  path.join(root, 'README.txt'),
  [
    `Lenz data backup taken ${new Date().toISOString()}`,
    '',
    'To restore:',
    '  1. Stop the server.',
    '  2. Copy lenz.db over data/lenz.db and delete data/lenz.db-wal and data/lenz.db-shm.',
    '  3. Copy evidence/ over data/evidence/ and figma-cache/ over data/figma-cache/.',
    '  4. Start the server.',
    '',
    'The database was captured with SQLite VACUUM INTO, so it already includes',
    'everything that was in the write-ahead log at the time.',
  ].join('\n'),
  'utf8',
);

console.log(`\nDone. ${root}`);
