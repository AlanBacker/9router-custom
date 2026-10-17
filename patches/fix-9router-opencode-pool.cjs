#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const MARK = '9R_OC_POOL_V1';
const STATE = '/app/.opencode-pool-fix';
const readWidget = () => fs.readFileSync(path.join(__dirname, 'opencode-pool-ui.js'), 'utf8') + '\n;' + fs.readFileSync(path.join(__dirname, 'opencode-public-proxy-ui.js'), 'utf8');

function transformRegistry(code) {
  let count = 0;
  const pattern = /(\bid\s*:\s*["']opencode["'][\s\S]{0,1200}?\bcategory\s*:\s*)["']free["'](\s*,\s*noAuth\s*:\s*)(?:true|!0)/g;
  code = code.replace(pattern, (whole, before, between) => {
    if (!/\bname\s*:\s*["']OpenCode Free["']/.test(before) || !/\balias\s*:\s*["']oc["']/.test(before)) {
      throw new Error('OpenCode registry identity could not be verified.');
    }
    count++;
    // The transport's own noAuth stays true. Only credential selection/UI uses this flag.
    return `${before}"freeTier"${between}false/*${MARK}*/,authModes:["apikey"]`;
  });
  return {code, count};
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => {
    const file = path.join(dir, e.name);
    return e.isDirectory() ? walk(file) : (e.isFile() && /\.(js|mjs|cjs)$/.test(e.name) ? [file] : []);
  });
}

function main() {
  const dry = process.argv.includes('--dry-run');
  const manifestFile = path.join(STATE, 'manifest.json');
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.files?.length && manifest.files.every(f => fs.existsSync(f.file) && fs.readFileSync(f.file, 'utf8').includes(MARK))) {
      const widget = readWidget();
      const updates = [];
      for (const f of manifest.files.filter(f => f.file.startsWith('/app/.next/static/'))) {
        const code = fs.readFileSync(f.file, 'utf8');
        const start = code.indexOf('/* 9R_OC_POOL_UI_V1 */');
        if (start < 0 || start !== code.lastIndexOf('/* 9R_OC_POOL_UI_V1 */')) throw new Error('Ambiguous pool widget state');
        const updated = code.slice(0, start) + widget + '\n';
        const check = spawnSync(process.execPath, ['--input-type=module', '--check'], {input: updated, encoding:'utf8'});
        if (check.status !== 0) throw new Error('Updated pool widget syntax invalid');
        if (updated !== code) updates.push({file:f.file,updated});
      }
      if (!dry) for (const f of updates) fs.writeFileSync(f.file, f.updated);
      console.log('OPENCODE POOL ALREADY APPLIED.');
      return;
    }
    throw new Error('Previous OpenCode pool patch state is inconsistent.');
  }
  const source = '/app/open-sse/providers/registry/opencode.js';
  const server = '/app/.next/server';
  const client = '/app/.next/static';
  if (!fs.existsSync(source)) throw new Error('Unsupported registry layout; no changes made.');
  const widget = readWidget();
  const changes = [];
  for (const file of [source, ...walk(server), ...walk(client)]) {
    const original = fs.readFileSync(file, 'utf8');
    const result = transformRegistry(original);
    if (!result.count) continue;
    let updated = result.code;
    if (file.startsWith(client + '/')) updated += '\n;' + widget + '\n';
    const check = spawnSync(process.execPath, ['--input-type=module', '--check'], {input: updated, encoding: 'utf8', maxBuffer: 1024*1024});
    if (check.status !== 0) throw new Error('Syntax validation failed: ' + file + '\n' + check.stderr);
    changes.push({file, original, updated});
  }
  if (!changes.some(f => f.file === source) || !changes.some(f => f.file.startsWith(server + '/')) || !changes.some(f => f.file.startsWith(client + '/'))) {
    throw new Error('Source, compiled server and compiled client must all match; no changes made.');
  }
  for (const f of changes) console.log((dry ? 'Would patch: ' : 'Patch: ') + f.file);
  if (dry) return console.log('OPENCODE POOL DRY RUN OK: ' + changes.length + ' files.');
  const backupDir = path.join(STATE, 'backup-' + Date.now());
  fs.mkdirSync(backupDir, {recursive: true});
  const manifest = {version: 1, files: []};
  for (const [index, f] of changes.entries()) {
    const backup = path.join(backupDir, index + '.original');
    fs.writeFileSync(backup, f.original);
    manifest.files.push({file: f.file, backup});
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  try { for (const f of changes) fs.writeFileSync(f.file, f.updated); }
  catch (error) {
    for (const f of changes) fs.writeFileSync(f.file, f.original);
    fs.unlinkSync(manifestFile);
    throw error;
  }
  console.log('OPENCODE POOL PATCH OK: managed connections, standard rotation and batch creation UI enabled.');
}

module.exports = {transformRegistry};
if (require.main === module) {
  try { main(); } catch (error) { console.error('OPENCODE POOL STOP:', error.message); process.exitCode = 1; }
}
