#!/usr/bin/env node
'use strict';

// Narrow hotfix for 9Router's legacy DeepSeek effort normalization.
// Changes only deepseek-v4.1-flash-free with an explicit low effort.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const MARK = '9R_DS41_LOW_V1';
const STATE = '/app/.ds41-low-fix';

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function transform(code) {
  const branches = [...code.matchAll(/\bcase\s*["']deepseek["']\s*:/g)];
  let edits = [];
  for (const b of branches) {
    const start = b.index + b[0].length;
    const tail = code.slice(start);
    const next = /\b(?:case\s*["'][^"']*["']\s*:|default\s*:)/.exec(tail);
    const branch = next ? tail.slice(0, next.index) : tail;
    if (branch.includes(MARK)) continue;
    const mapping = /(?:([A-Za-z_$][\w$]*)\s*===\s*["']xhigh["']|["']xhigh["']\s*===\s*([A-Za-z_$][\w$]*))\s*\|\|\s*(?:([A-Za-z_$][\w$]*)\s*===\s*["']max["']|["']max["']\s*===\s*([A-Za-z_$][\w$]*))\s*\?\s*["']max["']\s*:\s*["']high["']/g;
    const hits = [...branch.matchAll(mapping)];
    if (!hits.length) continue;
    if (hits.length !== 1) throw new Error('Ambiguous DeepSeek mapping; no changes made.');
    const hit = hits[0];
    const level = hit[1] || hit[2];
    if (level !== (hit[3] || hit[4])) throw new Error('Unexpected effort expression.');
    const funcs = [...code.slice(0, b.index).matchAll(/\bfunction(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)\s*\{/g)];
    const params = funcs.at(-1)?.[1].split(',').map(s => s.trim());
    const body = params?.[1];
    if (!body || !/^[A-Za-z_$][\w$]*$/.test(body)) throw new Error('Cannot identify request-body argument.');
    for (const field of ['thinking', 'reasoning_effort']) {
      if (!new RegExp('\\b' + escapeRegex(body) + '\\s*\\.\\s*' + field + '\\s*=').test(branch)) {
        throw new Error('Request-body verification failed for ' + field);
      }
    }
    const modelCheck = '/(?:^|\\/)deepseek-v4\\.1-flash-free(?:\\([^()]*\\))?$/.test(String(' + body + '.model||""))';
    const replacement = '/*' + MARK + '*/(' + level + '==="low"&&' + modelCheck + '?"low":(' + hit[0] + '))';
    edits.push({ index: start + hit.index, old: hit[0], replacement });
  }
  for (const e of edits.sort((a, b) => b.index - a.index)) {
    code = code.slice(0, e.index) + e.replacement + code.slice(e.index + e.old.length);
  }
  return { code, count: edits.length };
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  let files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(p));
    else if (entry.isFile() && /\.(?:js|cjs|mjs)$/.test(entry.name)) files.push(p);
  }
  return files;
}

function restore() {
  const manifest = JSON.parse(fs.readFileSync(path.join(STATE, 'manifest.json'), 'utf8'));
  // Verify every backup before restoring any file.
  const originals = manifest.files.map(f => ({ ...f, data: fs.readFileSync(f.backup) }));
  for (const f of originals) {
    fs.writeFileSync(f.file, f.data);
    fs.chmodSync(f.file, f.mode);
    console.log('Restored:', f.file);
  }
  fs.renameSync(path.join(STATE, 'manifest.json'), path.join(STATE, 'restored-' + Date.now() + '.json'));
  console.log('Rollback complete. Restart the container.');
}

function main() {
  if (process.argv.includes('--rollback')) return restore();
  const dry = process.argv.includes('--dry-run');
  const source = '/app/open-sse/translator/concerns/thinkingUnified.js';
  const compiled = '/app/.next/server';
  if (!fs.existsSync(source) || !fs.existsSync(compiled)) throw new Error('Unsupported container layout; nothing changed.');
  if (fs.existsSync(path.join(STATE, 'manifest.json'))) {
    const previous = JSON.parse(fs.readFileSync(path.join(STATE, 'manifest.json'), 'utf8'));
    const intact = previous.files?.length > 0 && previous.files.every(f =>
      fs.existsSync(f.file) && fs.readFileSync(f.file, 'utf8').includes(MARK));
    if (intact) return console.log('PATCH ALREADY APPLIED: no changes needed.');
    throw new Error('Previous patch state is inconsistent; refusing to overwrite backups.');
  }
  const candidates = [source, ...walk(compiled)];
  const changes = [];
  for (const file of candidates) {
    const original = fs.readFileSync(file, 'utf8');
    const result = transform(original);
    if (!result.count) continue;
    const check = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: result.code, encoding: 'utf8', maxBuffer: 1024 * 1024,
    });
    if (check.status !== 0) throw new Error('Syntax check failed: ' + file + '\n' + check.stderr);
    changes.push({ file, original, updated: result.code, mode: fs.statSync(file).mode & 0o777 });
  }
  if (!changes.some(f => f.file.startsWith(compiled + '/'))) {
    throw new Error('No matching compiled server code found; nothing changed. Send this output for a version-specific patch.');
  }
  if (!changes.some(f => f.file === source)) throw new Error('Source rule did not match; nothing changed.');
  for (const f of changes) console.log((dry ? 'Would patch: ' : 'Patch: ') + f.file);
  if (dry) return console.log('DRY RUN OK: ' + changes.length + ' files; no files changed.');
  const backupDir = path.join(STATE, 'backup-' + Date.now());
  fs.mkdirSync(backupDir, { recursive: true });
  const manifest = { version: 1, created: new Date().toISOString(), files: [] };
  for (let i = 0; i < changes.length; i++) {
    const f = changes[i];
    const backup = path.join(backupDir, i + '.original');
    fs.writeFileSync(backup, f.original);
    manifest.files.push({ file: f.file, backup, mode: f.mode });
  }
  fs.copyFileSync(__filename, path.join(STATE, 'patch.cjs'));
  fs.writeFileSync(path.join(STATE, 'manifest.json'), JSON.stringify(manifest, null, 2));
  try {
    for (const f of changes) fs.writeFileSync(f.file, f.updated);
  } catch (error) {
    for (const f of changes) fs.writeFileSync(f.file, f.original);
    throw error;
  }
  console.log('PATCH OK. Only explicit low on deepseek-v4.1-flash-free is changed.');
  console.log('Restart 9router, then test a new request and check THINK:LOW.');
  console.log('Rollback: node /app/.ds41-low-fix/patch.cjs --rollback');
}

module.exports = { transform };
if (require.main === module) {
  try { main(); } catch (error) { console.error('STOP:', error.message); process.exitCode = 1; }
}
