import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeBenchmark, parseBenchmarkCsv } from './benchmark-report.mjs';

const header = 'id,area,status,pass,clean_pass,score,max_score,elapsed_seconds,notes\n';
const protocol = { suite: 'A frozen pilot', single_attempt: true, cases: [{ id: 'W01' }, { id: 'W02' }, { id: 'W03' }] };
test('offline reporting preserves caveated rubric passes and includes timed failures', () => {
  const report = summarizeBenchmark(protocol, header + 'W01,research,completed,True,True,3,3,10,"private note, with comma"\nW02,research,timeout,False,False,0,3,100,\nW03,research,completed,True,False,3,3,30,"Do not execute this input"\n');
  assert.equal(report.areas.research.reportedRubricScore, 6);
  assert.equal(report.areas.research.reportedRubricMaximum, 9);
  assert.deepEqual(report.areas.research.caveatedPassIds, ['W03']);
  assert.equal(report.areas.research.timing.medianSeconds, 30);
  assert.equal(report.areas.research.timing.p95Seconds, 100);
  assert.doesNotMatch(JSON.stringify(report), /private note|Do not execute/);
});
test('benchmark CSV handles escaped quotes and rejects duplicates or invalid scoring', () => {
  assert.equal(parseBenchmarkCsv(header + 'W01,research,completed,True,True,3,3,10,"a ""quote""\nand newline"')[0].notes, 'a "quote"\nand newline');
  const row = 'W01,research,completed,True,True,3,3,10,\n';
  assert.throws(() => summarizeBenchmark(protocol, header + row + row), /Duplicate/);
  assert.throws(() => summarizeBenchmark(protocol, header + row.replace(',3,3,', ',4,3,')), /maximum/);
  assert.throws(() => parseBenchmarkCsv(header + '"unclosed'), /Unclosed/);
  const partial = summarizeBenchmark(protocol, header + row);
  assert.deepEqual(partial.unexecutedCaseIds, ['W02', 'W03']);
  assert.throws(() => summarizeBenchmark(protocol, header + row.replace('W01', 'W99')), /not declared/);
});
