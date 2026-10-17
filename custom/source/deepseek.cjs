#!/usr/bin/env node
'use strict';

// Narrow hotfix for 9Router's legacy DeepSeek effort normalization.
// Changes only deepseek-v4.1-flash-free with an explicit low effort.
const MARK = '9R_DS41_LOW_V1';

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


module.exports={transform};
