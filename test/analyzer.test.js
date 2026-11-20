/**
 * QNX Pulse Studio - Comprehensive Deterministic Kernel Edge-Case Test Suite (34 Tests)
 * Covers:
 *   - All 4 QNX Neutrino 8.0 parsers (slog2info, pidin -F, traceprinter CSV/native, /pps)
 *   - Single-hop & Multi-Hop Transitive Priority Inheritance Chains + Blocking Trees + WCBL math
 *   - Circular IPC Deadlocks (2-node & 3-node) & Unknown-target edge cases
 *   - Multi-Core SMP CPU Migrations (CPU0..CPU3), Per-Core Utilization & Preemption Counters
 *   - Hard-RT Deadline Margin Histogram & exact boundary jitter math
 *   - SARIF 2.1.0 & JUnit XML CI export formatters + XML escaping
 *   - CLI exit codes (0/1/2), --format sarif/junit file output, error paths, & list-presets
 *   - public/engine byte-parity, samples/ sync, & .github/workflows/qnx-pulse-gate.yml verification
 *
 * Run: npm test
 * SPDX-License-Identifier: MIT
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseSlog2, parsePidin, parseTraceprinter, parsePps } from '../src/parsers.js';
import {
  analyzeCapture,
  formatJsonReport,
  formatJunitReport,
  formatMarkdownReport,
  formatSarifReport
} from '../src/analyzer.js';
import { PRESETS } from '../src/presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(ROOT, 'cli', 'qnx-pulse.mjs');

/* ============================================================================
 * 1. QNX 8.0 PARSER TESTS (Tests 1 - 8)
 * ============================================================================ */

