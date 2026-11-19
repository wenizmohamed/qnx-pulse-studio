#!/usr/bin/env node
/**
 * QNX Pulse Studio - Cross-Platform QNX 8.0 Host Analyzer CLI
 *
 * Usage:
 *   qnx-pulse analyze <capture-dir> [--deadline 500] [--format terminal|json|markdown] [--out file]
 *   qnx-pulse analyze --preset brake-ecu-inversion [--deadline 500] [--format terminal|json|markdown]
 *   qnx-pulse list-presets
 *
 * CI Exit Codes:
 *   0 = PASS (Zero priority inversions, zero RT deadline violations, zero IPC deadlocks)
 *   2 = FAIL (Hard Real-Time violation detected)
 *   1 = CLI usage / IO error
 *
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { analyzeCapture, formatJsonReport, formatMarkdownReport } from '../src/analyzer.js';
import { getPreset, listPresetIds, PRESETS } from '../src/presets.js';

function printHelp() {
  console.log(`QNX Pulse Studio CLI v1.0.0 — QNX Neutrino 8.0 Real-Time Trace & IPC Auditor

Usage:
  qnx-pulse analyze <capture-dir> [options]
  qnx-pulse analyze --preset <name> [options]
  qnx-pulse list-presets

Options:
  --preset <id>          Analyze built-in QNX 8.0 capture preset
  --deadline <us>        Hard-RT deadline jitter budget in microseconds (default: 500)
  --starvation <us>      Thread READY starvation threshold in microseconds (default: 1000)
  --format <type>        Output format: terminal | json | markdown (default: terminal)
  --out <path>           Write report to file (in addition to summary)
  -h, --help             Show help

Exit Codes:
  0  PASS — Real-time constraints met
  2  FAIL — Priority inversion, IPC deadlock, or deadline jitter violation detected
  1  ERROR — Invalid arguments or unreadable capture directory`);
}

function readOptionalFile(dir, candidates) {
  for (const name of candidates) {
    const full = path.join(dir, name);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return fs.readFileSync(full, 'utf8');
    }
  }
  return '';
}

function loadCaptureDirectory(dirPath) {
  const absDir = path.resolve(dirPath);
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    throw new Error(`Capture directory not found: ${absDir}`);
  }

  const slog2 = readOptionalFile(absDir, ['slog2.log', 'slog2info.log', 'slog2.txt']);
  const pidin = readOptionalFile(absDir, ['pidin.txt', 'pidin.log']);
  const trace = readOptionalFile(absDir, ['trace.csv', 'traceprinter.csv', 'trace.txt', 'traceprinter.txt']);

  let pps = readOptionalFile(absDir, ['pps_telemetry.pps', 'telemetry.pps', 'pps.txt']);
  const ppsSubDir = path.join(absDir, 'pps');
  if (!pps && fs.existsSync(ppsSubDir) && fs.statSync(ppsSubDir).isDirectory()) {
    const ppsFiles = fs.readdirSync(ppsSubDir).filter((f) => !f.startsWith('.'));
    pps = ppsFiles.map((f) => fs.readFileSync(path.join(ppsSubDir, f), 'utf8')).join('\n\n');
  }

  if (!slog2 && !pidin && !trace && !pps) {
    throw new Error(
      `No QNX diagnostic files found in ${absDir} (expected slog2.log, pidin.txt, trace.csv, or pps_telemetry.pps)`
    );
  }

  return {
    meta: {
      name: path.basename(absDir),
      target: 'QNX Neutrino 8.0 Capture Directory',
      path: absDir
    },
    slog2,
    pidin,
    trace,
    pps
  };
}

function formatTerminalReport(report) {
  const bar = '='.repeat(74);
  const verdict = report.status === 'PASS' ? 'PASS (EXIT 0)' : 'RT VIOLATION FAIL (EXIT 2)';
  const out = [];
  out.push(bar);
  out.push(`  QNX PULSE STUDIO v${report.version}  |  QNX NEUTRINO 8.0 RT AUDITOR`);
  out.push(bar);
  out.push(`  Capture  : ${report.meta?.name || 'Custom'}`);
  out.push(`  Target   : ${report.meta?.target || 'x86_64-neutrino-8.0'}`);
  out.push(`  Verdict  : ${verdict}   |   RT Score: ${report.score}/100`);
  out.push(
    `  Jitter   : max=${report.jitterStats.maxUs}us  p95=${report.jitterStats.p95Us}us  p99=${report.jitterStats.p99Us}us  budget=${report.options.deadlineUs}us`
  );
  out.push(
    `  Counters : inversions=${report.summary.priorityInversions}  violations=${report.summary.deadlineViolations}  ipc_chains=${report.summary.ipcBlockChains}  starved=${report.summary.starvedThreads}`
  );
  out.push(
    `  Inputs   : threads=${report.summary.totalThreads} (${report.summary.fifoThreads} SCHED_FIFO)  trace_events=${report.summary.totalTraceEvents}  slog2=${report.summary.totalLogs}  pps_objs=${report.summary.ppsObjectCount}`
  );
  out.push('-'.repeat(74));

  if (report.findings.length === 0) {
    out.push('  [OK] Zero priority inversions, zero deadline violations, deterministic QNX IPC.');
  } else {
    out.push(`  FINDINGS (${report.findings.length}):`);
    for (const f of report.findings) {
      out.push(`   * [${f.severity}] ${f.title}`);
      out.push(`     Detail : ${f.description}`);
      out.push(`     Fix    : ${f.remediation}`);
    }
  }
  out.push(bar);
  return out.join('\n');
}

function parseArgs(argv) {
  const args = {
    command: null,
    targetDir: null,
    preset: null,
    deadlineUs: 500,
    starvationUs: 1000,
    format: 'terminal',
    out: null,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      args.help = true;
    } else if (token === '--preset' && argv[i + 1]) {
      args.preset = argv[++i];
    } else if (token === '--deadline' && argv[i + 1]) {
      args.deadlineUs = Number.parseFloat(argv[++i]);
    } else if (token === '--starvation' && argv[i + 1]) {
      args.starvationUs = Number.parseFloat(argv[++i]);
    } else if (token === '--format' && argv[i + 1]) {
      args.format = argv[++i].toLowerCase();
    } else if (token === '--out' && argv[i + 1]) {
      args.out = argv[++i];
    } else if (!args.command) {
      args.command = token;
    } else if (!args.targetDir) {
      args.targetDir = token;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.command) {
    printHelp();
    process.exit(0);
  }

  if (args.command === 'list-presets') {
    for (const id of listPresetIds()) {
      const p = PRESETS[id];
      console.log(`${id.padEnd(24)} [${p.badge}]  ${p.meta.name}`);
    }
    process.exit(0);
  }

  if (args.command !== 'analyze') {
    console.error(`Unknown command: ${args.command}`);
    printHelp();
    process.exit(1);
  }

  let bundle;
  try {
    if (args.preset) {
      bundle = getPreset(args.preset);
      if (!bundle) {
        throw new Error(`Unknown preset '${args.preset}'. Available: ${listPresetIds().join(', ')}`);
      }
    } else if (args.targetDir) {
      bundle = loadCaptureDirectory(args.targetDir);
    } else {
      throw new Error('Specify either <capture-dir> or --preset <name>.');
    }
  } catch (err) {
    console.error(`[qnx-pulse error] ${err.message}`);
    process.exit(1);
  }

  const report = analyzeCapture(bundle, {
    deadlineUs: args.deadlineUs,
    starvationUs: args.starvationUs
  });

  let rendered;
  if (args.format === 'json') {
    rendered = formatJsonReport(report);
  } else if (args.format === 'markdown' || args.format === 'md') {
    rendered = formatMarkdownReport(report);
  } else {
    rendered = formatTerminalReport(report);
  }

  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, rendered, 'utf8');
    console.log(`[qnx-pulse] Report written to ${outPath} (verdict=${report.status}, exit=${report.exitCode})`);
  } else {
    console.log(rendered);
  }

  process.exit(report.exitCode);
}

main();
