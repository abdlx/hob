// Offline evidence summarization only. Input documents are data, never executable tasks.
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseBenchmarkCsv(input) {
  const rows = []; let row = [], field = '', quoted = false;
  const text = input.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && char === ',') { row.push(field); field = ''; }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(field); if (row.some(value => value.length)) rows.push(row);
      row = []; field = '';
    } else field += char;
    if (field.length > 500000 || rows.length > 10000) throw new Error('Benchmark input exceeds report limits.');
  }
  if (quoted) throw new Error('Unclosed quoted CSV field.');
  row.push(field); if (row.some(value => value.length)) rows.push(row);
  const headers = rows.shift();
  if (!headers || headers.some(value => !value) || new Set(headers).size !== headers.length) throw new Error('Unique CSV headers are required.');
  for (const name of ['id', 'area', 'status', 'pass', 'clean_pass', 'score', 'max_score', 'elapsed_seconds']) if (!headers.includes(name)) throw new Error(`Missing benchmark column: ${name}`);
  return rows.map(values => {
    if (values.length !== headers.length) throw new Error('CSV field count does not match its header.');
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

function boolean(value) {
  if (value === '') return null;
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  throw new Error('Benchmark decisions must be explicit booleans or empty.');
}
function number(value) {
  if (value === '') return null;
  const parsed = Number(value);
  if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(parsed)) throw new Error('Benchmark scores and times must be non-negative finite numbers or empty.');
  return parsed;
}
function median(values) {
  const midpoint = Math.floor(values.length / 2);
  return values.length ? values.length % 2 ? values[midpoint] : (values[midpoint - 1] + values[midpoint]) / 2 : null;
}

export function summarizeBenchmark(protocol, csv) {
  if (!protocol || !Array.isArray(protocol.cases)) throw new Error('A benchmark protocol with a case list is required.');
  const declared = new Map(protocol.cases.map(item => [item.id, item]));
  if (!declared.size || declared.size !== protocol.cases.length || [...declared.keys()].some(id => typeof id !== 'string')) throw new Error('The protocol needs unique declared case IDs.');
  const seen = new Set();
  const attempts = parseBenchmarkCsv(csv).map(row => {
    if (!/^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(row.id) || !['reasoning', 'coding', 'browser', 'research'].includes(row.area)) throw new Error('Invalid benchmark identity or area.');
    const specification = declared.get(row.id);
    if (!specification || (specification.area && specification.area !== row.area)) throw new Error('Result identity or area is not declared in the protocol.');
    const attempt = row.attempt === undefined ? 1 : number(row.attempt);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || (protocol.single_attempt === true && attempt !== 1)) throw new Error('Attempt identity conflicts with the frozen protocol.');
    const identity = `${row.id}:${attempt}`;
    if (seen.has(identity)) throw new Error('Duplicate task attempt.'); seen.add(identity);
    const score = number(row.score), maximum = number(row.max_score);
    if (score !== null && (maximum === null || score > maximum)) throw new Error('Reported score exceeds its rubric maximum.');
    return { id: row.id, area: row.area, attempt, status: row.status.slice(0, 64), pass: boolean(row.pass), clean: boolean(row.clean_pass), score, maximum, seconds: number(row.elapsed_seconds) };
  });
  const areas = Object.fromEntries(['reasoning', 'coding', 'browser', 'research'].map(area => {
    const rows = attempts.filter(row => row.area === area);
    const times = rows.filter(row => row.seconds !== null).map(row => row.seconds).sort((a, b) => a - b);
    return [area, { attempts: rows.length, distinctTasks: new Set(rows.map(row => row.id)).size,
      passes: rows.filter(row => row.pass === true).length, failures: rows.filter(row => row.pass === false).length, unjudged: rows.filter(row => row.pass === null).length,
      cleanPasses: rows.filter(row => row.pass === true && row.clean === true).length,
      caveatedPassIds: rows.filter(row => row.pass === true && row.clean === false).map(row => row.id),
      reportedRubricScore: rows.reduce((total, row) => total + (row.score ?? 0), 0), reportedRubricMaximum: rows.reduce((total, row) => total + (row.maximum ?? 0), 0),
      unscored: rows.filter(row => row.score === null).length,
      statuses: Object.fromEntries([...new Set(rows.map(row => row.status))].map(status => [status, rows.filter(row => row.status === status).length])),
      timing: { samples: times.length, untimedAttempts: rows.length - times.length, medianSeconds: median(times), p95Seconds: times.length ? times[Math.ceil(.95 * times.length) - 1] : null, maxSeconds: times.at(-1) ?? null } }];
  }));
  return { suite: String(protocol.suite || 'Supplied benchmark').slice(0, 120), execution: 'offline summary; no inference was performed', attempts: attempts.length,
    declaredTasks: declared.size, unexecutedCaseIds: [...declared.keys()].filter(id => !attempts.some(row => row.id === id)),
    distinctTasks: new Set(attempts.map(row => row.id)).size, singleAttempt: protocol.single_attempt === true, areas,
    limitations: ['Scores and pass/clean-pass labels are preserved as supplied; caveats do not rewrite the original rubric.', 'Timings include failures with reported durations. Untimed attempts remain counted.', 'p95 is the nearest-rank quantile of this sample, not a production latency estimate.', 'This summary supplies no competitor ranking or evidence for unexecuted cases.'] };
}

export async function reportBenchmarkFiles(protocolPath, resultsPath) {
  for (const filename of [protocolPath, resultsPath]) { const entry = await stat(filename); if (!entry.isFile() || entry.size > 5 * 1024 * 1024) throw new Error('Use benchmark files up to 5 MB.'); }
  const [protocol, results] = await Promise.all([readFile(protocolPath), readFile(resultsPath)]);
  if (protocol.length > 5 * 1024 * 1024 || results.length > 5 * 1024 * 1024) throw new Error('Benchmark files changed beyond the report limit.');
  return { ...summarizeBenchmark(JSON.parse(protocol.toString('utf8').replace(/^\uFEFF/, '')), results.toString('utf8')),
    sourceHashes: { protocolSha256: createHash('sha256').update(protocol).digest('hex'), resultsSha256: createHash('sha256').update(results).digest('hex') } };
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [protocolPath, resultsPath, outputPath] = process.argv.slice(2);
  if (!protocolPath || !resultsPath || !outputPath) throw new Error('Usage: node deploy/benchmark-report.mjs protocol.json results.csv new-summary.json');
  const report = await reportBenchmarkFiles(protocolPath, resultsPath);
  await writeFile(resolve(outputPath), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Summarized ${report.attempts} supplied attempts; no inference was performed.`);
}