test('1. parseSlog2 parses QNX 8.0 slog2info entries with severities, pids, and jitter metrics', () => {
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

test('2. parsePidin parses pidin -F "%a %b %p %J %S %h" priorities, policies, states, and blocked-on targets', () => {
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

test('3. parseTraceprinter parses both CSV and native QNX traceprinter kernel trace lines', () => {
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

test('4. parsePps parses multi-object QNX /pps/ dumps with typed attributes (n, b, s, json)', () => {
  const objs = parsePps(PRESETS['brake-ecu-inversion'].pps);
  assert.equal(objs.length, 2);
  assert.equal(objs[0].path, '/pps/qnx/telemetry');
  assert.equal(objs[0].attributes.brake_pressure_kpa.value, 4340);
  assert.equal(objs[0].attributes.status.value, 'DEGRADED_LATENCY');

  assert.equal(objs[1].path, '/pps/qnx/brake_ecu');
  assert.equal(objs[1].attributes.inversion_detected.value, true);
  assert.deepEqual(objs[1].attributes.active_faults.value, ['PRIORITY_INVERSION', 'DEADLINE_EXCEEDED']);
});

test('5. parseSlog2 handles ISO timestamps, named severities, comments, and ignores malformed lines', () => {
  const raw = [
    '# QNX slog2info dump',
    '---',
    '2026-11-19T11:20:01.001Z  brake_ecu.801  100  CRIT  FAULT iter=3 jitter_us=910.5 budget_us=500',
    '2026-11-19 11:20:01.002   brake_ecu      101  WARN  Minor retry',
    '2026-11-19T11:20:01.003Z  dbg_drv.802    102  DEBUG Tracing enabled',
    'not a valid slog2 line at all'
  ].join('\n');
  const logs = parseSlog2(raw);
  assert.equal(logs.length, 3);
  assert.equal(logs[0].severity, 'CRITICAL');
  assert.equal(logs[0].pid, 801);
  assert.equal(logs[0].metrics.jitterUs, 910.5);
  assert.equal(logs[1].severity, 'WARNING');
  assert.equal(logs[1].pid, null);
  assert.equal(logs[2].severity, 'DEBUG1');
});

test('6. parsePidin supports all 5 QNX scheduling policies and labeled mutex blockers', () => {
  const raw = `PID TID PROCESS PRIO STATE BLOCKED THREAD_NAME
100 1 proc_a 60f MUTEX 100:2(g_fusion_mtx) t_fifo
100 2 proc_a 40r READY - t_rr
100 3 proc_a 20o RECEIVE 1 t_other
100 4 proc_a 35s RUNNING - t_sporadic
100 5 proc_a 25a NANOSLEEP - t_adaptive
bad row ignored`;
  const threads = parsePidin(raw);
  assert.equal(threads.length, 5);
  assert.deepEqual(
    threads.map((t) => t.policy),
    ['SCHED_FIFO', 'SCHED_RR', 'SCHED_OTHER', 'SCHED_SPORADIC', 'SCHED_ADAPTIVE']
  );
  assert.deepEqual(threads[0].blockedOn, {
    raw: '100:2(g_fusion_mtx)',
    pid: 100,
    tid: 2,
    label: 'g_fusion_mtx'
  });
});

test('7. parseTraceprinter handles 11-column cycle+time CSV and sorts out-of-order events', () => {
  const raw = `cycle,time_us,cpu,class,event,pid,tid,prio,target_pid,target_tid,detail
480000,200.0,1,THREAD,THRUNNING,500,2,50,-,-,second event
240000,100.0,0,THREAD,THRUNNING,500,1,60,-,-,first event
240000,100.0,0,COMM,MSG_SENDV,500,1,60,500,2,same-time tie preserved`;
  const events = parseTraceprinter(raw);
  assert.equal(events.length, 3);
  assert.equal(events[0].timeUs, 100);
  assert.equal(events[0].cycle, 240000);
  assert.equal(events[1].event, 'MSG_SENDV');
  assert.equal(events[2].timeUs, 200);
});

test('8. parsePps handles delta markers (+ / -), fallback object path, and malformed JSON safely', () => {
  const raw = `+pressure:n:4200
-stale_flag:b:false
broken_meta:json:{not-valid-json
@/pps/custom/ecu
ok:b:1`;
  const objs = parsePps(raw, '/pps/qnx/default');
  assert.equal(objs.length, 2);
  assert.equal(objs[0].path, '/pps/qnx/default');
  assert.equal(objs[0].attributes.pressure.delta, '+');
  assert.equal(objs[0].attributes.stale_flag.delta, '-');
  assert.equal(objs[0].attributes.stale_flag.value, false);
  assert.equal(objs[0].attributes.broken_meta.value, '{not-valid-json');
  assert.equal(objs[1].path, '/pps/custom/ecu');
  assert.equal(objs[1].attributes.ok.value, true);
});

/* ============================================================================
 * 2. PRIORITY INVERSION, MULTI-HOP PI CHAINS & BLOCKING TREES (Tests 9 - 17)
 * ============================================================================ */

test('9. analyzeCapture detects Priority Inversion, IPC block chains, Deadline Jitter & Starvation on brake-ecu-inversion', () => {
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

test('10. analyzeCapture passes cleanly (exit 0) on surgical-arm-clean with PTHREAD_PRIO_INHERIT', () => {
  const report = analyzeCapture(PRESETS['surgical-arm-clean'], { deadlineUs: 500 });
  assert.equal(report.status, 'PASS');
  assert.equal(report.exitCode, 0);
  assert.equal(report.score, 100);
  assert.equal(report.summary.priorityInversions, 0);
  assert.equal(report.summary.multiHopPiChains, 0);
  assert.equal(report.summary.deadlineViolations, 0);
  assert.equal(report.summary.starvedThreads, 0);
  assert.equal(report.jitterStats.maxUs, 112.6);
});

test('11. analyzeCapture detects circular 2-node IPC deadlock cycles in pidin snapshots', () => {
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
  assert.ok(report.findings.some((f) => f.category === 'IPC_DEADLOCK' && f.ruleId === 'QNX003'));
});

test('12. analyzeCapture detects 3-node circular deadlock (A->B->C->A) with unbounded WCBL', () => {
  const cycleBundle = {
    pidin: `PID TID PROCESS PRIO STATE BLOCKED THREAD_NAME
7001 1 node_a 60f MUTEX 7002:1(mtx_b) th_a
7002 1 node_b 50f MUTEX 7003:1(mtx_c) th_b
7003 1 node_c 40f MUTEX 7001:1(mtx_a) th_c`,
    slog2: '',
    trace: '',
    pps: ''
  };
  const report = analyzeCapture(cycleBundle);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.exitCode, 2);
  assert.ok(report.ipcChains.some((c) => c.isDeadlock && c.hops === 3));
  const piDeadlock = report.piChains.find((c) => c.isDeadlock);
  assert.ok(piDeadlock, 'Expected deadlock in piChains');
  assert.equal(piDeadlock.wcbl.beforePiUs, null);
  assert.match(piDeadlock.wcbl.formula, /UNBOUNDED/);
});

test('13. Multi-hop PI analyzer detects 2-hop transitive chains, fan-in tree, and exact WCBL on adas-multihop-pi', () => {
  const report = analyzeCapture(PRESETS['adas-multihop-pi'], { deadlineUs: 500 });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.exitCode, 2);
  assert.equal(report.summary.multiHopPiChains, 2);
  assert.equal(report.summary.priorityInversions, 1);
  assert.equal(report.inversionBands[0].isTransitive, true);
  assert.equal(report.inversionBands[0].highThread.name, 'fusion_ctrl');
  assert.equal(report.inversionBands[0].mediumThread.name, 'ota_hasher');
  assert.equal(report.inversionBands[0].lowOwner.name, 'nvm_flusher');

  const topChain = report.multiHopPiChains[0];
  assert.equal(topChain.hops, 2);
  assert.deepEqual(
    topChain.nodes.map((n) => n.threadName),
    ['fusion_ctrl', 'lidar_bridge', 'nvm_flusher']
  );
  assert.equal(topChain.wcbl.beforePiUs, 2240);
  assert.equal(topChain.wcbl.afterPiUs, 145);
  assert.ok(topChain.wcbl.reductionPct > 90);

  assert.equal(report.blockingTrees.length, 1, 'Fan-in waiters should merge into 1 rooted blocking tree');
  assert.equal(report.blockingTrees[0].nodes.length, 4);
  assert.equal(report.blockingTrees[0].edges.length, 3);
  assert.ok(report.findings.some((f) => f.ruleId === 'QNX002' && f.category === 'TRANSITIVE_PI_CHAIN'));
});

test('14. Multi-hop PI analyzer resolves 4-node (3-hop) deep transitive chain A->B->C->D with exact CS sum', () => {
  const deepBundle = {
    pidin: `PID TID PROCESS PRIO STATE BLOCKED THREAD_NAME
8100 4 deep_app 70f MUTEX 8100:3(mtx_1) ctrl_top
8100 3 deep_app 55f MUTEX 8100:2(mtx_2) mid_a
8100 2 deep_app 35f MUTEX 8100:1(mtx_3) mid_b
8100 1 deep_app 15f READY - leaf_low
8100 5 deep_app 45f RUNNING - noisy_med`,
    slog2: '',
    trace: `time_us,cpu,class,event,pid,tid,prio,target_pid,target_tid,detail
0,0,THREAD,THRUNNING,8100,1,15,-,-,leaf_low acquires mtx_3 cs_us=50
10,0,THREAD,THRUNNING,8100,2,35,-,-,mid_b acquires mtx_2 cs_us=40
20,0,SYNC,THMUTEX,8100,2,35,8100,1,Blocked on mtx_3
30,0,THREAD,THRUNNING,8100,3,55,-,-,mid_a acquires mtx_1 cs_us=30
40,0,SYNC,THMUTEX,8100,3,55,8100,2,Blocked on mtx_2
50,0,THREAD,THRUNNING,8100,4,70,-,-,ctrl_top wakes
60,0,SYNC,THMUTEX,8100,4,70,8100,3,Blocked on mtx_1
70,0,THREAD,THREADY,8100,1,15,-,-,leaf_low preempted
75,0,THREAD,THRUNNING,8100,5,45,-,-,noisy_med preempts CPU0
975,0,THREAD,THNANOSLEEP,8100,5,45,-,-,noisy_med sleeps
985,0,THREAD,THRUNNING,8100,1,15,-,-,leaf_low resumes
1035,0,SYNC,MUTEX_UNLOCK,8100,1,15,-,-,leaf_low unlocks mtx_3`,
    pps: ''
  };
  const report = analyzeCapture(deepBundle);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.multiHopPiChains.length, 1);
  const chain = report.multiHopPiChains[0];
  assert.equal(chain.hops, 3);
  assert.equal(chain.wcbl.afterPiUs, 120); // 30 + 40 + 50
  assert.ok(chain.wcbl.beforePiUs >= 1020);
  assert.ok(chain.wcbl.reductionPct >= 85);
});

test('15. Blocking tree merges 3 high-priority fan-in waiters sharing one low-priority owner', () => {
  const fanInBundle = {
    pidin: `PID TID PROCESS PRIO STATE BLOCKED THREAD_NAME
3001 2 app 64f MUTEX 3001:1(g_bus_mtx) waiter_a
3001 3 app 60f MUTEX 3001:1(g_bus_mtx) waiter_b
3001 4 app 56f MUTEX 3001:1(g_bus_mtx) waiter_c
3001 1 app 15f READY - owner_low
3001 5 app 40f RUNNING - med_hog`,
    slog2: '',
    trace: '',
    pps: ''
  };
  const report = analyzeCapture(fanInBundle);
  assert.equal(report.blockingTrees.length, 1);
  assert.equal(report.blockingTrees[0].nodes.length, 4);
  assert.equal(report.blockingTrees[0].edges.length, 3);
  assert.equal(report.blockingTrees[0].maxWaiterPrio, 64);
  assert.equal(report.blockingTrees[0].rootOwner.threadName, 'owner_low');
});

test('16. Unknown blocked-on PID in pidin is handled gracefully without throwing', () => {
  const orphanBundle = {
    pidin: `PID TID PROCESS PRIO STATE BLOCKED THREAD_NAME
4400 1 worker 60f REPLY 9999:1 orphan_waiter`,
    slog2: '',
    trace: '',
    pps: ''
  };
  const report = analyzeCapture(orphanBundle);
  assert.equal(report.ipcChains.length, 1);
  assert.equal(report.ipcChains[0].tail.state, 'UNKNOWN');
  assert.equal(report.ipcChains[0].isDeadlock, false);
});

test('17. PI_BOOST protects low-priority owner from inversion when medium-priority thread arrives', () => {
  const boostedBundle = {
    pidin: `PID TID PROCESS PRIO STATE BLOCKED THREAD_NAME
5500 3 app 60f RUNNING - hi_ctrl
5500 2 app 35f NANOSLEEP - med_bg
5500 1 app 15f NANOSLEEP - low_owner`,
    slog2: '',
    trace: `time_us,cpu,class,event,pid,tid,prio,target_pid,target_tid,detail
0,0,THREAD,THRUNNING,5500,1,15,-,-,low_owner acquires g_mtx cs_us=45
20,0,THREAD,THRUNNING,5500,3,60,-,-,hi_ctrl wakes
25,0,SYNC,THMUTEX,5500,3,60,5500,1,Contention on g_mtx
26,0,THREAD,PI_BOOST,5500,1,60,-,-,Kernel boosts low_owner 15f->60f
40,0,THREAD,THREADY,5500,2,35,-,-,med_bg runnable but blocked by PI_BOOST
70,0,SYNC,MUTEX_UNLOCK,5500,1,60,-,-,low_owner releases g_mtx
75,0,THREAD,THRUNNING,5500,3,60,-,-,hi_ctrl finishes jitter_us=75.0`,
    pps: ''
  };
  const report = analyzeCapture(boostedBundle, { deadlineUs: 500 });
  assert.equal(report.status, 'PASS');
  assert.equal(report.summary.priorityInversions, 0);
  assert.equal(report.piChains[0].piProtected, true);
});

/* ============================================================================
 * 3. MULTI-CORE SMP MIGRATIONS, PREEMPTIONS & DEADLINE HISTOGRAM (Tests 18 - 25)
 * ============================================================================ */

test('18. SMP analyzer detects 4-core migrations and flags unpinned hard-RT threads with QNX007', () => {
  const report = analyzeCapture(PRESETS['adas-multihop-pi'], { deadlineUs: 500 });
  assert.equal(report.smpAnalytics.coreCount, 4);
  assert.deepEqual(report.smpAnalytics.coresUsed, [0, 1, 2, 3]);
  assert.equal(report.smpAnalytics.totalMigrations, 4);

  const fusionLane = report.timelineLanes.find((l) => l.threadName === 'fusion_ctrl');
  assert.ok(fusionLane);
  assert.equal(fusionLane.migrationCount, 1);
  assert.equal(fusionLane.affinityStatus, 'MIGRATED');
  assert.deepEqual(fusionLane.cpusUsed, [0, 2]);

  const smpFindings = report.findings.filter((f) => f.ruleId === 'QNX007');
  assert.ok(smpFindings.length >= 2, 'Expected QNX007 findings for unpinned fusion_ctrl and lane_planner');
  assert.match(smpFindings[0].remediation, /_NTO_TCTL_RUNMASK/);
});

test('19. SMP per-core utilization and preemption stats stay bounded and clean on pinned surgical-arm-clean', () => {
  const report = analyzeCapture(PRESETS['surgical-arm-clean'], { deadlineUs: 500 });
  assert.equal(report.smpAnalytics.coreCount, 2);
  assert.equal(report.smpAnalytics.totalMigrations, 0);
  assert.ok(report.smpAnalytics.perCoreStats.every((c) => c.utilizationPct >= 0 && c.utilizationPct <= 100));
  assert.ok(report.timelineLanes.every((l) => l.affinityStatus === 'PINNED'));
});

test('20. SMP synthetic 4-core ping-pong migration counts exact 4 migrations across CPU0..CPU3', () => {
  const pingPong = {
    pidin: `PID TID PROCESS PRIO STATE BLOCKED THREAD_NAME
2200 1 servo 62f RUNNING - servo_1khz`,
    slog2: '',
    trace: `time_us,cpu,class,event,pid,tid,prio,target_pid,target_tid,detail
0,0,THREAD,THRUNNING,2200,1,62,-,-,tick 1
50,1,THREAD,THRUNNING,2200,1,62,-,-,migrated 0->1
100,2,THREAD,THRUNNING,2200,1,62,-,-,migrated 1->2
150,3,THREAD,THRUNNING,2200,1,62,-,-,migrated 2->3
200,0,THREAD,THRUNNING,2200,1,62,-,-,migrated 3->0
250,0,THREAD,THNANOSLEEP,2200,1,62,-,-,done`,
    pps: ''
  };
  const report = analyzeCapture(pingPong);
  assert.equal(report.smpAnalytics.totalMigrations, 4);
  assert.deepEqual(report.timelineLanes[0].cpusUsed, [0, 1, 2, 3]);
  assert.equal(report.timelineLanes[0].affinityStatus, 'MIGRATED');
  assert.ok(report.findings.some((f) => f.category === 'SMP_CORE_MIGRATION'));
});

test('21. Deadline margin histogram re-buckets samples accurately when budget tightens', () => {
  const loose = analyzeCapture(PRESETS['adas-multihop-pi'], { deadlineUs: 500 });
  assert.equal(loose.deadlineHistogram.buckets.length, 5);
  assert.equal(
    loose.deadlineHistogram.buckets.reduce((s, b) => s + b.count, 0),
    loose.deadlineHistogram.totalSamples
  );
  assert.ok(loose.deadlineHistogram.overBudgetCount >= 2);
  assert.ok(loose.deadlineHistogram.worstMarginUs < 0);

  const cleanLoose = analyzeCapture(PRESETS['surgical-arm-clean'], { deadlineUs: 500 });
  assert.equal(cleanLoose.deadlineHistogram.overBudgetCount, 0);
  assert.ok(cleanLoose.deadlineHistogram.worstMarginUs > 350);

  const cleanTight = analyzeCapture(PRESETS['surgical-arm-clean'], { deadlineUs: 100 });
  assert.equal(cleanTight.status, 'FAIL');
  assert.ok(cleanTight.deadlineHistogram.overBudgetCount >= 1);
  assert.ok(cleanTight.deadlineHistogram.worstMarginUs < 0);
});

test('22. Exact deadline boundary: jitter == budget passes, jitter == budget + 0.1 fails', () => {
  const atBoundary = analyzeCapture(
    { slog2: 'Nov 19 11:20:00.100  ctrl.100  2005  5  RT_TICK iter=1 jitter_us=500.0', pidin: '', trace: '', pps: '' },
    { deadlineUs: 500 }
  );
  assert.equal(atBoundary.status, 'PASS');
  assert.equal(atBoundary.summary.deadlineViolations, 0);
  assert.equal(atBoundary.deadlineHistogram.worstMarginUs, 0);

  const overBoundary = analyzeCapture(
    { slog2: 'Nov 19 11:20:00.100  ctrl.100  2005  2  DEADLINE iter=1 jitter_us=500.1', pidin: '', trace: '', pps: '' },
    { deadlineUs: 500 }
  );
  assert.equal(overBoundary.status, 'FAIL');
  assert.equal(overBoundary.exitCode, 2);
  assert.equal(overBoundary.summary.deadlineViolations, 1);
});

test('23. Empty capture bundle produces clean PASS report with zero NaN fields', () => {
  const report = analyzeCapture({ slog2: '', pidin: '', trace: '', pps: '' });
  assert.equal(report.status, 'PASS');
  assert.equal(report.exitCode, 0);
  assert.equal(report.score, 100);
  assert.equal(report.jitterStats.maxUs, 0);
  assert.equal(report.deadlineHistogram.totalSamples, 0);
  assert.equal(Number.isNaN(report.deadlineHistogram.headroomPct), false);
});

test('24. Custom starvationUs threshold dynamically triggers or suppresses starvation findings', () => {
  const trace = `time_us,cpu,class,event,pid,tid,prio,target_pid,target_tid,detail
0,0,THREAD,THREADY,300,1,20,-,-,waiting
450,0,THREAD,THRUNNING,300,1,20,-,-,finally ran`;
  const strict = analyzeCapture({ trace, pidin: '', slog2: '', pps: '' }, { starvationUs: 400 });
  assert.equal(strict.summary.starvedThreads, 1);
  assert.equal(strict.starvationFindings[0].waitedUs, 450);

  const relaxed = analyzeCapture({ trace, pidin: '', slog2: '', pps: '' }, { starvationUs: 500 });
  assert.equal(relaxed.summary.starvedThreads, 0);
});

test('25. qemu-starter preset detects multi-hop REPLY->SEND IPC stall and 618.5us deadline violation', () => {
  const report = analyzeCapture(PRESETS['qemu-starter'], { deadlineUs: 500 });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.exitCode, 2);
  assert.equal(report.jitterStats.maxUs, 618.5);
  assert.ok(report.ipcChains.some((c) => c.hops === 2 && c.head.threadName === 'actuator_1khz'));
});

/* ============================================================================
 * 4. SARIF 2.1.0 & JUNIT XML FORMATTERS + CLI INTEGRATION (Tests 26 - 34)
 * ============================================================================ */

test('26. formatSarifReport generates valid SARIF 2.1.0 with QNX001..QNX007 rules and findings on adas-multihop-pi', () => {
  const report = analyzeCapture(PRESETS['adas-multihop-pi'], { deadlineUs: 500 });
  const sarif = JSON.parse(formatSarifReport(report));
  assert.equal(sarif.version, '2.1.0');
  assert.match(sarif.$schema, /sarif-2\.1\.0/);
  assert.equal(sarif.runs.length, 1);
  const driver = sarif.runs[0].tool.driver;
  assert.equal(driver.name, 'QNX Pulse Studio');
  assert.equal(driver.rules.length, 7);
  assert.ok(sarif.runs[0].results.some((r) => r.ruleId === 'QNX001' && r.level === 'error'));
  assert.ok(sarif.runs[0].results.some((r) => r.ruleId === 'QNX002' && r.properties.wcblAfterUs === 145));
  assert.ok(sarif.runs[0].results.some((r) => r.ruleId === 'QNX007' && r.level === 'warning'));
});

test('27. formatSarifReport emits zero results and exitCode 0 on surgical-arm-clean', () => {
  const report = analyzeCapture(PRESETS['surgical-arm-clean'], { deadlineUs: 500 });
  const sarif = JSON.parse(formatSarifReport(report));
  assert.equal(sarif.runs[0].results.length, 0);
  assert.equal(sarif.runs[0].invocations[0].exitCode, 0);
  assert.equal(sarif.runs[0].invocations[0].properties.verdict, 'PASS');
});

test('28. formatJunitReport produces valid JUnit XML with accurate failure counts on FAIL and PASS captures', () => {
  const failXml = formatJunitReport(analyzeCapture(PRESETS['adas-multihop-pi'], { deadlineUs: 500 }));
  assert.ok(failXml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.match(failXml, /<testsuites name="QNX Pulse Studio" tests="6" failures="5"/);
  assert.match(failXml, /type="PRIORITY_INVERSION"/);
  assert.match(failXml, /type="TRANSITIVE_PI_CHAIN"/);
  assert.match(failXml, /type="SMP_CORE_MIGRATION"/);

  const passXml = formatJunitReport(analyzeCapture(PRESETS['surgical-arm-clean'], { deadlineUs: 500 }));
  assert.match(passXml, /<testsuites name="QNX Pulse Studio" tests="6" failures="0"/);
  assert.doesNotMatch(passXml, /<failure /);
});

test('29. formatJunitReport properly XML-escapes special characters in capture names and messages', () => {
  const report = analyzeCapture({
    meta: { name: 'ECU <Brake & "Steer"> \'Test\'', target: 'qnx8' },
    slog2: 'Nov 19 11:20:00.100  ecu.1  2010  2  FAIL <a&b> jitter_us=999.0',
    pidin: '',
    trace: '',
    pps: ''
  });
  const xml = formatJunitReport(report);
  assert.match(xml, /&amp;/);
  assert.doesNotMatch(xml, /ECU <Brake/);
});

test('30. CLI returns exit 2 on brake-ecu-inversion, adas-multihop-pi, qemu-starter and exit 0 on surgical-arm-clean', () => {
  const cases = [
    ['brake-ecu-inversion', 2, 'FAIL'],
    ['adas-multihop-pi', 2, 'FAIL'],
    ['qemu-starter', 2, 'FAIL'],
    ['surgical-arm-clean', 0, 'PASS']
  ];
  for (const [sample, expectedCode, expectedStatus] of cases) {
    const run = spawnSync(
      process.execPath,
      [CLI_PATH, 'analyze', path.join(ROOT, 'samples', sample), '--deadline', '500', '--format', 'json'],
      { encoding: 'utf8' }
    );
    assert.equal(run.status, expectedCode, `Unexpected exit code for ${sample}`);
    const json = JSON.parse(run.stdout);
    assert.equal(json.status, expectedStatus);
  }
});

test('31. CLI --format sarif and --format junit write valid CI files via --out', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qnx-pulse-ci-'));
  const sarifOut = path.join(tmpDir, 'out.sarif');
  const junitOut = path.join(tmpDir, 'out.junit.xml');

  const r1 = spawnSync(
    process.execPath,
    [CLI_PATH, 'analyze', path.join(ROOT, 'samples', 'adas-multihop-pi'), '--format', 'sarif', '--out', sarifOut],
    { encoding: 'utf8' }
  );
  assert.equal(r1.status, 2);
  const sarifObj = JSON.parse(fs.readFileSync(sarifOut, 'utf8'));
  assert.equal(sarifObj.version, '2.1.0');
  assert.ok(sarifObj.runs[0].results.length > 0);

  const r2 = spawnSync(
    process.execPath,
    [CLI_PATH, 'analyze', path.join(ROOT, 'samples', 'surgical-arm-clean'), '--format', 'junit', '--out', junitOut],
    { encoding: 'utf8' }
  );
  assert.equal(r2.status, 0);
  const junitXml = fs.readFileSync(junitOut, 'utf8');
  assert.match(junitXml, /failures="0"/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('32. CLI returns exit 1 on unknown command, invalid format, unknown preset, or missing directory', () => {
  const badCmd = spawnSync(process.execPath, [CLI_PATH, 'bogus-cmd'], { encoding: 'utf8' });
  assert.equal(badCmd.status, 1);

  const badFmt = spawnSync(
    process.execPath,
    [CLI_PATH, 'analyze', '--preset', 'surgical-arm-clean', '--format', 'yaml'],
    { encoding: 'utf8' }
  );
  assert.equal(badFmt.status, 1);

  const badPreset = spawnSync(process.execPath, [CLI_PATH, 'analyze', '--preset', 'does-not-exist'], {
    encoding: 'utf8'
  });
  assert.equal(badPreset.status, 1);

  const badDir = spawnSync(process.execPath, [CLI_PATH, 'analyze', path.join(ROOT, 'samples', 'nonexistent')], {
    encoding: 'utf8'
  });
  assert.equal(badDir.status, 1);
});

test('33. CLI list-presets lists all 4 built-in QNX 8.0 presets including adas-multihop-pi', () => {
  const res = spawnSync(process.execPath, [CLI_PATH, 'list-presets'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /brake-ecu-inversion/);
  assert.match(res.stdout, /adas-multihop-pi/);
  assert.match(res.stdout, /surgical-arm-clean/);
  assert.match(res.stdout, /qemu-starter/);
});

test('34. Engine parity, samples/ sync, and GitHub Actions SARIF/JUnit CI workflow integrity', () => {
  for (const file of ['parsers.js', 'analyzer.js', 'presets.js']) {
    const srcContent = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
    const pubContent = fs.readFileSync(path.join(ROOT, 'public', 'engine', file), 'utf8');
    assert.equal(pubContent, srcContent, `public/engine/${file} drifted from src/${file}`);
  }

  for (const presetId of Object.keys(PRESETS)) {
    const dir = path.join(ROOT, 'samples', presetId);
    for (const f of ['pidin.txt', 'slog2.log', 'trace.csv', 'pps_telemetry.pps']) {
      assert.ok(fs.existsSync(path.join(dir, f)), `Missing synced sample file samples/${presetId}/${f}`);
    }
  }

  const wfPath = path.join(ROOT, '.github', 'workflows', 'qnx-pulse-gate.yml');
  assert.ok(fs.existsSync(wfPath), 'Missing .github/workflows/qnx-pulse-gate.yml');
  const wf = fs.readFileSync(wfPath, 'utf8');
  assert.match(wf, /--format sarif/);
  assert.match(wf, /--format junit/);
  assert.match(wf, /upload-sarif/);
});
