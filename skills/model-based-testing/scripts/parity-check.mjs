#!/usr/bin/env node
// Checks that every legacy end-to-end test has a parity ledger entry, and that
// each entry is complete enough to delete the legacy test safely.
//
// Usage:
//   node parity-check.mjs --inventory <file> --ledger <file> [--root <dir>]
//   node parity-check.mjs --inventory <file> --init [--root <dir>] > e2e-parity.json
//
// --init prints a ledger skeleton with one "todo" entry per legacy test.
//
// Inventory formats (detected automatically):
//   - Playwright: `npx playwright test --list --reporter=json > inventory.json`
//   - Vitest:     `npx vitest list <dir> --json=inventory.json`
//   - Generic:    a JSON array of { "id": "..." } or { "file": "...", "name": "..." }
//
// Exit codes: 0 = parity complete, 1 = gaps found, 2 = bad input.

import { readFileSync } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(message) {
  console.error(`parity-check: ${message}`);
  process.exit(2);
}

const inventoryPath = arg('inventory');
const ledgerPath = arg('ledger');
const root = resolve(arg('root') ?? process.cwd());
const init = process.argv.includes('--init');
if (!inventoryPath || (!ledgerPath && !init)) {
  fail('usage: parity-check.mjs --inventory <file> (--ledger <file> | --init) [--root <dir>]');
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}`);
  }
}

const normalizeFile = (file) =>
  (isAbsolute(file) ? relative(root, file) : file).split('\\').join('/');

const testId = (file, titles) =>
  `${normalizeFile(file)} > ${titles.filter(Boolean).join(' > ')}`;

function inventoryIds(data) {
  // Playwright JSON report: { suites: [{ file, specs, suites }] }
  if (data && Array.isArray(data.suites)) {
    const ids = [];
    const walk = (suite, titles, isFileSuite) => {
      const path = isFileSuite ? titles : [...titles, suite.title];
      for (const spec of suite.specs ?? []) {
        ids.push(testId(spec.file ?? suite.file, [...path, spec.title]));
      }
      for (const child of suite.suites ?? []) walk(child, path, false);
    };
    for (const fileSuite of data.suites) walk(fileSuite, [], true);
    return ids;
  }
  if (Array.isArray(data)) {
    return data.map((entry, i) => {
      if (typeof entry === 'string') return entry;
      if (entry.id) return entry.id;
      if (entry.file && entry.name) return testId(entry.file, [entry.name]);
      fail(`inventory entry ${i} has no "id" or "file" and "name"`);
    });
  }
  fail('unrecognized inventory format');
}

const inventory = [...new Set(inventoryIds(readJson(inventoryPath)))];

if (init) {
  const tests = inventory.map((id) => ({ id, status: 'todo', events: [], assertions: [] }));
  console.log(JSON.stringify({ version: 1, tests }, null, 2));
  process.exit(0);
}
const ledger = readJson(ledgerPath);
if (!Array.isArray(ledger.tests)) fail('ledger has no "tests" array');

const byId = new Map();
const errors = [];
const warnings = [];

for (const [i, entry] of ledger.tests.entries()) {
  const where = entry.id ? `"${entry.id}"` : `tests[${i}]`;
  if (!entry.id) {
    errors.push(`${where}: missing "id"`);
    continue;
  }
  if (byId.has(entry.id)) errors.push(`${where}: duplicate entry`);
  byId.set(entry.id, entry);

  switch (entry.status) {
    case 'mapped': {
      if (!Array.isArray(entry.events) || entry.events.length === 0) {
        errors.push(`${where}: mapped entry has no "events"`);
      } else if (entry.events.some((e) => !e || typeof e.type !== 'string')) {
        errors.push(`${where}: every event needs a string "type"`);
      }
      if (!Array.isArray(entry.assertions) || entry.assertions.length === 0) {
        errors.push(`${where}: mapped entry has no "assertions"`);
        break;
      }
      for (const [j, a] of entry.assertions.entries()) {
        if (!a.legacy) errors.push(`${where}: assertions[${j}] has no "legacy" text`);
        if (!a.oracle) errors.push(`${where}: assertions[${j}] has no "oracle"`);
        const steps = entry.events?.length ?? 0;
        if (!Number.isInteger(a.afterStep) || a.afterStep < 0 || a.afterStep > steps) {
          errors.push(`${where}: assertions[${j}].afterStep must be an integer from 0 to ${steps}`);
        }
      }
      break;
    }
    case 'residual':
      if (!entry.reason) errors.push(`${where}: residual entry has no "reason"`);
      if (!entry.keptIn) errors.push(`${where}: residual entry has no "keptIn" (where the legacy test still runs)`);
      break;
    case 'dropped':
      if (!entry.reason) errors.push(`${where}: dropped entry has no "reason"`);
      if (!entry.approvedBy) errors.push(`${where}: dropped entry has no "approvedBy" (a person must approve dropping coverage)`);
      break;
    default:
      errors.push(`${where}: status is "${entry.status}"; it must be "mapped", "residual", or "dropped"`);
  }
}

const unmapped = inventory.filter((id) => !byId.has(id));
for (const id of unmapped) errors.push(`"${id}": legacy test has no ledger entry`);

const inventorySet = new Set(inventory);
for (const id of byId.keys()) {
  const entry = byId.get(id);
  if (!inventorySet.has(id) && entry.status !== 'dropped') {
    warnings.push(`"${id}": ledger entry has no matching legacy test (renamed or already deleted?)`);
  }
}

const count = (status) => ledger.tests.filter((t) => t.status === status).length;
console.log(
  `legacy tests: ${inventory.length}, mapped: ${count('mapped')}, residual: ${count('residual')}, ` +
    `dropped: ${count('dropped')}, unmapped: ${unmapped.length}`
);
for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.log(`error: ${e}`);
console.log(errors.length ? 'parity: INCOMPLETE' : 'parity: complete');
process.exit(errors.length ? 1 : 0);
