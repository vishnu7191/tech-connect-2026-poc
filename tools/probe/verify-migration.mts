/**
 * Verify that an EXISTING Lenz database still reads correctly after the
 * interaction-tracking migration, and that its recordings and screenshots are
 * untouched.
 *
 * Point it at a COPY of a real database - it opens the file for writing, which
 * applies any pending column migrations.
 *
 *   npx tsx tools/probe/verify-migration.mts <path-to-db-copy>
 */
import fs from 'node:fs';
import { openDatabase } from '../../apps/server/src/db/index.js';
import { Repositories } from '../../apps/server/src/db/repositories.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: npx tsx tools/probe/verify-migration.mts <path-to-db-copy>');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(2);
}

console.log(`Opening ${file}\n`);
const db = openDatabase(file);
const repos = new Repositories(db);

const projects = repos.listProjects();
let executions = 0;
let playableVideos = 0;
let screenshots = 0;
let validScreenshots = 0;
let missingFiles = 0;
const deviceSummary = new Map<string, number>();

for (const p of projects) {
  for (const e of repos.listExecutions(p.id)) {
    executions++;
    const key = e.device === null ? '(not recorded)' : e.device.id;
    deviceSummary.set(key, (deviceSummary.get(key) ?? 0) + 1);

    const v = repos.getVideoForExecution(e.id);
    if (v && v.status === 'complete' && v.bytes > 0) {
      playableVideos++;
      if (v.path && !fs.existsSync(v.path)) missingFiles++;
    }
  }
  for (const s of repos.listScreenshots({ projectId: p.id })) {
    screenshots++;
    if (s.status === 'valid') {
      validScreenshots++;
      if (s.path && !fs.existsSync(s.path)) missingFiles++;
    }
  }
}

const columns = (table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

const required: Array<[string, string]> = [
  ['executions', 'device'],
  ['videos', 'start_offset_ms'],
  ['videos', 'device_id'],
  ['screenshots', 'device_id'],
  ['screenshots', 'device_scale_factor'],
];

let fail = 0;
for (const [table, column] of required) {
  const present = columns(table).includes(column);
  console.log(`  ${present ? 'PASS' : 'FAIL'}  ${table}.${column} present`);
  if (!present) fail++;
}
for (const table of ['interaction_events', 'scroll_samples']) {
  const present = columns(table).length > 0;
  console.log(`  ${present ? 'PASS' : 'FAIL'}  table ${table} present`);
  if (!present) fail++;
}

console.log('');
console.log(`  Projects                 ${projects.length}`);
console.log(`  Executions               ${executions}`);
console.log(`  Playable recordings      ${playableVideos}`);
console.log(`  Screenshots              ${screenshots} (${validScreenshots} valid)`);
console.log(`  Evidence files missing   ${missingFiles}`);
console.log(`  Interaction events       ${repos.listInteractionEvents({}).length}`);
console.log(`  Scroll samples           ${repos.listScrollSamples({}).length}`);
console.log('');
console.log('  Executions by recorded device:');
for (const [k, n] of [...deviceSummary.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${n.toString().padStart(4)}  ${k}`);
}

db.close();

if (fail > 0) {
  console.log(`\n${fail} schema check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nSchema is current and existing evidence reads back intact.');
}
