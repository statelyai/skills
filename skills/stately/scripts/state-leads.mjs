#!/usr/bin/env node
// Lists state-review leads for a git diff: tagged changed lines, writers and
// readers of each touched state value, exit-parity hints, and removed guards.
// Output is a lead list for a reviewer, never a set of findings.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CODE_EXT =
  /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|py|go|rs|rb|java|kt|kts|scala|swift|m|mm|c|cc|cpp|cxx|h|hh|hpp|cs|php|ex|exs|erl|dart|lua|sql|sh|zig)$/i;
const SKIP_PATH =
  /(^|\/)(node_modules|vendor|third_party|dist|build|out|\.next|coverage)\/|\.min\.[jc]ss?$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum)$/;

const STATE_NAME =
  /^(?:is|has|should|can|was|did)[A-Z_]|(?:status|state|phase|mode|stage|step|busy|loading|pending|locked|active|running|ready|dirty|inflight|disposed|closed|closing|opened|started|stopped|cancell?ed|aborted|done|finished|initialized|connected|syncing|saving|uploading|processing|generation|epoch|revision|version|attempts?|retries|count)$/i;

const SIGNALS = [
  ['exit', /(?:^\s*|[;{)]\s*|\belse\s+|:\s*)(?:return|throw|raise|break|continue|panic)\b|\b(?:os\.Exit|process\.exit)\b/],
  ['error', /\bcatch\b|\bexcept\b|\.catch\(|\bif\s+err\s*!=\s*nil\b|\brecover\(|\bon[Ee]rror\b|\bErr\(|\bfailed?\b/],
  ['async', /\bawait\b|\.then\(|\basync\b|\bgo\s+func\b|\bgo\s+\w+\(|\bPromise\b|\bspawn\b|\bqueueMicrotask\b|\btokio::|\bthread\b/],
  ['timer', /\bset(?:Timeout|Interval)\b|\bclear(?:Timeout|Interval)\b|\bdebounce\b|\bthrottle\b|\bretry\b|\bbackoff\b|\btime\.After\b|\bticker\b/i],
  ['lifecycle', /\b(?:dispose|destroy|close|unmount|cleanup|teardown|unsubscribe|removeEventListener|addEventListener|subscribe|abort|cancel|shutdown|stop|start|init|initialize|finally|defer|useEffect)\b/i],
  ['persist', /\b(?:migrat\w*|schema|transaction|commit|rollback|localStorage|sessionStorage|indexedDB|persist|save|upsert|insert|update|delete|ALTER\s+TABLE|CREATE\s+TABLE)\b/i],
  ['case', /^\s*case\b|\bswitch\b|\bmatch\b|^\s*enum\b|\benum\s+\w+|^\s*\|\s*['"]\w+['"]/],
  ['pair', /\b(?:inc|dec|increment|decrement|acquire|release|lock|unlock|retain|unref|ref)\s*\(|\+\+|--(?!-)/],
  ['guard', /^\s*(?:if|elif|else\s+if|unless|guard|while)\b.*\b(?:status|state|phase|mode|is[A-Z]\w*|has[A-Z]\w*|busy|loading|pending|locked|disposed|closed|running|ready)\b/],
];

// Areas where a missed state bug is expensive; a hit recommends the thorough profile.
const RISK =
  /\b(?:migrat\w*|transaction\w*|webhook\w*|enqueue\w*|queue\w*|jobs?|workers?|payments?|charge\w*|refund\w*|invoice\w*|billing|checkout|subscriptions?|sync\w*|replica\w*|lease\w*|idempoten\w*|retry|retries|backoff|cache\w*|persist\w*|localStorage|indexedDB|serviceWorker|mutex\w*|semaphore\w*|atomic\w*|repository|upsert|insert\w*|deleteMany|updateMany|dirty|flush\w*|fsync|database|goroutine|Promise\.all|asyncio|concurren\w*|archiv\w*|store|\w+Store)\b|\.(?:save|update|delete|remove|destroy)\w*\(/i;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec)\/|[._-](?:test|spec)\.[^/]+$|_test\.go$/i;
const COMMENT = /^\s*(?:\/\/|#|\*|\/\*|--|;)/;

/** Pick none, single, or thorough from what the diff touches. */
export function recommendProfile(codeFiles, lines, detached) {
  if (!codeFiles.length) return { mode: 'none', reasons: ['no executable code changed'] };
  const risky = lines.filter(
    (entry) => !TEST_PATH.test(entry.path) && !COMMENT.test(entry.text) && RISK.test(entry.text),
  );
  const reasons = risky
    .slice(0, 5)
    .map((entry) => `${entry.path}:${entry.line} ${RISK.exec(entry.text)[0].replace(/^\./, '').replace(/\($/, '')}`);
  if (detached.length) reasons.push(`${detached.length} detached or no-longer-awaited call(s)`);
  return risky.length || detached.length
    ? { mode: 'thorough', reasons }
    : { mode: 'single', reasons: ['no persistence, store, queue, payment, sync, cache, lock, or detached-work signal'] };
}

/** Tags for one source line. */
export function lineTags(text) {
  return SIGNALS.filter(([, re]) => re.test(text)).map(([tag]) => tag);
}

const lowerFirst = (name) => name[0].toLowerCase() + name.slice(1);

/** State-bearing identifiers that a line writes or compares. */
export function stateIdentifiers(text) {
  const found = new Set();
  for (const match of text.matchAll(/\bset([A-Z]\w*)\s*\(/g)) {
    found.add(`set${match[1]}`);
    found.add(lowerFirst(match[1]));
  }
  for (const match of text.matchAll(
    /(?:^|[^\w.])(?:(?:this|self|s|m|ctx|state|store)\s*(?:\.|->)\s*)?([A-Za-z_]\w*)\s*(?:=(?![=>])|\+=|-=|\+\+|--)/g,
  )) {
    const name = match[1];
    const rhs = text.slice(match.index + match[0].length).trim();
    if (
      STATE_NAME.test(name) ||
      /^(?:true|false|True|False|null|None|nil|undefined)\b|^['"]\w+['"]|^[A-Z]\w*\.[A-Z]\w*/.test(rhs)
    )
      found.add(name);
  }
  for (const match of text.matchAll(/(?:\.|->)([A-Za-z_]\w*)\s*(?:={1,3}|!==?|=(?!=))\s*['"A-Z]/g))
    if (STATE_NAME.test(match[1])) found.add(match[1]);
  for (const match of text.matchAll(/(?:^|[^\w.>])([A-Za-z_]\w*)\s*(?:===?|!==?)\s*['"A-Z]|['"]\w*['"]\s*(?:===?|!==?)\s*([A-Za-z_]\w*)/g)) {
    const name = match[1] ?? match[2];
    if (STATE_NAME.test(name)) found.add(name);
  }
  for (const match of text.matchAll(
    /\b([A-Za-z_]\w*)\s*\.\s*(?:inc|dec|increment|decrement|acquire|release|r?lock|r?unlock|trylock|add|delete|remove|set|clear)\s*\(/gi,
  ))
    if (STATE_NAME.test(match[1]) || /^(?:pending|inFlight|active|running|locks?|queue|seen|processed)/i.test(match[1]))
      found.add(match[1]);
  for (const reserved of ['this', 'self', 'err', 'error', 'e', 'i', 'j', 'k', 'n', 'x', 'result', 'value', 'data', 'res', 'ret', 'ok'])
    found.delete(reserved);
  return [...found].filter((name) => name.length > 2);
}

/** Undo git's C-style path quoting ("b/caf\303\251.ts"). */
export function unquotePath(raw) {
  if (!raw.startsWith('"')) return raw;
  const bytes = [];
  const body = raw.slice(1, raw.lastIndexOf('"'));
  const simple = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char !== '\\') {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const next = body[i + 1];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Parse unified diff output (any context size) into changed lines per file. */
export function parseDiff(diff) {
  const files = [];
  let file;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { path: line.split(' b/').pop(), added: [], removed: [] };
      files.push(file);
    } else if (!file) continue;
    else if (line.startsWith('+++ ')) {
      if (line !== '+++ /dev/null') file.path = unquotePath(line.slice(4)).replace(/^b\//, '');
    } else if (line.startsWith('--- ')) continue;
    else if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldLine = Number(match[1]);
      newLine = Number(match[2]);
    } else if (line.startsWith('+')) file.added.push({ line: newLine++, text: line.slice(1) });
    else if (line.startsWith('-')) file.removed.push({ line: oldLine++, text: line.slice(1) });
    else if (line.startsWith(' ')) {
      oldLine++;
      newLine++;
    }
  }
  return files;
}

const BUSY_SET = [
  // [pattern capturing the value name, reset pattern factory]
  [/\bset([A-Z]\w*)\s*\(\s*(?:true|['"]\w+['"])/, (name) => new RegExp(`\\bset${name}\\s*\\(\\s*(?:false|null|undefined|['"]\\w*['"])`)],
  [/\b([A-Za-z_]\w*)\s*=\s*(?:true|True)\b/, (name) => new RegExp(`\\b${name}\\s*=\\s*(?:false|False|null|None|nil|undefined)\\b`)],
  [/(?:\.|->)(status|state|phase|mode)\s*=\s*['"](\w+)['"]/, (name) => new RegExp(`(?:\\.|->)${name}\\s*=\\s*['"]\\w+['"]`)],
  [/\b([A-Za-z_]\w*)\s*\.\s*(?:acquire|lock|inc|increment)\s*\(/, (name) => new RegExp(`\\b${name}\\s*\\.\\s*(?:release|unlock|dec|decrement)\\s*\\(`)],
];
const FUNCTION_HEAD =
  /^\s*(?:export\s+)?(?:async\s+)?function\b|^\s*(?:async\s+)?def\s|^\s*func\s|^\s*(?:pub\s+)?(?:async\s+)?fn\s|=>\s*\{\s*$|^\s*(?:public|private|protected|static|async|\s)*(?!(?:if|for|while|switch|catch|with|else|do|foreach|elif|unless|until)\b)[A-Za-z_]\w*\s*\([^;]*\)\s*(?::[^{=]*)?\{\s*$/;
const PROTECTED = /\bfinally\b|\bdefer\b|\busing\b|\bwith\b.*:\s*$|\bscope(?:guard|_exit)\b/i;

/** Exits added between a busy-value set and its reset on the happy path. */
export function exitParityHints(path, headLines, addedLines) {
  const hints = [];
  const exits = addedLines.filter((entry) => lineTags(entry.text).includes('exit'));
  for (const exit of exits) {
    const index = exit.line - 1;
    for (let back = index - 1; back >= Math.max(0, index - 80); back--) {
      const text = headLines[back] ?? '';
      let matched = false;
      for (const [setPattern, resetFor] of BUSY_SET) {
        const set = setPattern.exec(text);
        if (!set) continue;
        const name = set[1];
        if (!STATE_NAME.test(name) && setPattern !== BUSY_SET[0][0] && setPattern !== BUSY_SET[3][0]) continue;
        const reset = resetFor(name);
        matched = true;
        if (headLines.slice(back + 1, index).some((between) => reset.test(between))) break;
        let resetLine;
        for (let fwd = index + 1; fwd < Math.min(headLines.length, index + 120); fwd++)
          if (reset.test(headLines[fwd])) {
            resetLine = fwd;
            break;
          }
        const protectedReset =
          resetLine !== undefined &&
          headLines.slice(Math.max(back, resetLine - 8), resetLine + 1).some((line) => PROTECTED.test(line));
        const protectedSet = headLines.slice(back, index).some((line) => PROTECTED.test(line));
        if (protectedReset || protectedSet) break;
        hints.push({
          path,
          exit: exit.line,
          exitText: exit.text.trim(),
          value: name,
          set: back + 1,
          reset: resetLine === undefined ? null : resetLine + 1,
          note:
            resetLine === undefined
              ? `added exit after ${name} is set at line ${back + 1}; no reset seen within 120 lines`
              : `added exit between ${name} set at line ${back + 1} and its reset at line ${resetLine + 1}, outside finally`,
        });
        break;
      }
      if (matched || FUNCTION_HEAD.test(text)) break;
    }
  }
  return hints;
}

const RESET =
  /\bset[A-Z]\w*\s*\(\s*(?:false|null|undefined)|\b\w+\s*=\s*(?:false|False|null|None|nil)\b/;
const PROTECTION =
  /\b(?:release|unlock|dec|decrement|clearTimeout|clearInterval|unsubscribe|removeEventListener|abort|dispose|close)\s*\(|\bfinally\b|\bdefer\b|\btransaction\b|\bmigrat/i;

/** Removed lines that reset state, guard a transition, or protect a write. */
export function removedProtections(path, removedLines) {
  return removedLines
    .filter(({ text }) => RESET.test(text) || PROTECTION.test(text) || lineTags(text).includes('guard'))
    .map(({ line, text }) => ({ path, line, text: text.trim() }));
}

const DETACHED =
  /^\s*(?:void\s+)?(?:this\.|self\.)?[\w.$]+(?:\([^;]*\))?\s*\.then\(|^\s*void\s+[\w.$]+\(|^\s*go\s+(?:func\b|[\w.]+\()|\b(?:tokio::spawn|thread::spawn|asyncio\.create_task|asyncio\.ensure_future|loop\.create_task|threading\.Thread|executor\.submit|queueMicrotask|setImmediate)\s*\(|^\s*set(?:Timeout|Interval)\s*\(/;

const JS_LIKE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte)$/i;

/** Work started without awaiting it, and awaits the change removed. */
export function detachedWork(path, added, removed) {
  const leads = added
    .filter(({ text }) => DETACHED.test(text))
    .map(({ line, text }) => ({ path, line, text: text.trim(), note: 'starts work that nothing awaits; check what it writes after the caller moves on' }));
  const addedTexts = added.map(({ text }) => text.trim());
  // Drops whitespace but keeps `await ` so it stays a separate word.
  const compact = (text) =>
    text.replace(/\bawait\s+/g, '\u0000').replace(/\s+/g, '').replace(/\u0000/g, 'await ');
  for (const { line, text } of removed) {
    const match = /\bawait\s+([\w.$]+\s*\()/.exec(text);
    if (!match) continue;
    const call = match[1].replace(/\s+/g, '');
    // Still awaited when the call runs inside a callback that an earlier
    // `await` on the same expression receives (`await measure('x', () =>
    // call())`), or, in JS and TS, when it is returned to an awaiting caller.
    // An await inside the call's own arguments does not count.
    const returnsAwait = JS_LIKE.test(path);
    const wrapped = (text, callAt) => {
      const before = text.slice(0, callAt);
      if (/\bawait $/.test(before)) return true;
      const awaitAt = before.search(/\bawait\b/);
      return awaitAt >= 0 && before.slice(awaitAt).includes('=>');
    };
    const awaited = (index) => {
      const own = compact(addedTexts[index]);
      const callAt = own.indexOf(call);
      if (wrapped(own, callAt)) return true;
      if (returnsAwait && /^return\b/.test(addedTexts[index])) return true;
      // A wrapper opened above: every line between it and the call must leave
      // the expression open (end in `=>`, `(`, or `,`).
      for (let back = 1; back <= 2 && index - back >= 0; back++) {
        if (added[index - back].line !== added[index].line - back) break;
        const above = compact(addedTexts[index - back]);
        if (!/(?:=>|\(|,)$/.test(above)) break;
        if (wrapped(above, above.length)) return true;
      }
      return false;
    };
    const index = addedTexts.findIndex(
      (candidate, at) => compact(candidate).includes(call) && !awaited(at),
    );
    if (index >= 0)
      leads.push({
        path,
        line: added[index].line,
        text: added[index].text.trim(),
        note: `removed await of ${match[1].trim()}...) (old line ${line}); callers now continue before it settles`,
      });
  }
  return leads;
}

const WRITE = (name) =>
  new RegExp(
    `(?:\\b${name}\\s*(?:=(?![=>])|\\+=|-=|\\+\\+|--)|\\b${name}\\s*\\.\\s*(?:push|set|add|delete|clear|splice|inc|dec|increment|decrement|acquire|release|[Ll]ock|[Uu]nlock|RLock|RUnlock|[Tt]ry[Ll]ock)\\s*\\(|^\\s*(?:\\+\\+|--)${name}\\b)`,
  );

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Writers and readers of one identifier at the head revision. */
export function lookup(name, head, cwd, limit = 60) {
  // Callers raise the cap with --max-sites; the report names any truncation.
  let output = '';
  try {
    output = git(['grep', '-n', '-I', '-w', '-e', name, head, '--'], cwd);
  } catch (error) {
    if (error.status === 1) return { writers: [], readers: [], truncated: false };
    throw error;
  }
  const writers = [];
  const readers = [];
  const write = WRITE(name.replace(/[$]/g, '\\$'));
  const setter = /^set[A-Z]/.test(name) ? new RegExp(`\\b${name}\\s*\\(`) : null;
  let total = 0;
  for (const row of output.split('\n')) {
    if (!row) continue;
    const match = /^[^:]+:(.+?):(\d+):(.*)$/.exec(row);
    if (!match || SKIP_PATH.test(match[1])) continue;
    total++;
    const site = { path: match[1], line: Number(match[2]), text: match[3].trim().slice(0, 160) };
    if (write.test(match[3]) || setter?.test(match[3])) writers.push(site);
    else readers.push(site);
  }
  return {
    writers: writers.slice(0, limit),
    readers: readers.slice(0, limit),
    totalWriters: writers.length,
    totalReaders: readers.length,
    truncated: writers.length > limit || readers.length > limit || total > 2 * limit,
  };
}

/** Build the lead report for base...head in the repository at cwd. */
export function stateLeads({ base, head = 'HEAD', cwd = process.cwd(), maxValues = 25, maxSites = 60 }) {
  // Merge-base semantics like a PR; fall back to the base itself when the
  // history between the two is missing (shallow clones).
  let from = base;
  try {
    from = git(['merge-base', base, head], cwd).trim() || base;
  } catch {
    from = base;
  }
  const headRev = head;
  const range = `${base}...${head}`;
  const files = parseDiff(git(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-U0', from, head], cwd));
  const code = files.filter((file) => CODE_EXT.test(file.path) && !SKIP_PATH.test(file.path));
  const skipped = files.filter((file) => !code.includes(file)).map((file) => file.path);
  const counts = new Map();
  const tagged = [];
  const hints = [];
  const removed = [];
  const detached = [];
  for (const file of code) {
    let headLines = [];
    if (file.added.length)
      try {
        headLines = git(['show', `${headRev}:${file.path}`], cwd).split('\n');
      } catch {
        headLines = [];
      }
    hints.push(...exitParityHints(file.path, headLines, file.added));
    removed.push(...removedProtections(file.path, file.removed));
    detached.push(...detachedWork(file.path, file.added, file.removed));
    for (const [sign, entries] of [['+', file.added], ['-', file.removed]])
      for (const entry of entries) {
        const tags = lineTags(entry.text);
        const ids = stateIdentifiers(entry.text);
        for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
        if (tags.length || ids.length)
          tagged.push({ path: file.path, sign, line: entry.line, tags, values: ids, text: entry.text.trim().slice(0, 160) });
      }
  }
  const values = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxValues)
    .map(([name, changed]) => ({ name, changed, ...lookup(name, headRev, cwd, maxSites) }));
  const allLines = code.flatMap((file) => [
    ...file.added.map((entry) => ({ ...entry, path: file.path })),
    ...file.removed.map((entry) => ({ ...entry, path: file.path })),
  ]);
  return {
    range,
    profile: recommendProfile(code, allLines, detached),
    codeFiles: code.map((file) => ({ path: file.path, added: file.added.length, removed: file.removed.length })),
    skipped,
    exitParity: hints,
    removedProtections: removed,
    detachedWork: detached,
    values,
    valuesOmitted: Math.max(0, counts.size - maxValues),
    lines: tagged,
  };
}

const site = (entry) => `${entry.path}:${entry.line}`;

/** Markdown rendering of a lead report. */
export function formatLeads(report) {
  const out = [`# State leads for ${report.range}`, ''];
  if (!report.codeFiles.length) {
    out.push('Recommended profile: none (no executable code changed).', '');
    out.push('No executable code changed. Skipped: ' + (report.skipped.join(', ') || 'none') + '.');
    return out.join('\n');
  }
  out.push(`Recommended profile: ${report.profile.mode} (${report.profile.reasons.join('; ')}).`, '');
  out.push(
    `Code files: ${report.codeFiles.map((file) => `${file.path} (+${file.added} -${file.removed})`).join(', ')}.`,
  );
  if (report.skipped.length) out.push(`Skipped non-code files: ${report.skipped.join(', ')}.`);
  out.push('', 'Leads, not findings. Close each one in the ledger.', '', '## Exit-parity hints', '');
  out.push(...(report.exitParity.length ? report.exitParity.map((hint) => `- ${hint.path}:${hint.exit} \`${hint.exitText}\`: ${hint.note}`) : ['- none detected; still run exit parity on handlers that set state']));
  out.push('', '## Removed resets, guards, and protections', '');
  out.push(...(report.removedProtections.length ? report.removedProtections.map((entry) => `- ${site(entry)} \`${entry.text}\``) : ['- none']));
  out.push('', '## Detached async work', '');
  out.push(...(report.detachedWork.length ? report.detachedWork.map((entry) => `- ${site(entry)} \`${entry.text}\`: ${entry.note}`) : ['- none']));
  out.push('', '## State values touched', '', '| value | changed lines | writers | readers |', '| --- | --- | --- | --- |');
  for (const value of report.values)
    out.push(`| \`${value.name}\` | ${value.changed} | ${value.totalWriters} | ${value.totalReaders} |`);
  if (report.valuesOmitted) out.push('', `${report.valuesOmitted} more values omitted; raise --max-values to list them.`);
  for (const value of report.values) {
    if (!value.totalWriters && !value.totalReaders) continue;
    out.push('', `### \`${value.name}\``, '');
    for (const writer of value.writers) out.push(`- write ${site(writer)} \`${writer.text}\``);
    if (value.totalWriters > value.writers.length) out.push(`- ${value.totalWriters - value.writers.length} more writers`);
    for (const reader of value.readers) out.push(`- read ${site(reader)} \`${reader.text}\``);
    if (value.totalReaders > value.readers.length) out.push(`- ${value.totalReaders - value.readers.length} more readers`);
    if (value.truncated)
      out.push(`- truncated: raise --max-sites or run \`git grep -n -w ${value.name}\` before closing client or sibling leads`);
  }
  out.push('', '## Tagged changed lines', '');
  for (const entry of report.lines)
    out.push(`- ${entry.sign}${site(entry)} [${[...entry.tags, ...entry.values.map((value) => `value:${value}`)].join(', ')}] \`${entry.text}\``);
  return out.join('\n');
}

function parseArgs(argv) {
  const options = { head: 'HEAD', json: false, maxValues: 25, maxSites: 60 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') options.base = argv[++i];
    else if (arg === '--head') options.head = argv[++i];
    else if (arg === '--json') options.json = true;
    else if (arg === '--max-values') options.maxValues = Number(argv[++i]);
    else if (arg === '--max-sites') options.maxSites = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw Error(`Unknown argument ${arg}`);
  }
  return options;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const options = parseArgs(argv);
  if (options.help || !options.base) {
    return 'Usage: state-leads.mjs --base BASE [--head HEAD] [--json] [--max-values N] [--max-sites N]\n' +
      'Compares BASE...HEAD (merge-base semantics). Run from the repository root.';
  }
  const report = stateLeads({ ...options, cwd });
  return options.json ? JSON.stringify(report, null, 2) : formatLeads(report);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.stdout.write(main() + '\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}
