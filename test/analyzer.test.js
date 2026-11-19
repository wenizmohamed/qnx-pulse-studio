/**
 * QNX Pulse Studio - Comprehensive Test Suite
 * Tests all 4 QNX 8.0 parsers, Priority Inversion detection, IPC chain detection,
 * Deadline Jitter & Starvation analysis, CLI execution, and public/engine sync.
 *
 * Run: npm test
 * SPDX-License-Identifier: MIT
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseSlog2, parsePidin, parseTraceprinter, parsePps } from '../src/parsers.js';
import { analyzeCapture, formatMarkdownReport, formatJsonReport } from '../src/analyzer.js';
import { PRESETS } from '../src/presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

test('parseSlog2 parses QNX 8.0 slog2info entries with severities, pids, and jitter metrics', () => {
  const logs = parseSlog2(PRESETS['brake-ecu-inversion'].slog2);
  assert.equal(logs.length, 9);
  assert.equal(logs[0].buffer, 'sensor_broker');
  assert.equal(logs[0].pid, 4098);
  assert.equal(logs[0].severity, 'INFO');

  const violation = logs.find((l) => l.code === 2010 && l.metrics.iter === 75);
  assert.ok(violation, 'Expected DEADLINE_VIOLATION entry');
  assert.equal(violation.severity, 'ERROR');
  assert.equal(violation.metrics.jitterUs, 1842.4);
  assert.equal(violation.metrics.budgetUs, 500);
});

test('parsePidin parses pidin -F "%a %b %p %J %S %h" priorities, policies, states, and blocked-on targets', () => {
  const threads = parsePidin(PRESETS['brake-ecu-inversion'].pidin);
  assert.equal(threads.length, 7);

  const actuator = threads.find((t) => t.threadName === 'actuator_1khz');
  assert.ok(actuator);
  assert.equal(actuator.pid, 4102);
  assert.equal(actuator.tid, 3);
  assert.equal(actuator.priority, 60);
  assert.equal(actuator.policy, 'SCHED_FIFO');
  assert.equal(actuator.state, 'MUTEX');
  assert.deepEqual(actuator.blockedOn, { raw: '4102:1', pid: 4102, tid: 1, label: null });

  const broker = threads.find((t) => t.process === 'sensor_broker');
  assert.equal(broker.state, 'REPLY');
  assert.equal(broker.blockedOn.pid, 4095);
});

test('parseTraceprinter parses both CSV and native QNX traceprinter kernel trace lines', () => {
  const csvEvents = parseTraceprinter(PRESETS['brake-ecu-inversion'].trace);
  assert.equal(csvEvents.length, 19);
  assert.equal(csvEvents[2].event, 'MSG_SENDV');
  assert.equal(csvEvents[2].targetPid, 4098);

  const nativeSample = [
    't:0x0003a980 (100.0us) CPU:00 COMM MSG_SENDV pid:4102 tid:3 prio:60 target:4098:1 READ_SENSOR',
    't:0x000493e0 (125.0us) CPU:01 COMM MSG_REPLYV pid:4098 tid:1 prio:55 target:4102:3 EOK'
  ].join('\n');
  const nativeEvents = parseTraceprinter(nativeSample);
  assert.equal(nativeEvents.length, 2);
  assert.equal(nativeEvents[0].timeUs, 100);
  assert.equal(nativeEvents[0].targetPid, 4098);
  assert.equal(nativeEvents[1].event, 'MSG_REPLYV');
});

test('parsePps parses multi-object QNX /pps/ dumps with typed attributes (n, b, s, json)', () => {
  const objs = parsePps(PRESETS['brake-ecu-inversion'].pps);
  assert.equal(objs.length, 2);
  assert.equal(objs[0].path, '/pps/qnx/telemetry');
  assert.equal(objs[0].attributes.brake_pressure_kpa.value, 4340);
  assert.equal(objs[0].attributes.status.value, 'DEGRADED_LATENCY');

  assert.equal(objs[1].path, '/pps/qnx/brake_ecu');
  assert.equal(objs[1].attributes.inversion_detected.value, true);
  assert.deepEqual(objs[1].attributes.active_faults.value, ['PRIORITY_INVERSION', 'DEADLINE_EXCEEDED']);
});

test('analyzeCapture detects Priority Inversion, IPC block chains, Deadline Jitter & Starvation on brake-ecu-inversion', () => {
  const report = analyzeCapture(PRESETS['brake-ecu-inversion'], { deadlineUs: 500 });

  assert.equal(report.status, 'FAIL');
  assert.equal(report.exitCode, 2);
  assert.equal(report.summary.priorityInversions, 1);
  assert.equal(report.inversionBands[0].highThread.prio, 60);
  assert.equal(report.inversionBands[0].mediumThread.prio, 35);
  assert.equal(report.inversionBands[0].lowOwner.prio, 15);
  assert.ok(report.inversionBands[0].durationUs >= 1300);

  assert.ok(report.summary.ipcBlockChains >= 2, 'Expected MUTEX and REPLY IPC chains');
  assert.ok(report.summary.deadlineViolations >= 2);
  assert.equal(report.jitterStats.maxUs, 1842.4);
  assert.equal(report.summary.starvedThreads, 1);
  assert.equal(report.starvationFindings[0].threadName, 'calib_worker');

  const md = formatMarkdownReport(report);
  assert.match(md, /Priority Inversion/);
  assert.match(md, /PTHREAD_PRIO_INHERIT/);
  const json = JSON.parse(formatJsonReport(report));
  assert.equal(json.exitCode, 2);
});

test('analyzeCapture passes cleanly (exit 0) on surgical-arm-clean with PTHREAD_PRIO_INHERIT', () => {
  const report = analyzeCapture(PRESETS['surgical-arm-clean'], { deadlineUs: 500 });
  assert.equal(report.status, 'PASS');
  assert.equal(report.exitCode, 0);
  assert.equal(report.score, 100);
  assert.equal(report.summary.priorityInversions, 0);
  assert.equal(report.summary.deadlineViolations, 0);
  assert.equal(report.summary.starvedThreads, 0);
  assert.equal(report.jitterStats.maxUs, 112.6);
});

test('analyzeCapture detects circular IPC deadlock cycles in pidin snapshots', () => {
  const deadlockBundle = {
    pidin: `PID TID PROCESS PRIO STATE BLOCKED THREAD_NAME
9001 1 srv_alpha 50f SEND 9002:1 alpha_main
9002 1 srv_beta  50f SEND 9001:1 beta_main`,
    slog2: '',
    trace: '',
    pps: ''
  };
  const report = analyzeCapture(deadlockBundle);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.exitCode, 2);
  assert.ok(report.ipcChains.some((c) => c.isDeadlock));
  assert.ok(report.findings.some((f) => f.category === 'IPC_DEADLOCK'));
});

test('CLI qnx-pulse.mjs returns exit 2 on samples/brake-ecu-inversion and exit 0 on samples/surgical-arm-clean', () => {
  const cliPath = path.join(ROOT, 'cli', 'qnx-pulse.mjs');

  const ecuRun = spawnSync(
    process.execPath,
    [cliPath, 'analyze', path.join(ROOT, 'samples', 'brake-ecu-inversion'), '--deadline', '500', '--format', 'json'],
    { encoding: 'utf8' }
  );
  assert.equal(ecuRun.status, 2);
  const ecuJson = JSON.parse(ecuRun.stdout);
  assert.equal(ecuJson.status, 'FAIL');
  assert.equal(ecuJson.summary.priorityInversions, 1);

  const cleanRun = spawnSync(
    process.execPath,
    [cliPath, 'analyze', path.join(ROOT, 'samples', 'surgical-arm-clean'), '--deadline', '500', '--format', 'json'],
    { encoding: 'utf8' }
  );
  assert.equal(cleanRun.status, 0);
  const cleanJson = JSON.parse(cleanRun.stdout);
  assert.equal(cleanJson.status, 'PASS');
  assert.equal(cleanJson.summary.priorityInversions, 0);
});

test('public/engine modules remain byte-identical to canonical src/ modules', () => {
  for (const file of ['parsers.js', 'analyzer.js', 'presets.js']) {
    const srcContent = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
    const pubContent = fs.readFileSync(path.join(ROOT, 'public', 'engine', file), 'utf8');
    assert.equal(pubContent, srcContent, `public/engine/${file} drifted from src/${file}`);
  }
});
