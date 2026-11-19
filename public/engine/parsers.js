/**
 * QNX Pulse Studio - Zero-Dependency QNX Neutrino 8.0 Diagnostic Parsers
 * Supports:
 *   1. slog2info logs (structured QNX 8.0 system logger)
 *   2. pidin -F "%a %b %p %J %S %h" thread/priority/IPC state snapshots
 *   3. traceprinter decoded kernel traces (.kev -> CSV or native traceprinter lines)
 *   4. QNX PPS (/pps/) Persistent Publish/Subscribe object dumps
 *
 * SPDX-License-Identifier: MIT
 */

const SLOG2_SEVERITIES = new Map([
  ['0', 'SHUTDOWN'],
  ['1', 'CRITICAL'],
  ['2', 'ERROR'],
  ['3', 'WARNING'],
  ['4', 'NOTICE'],
  ['5', 'INFO'],
  ['6', 'DEBUG1'],
  ['7', 'DEBUG2'],
  ['SHUTDOWN', 'SHUTDOWN'],
  ['CRITICAL', 'CRITICAL'],
  ['CRIT', 'CRITICAL'],
  ['ERROR', 'ERROR'],
  ['ERR', 'ERROR'],
  ['WARNING', 'WARNING'],
  ['WARN', 'WARNING'],
  ['NOTICE', 'NOTICE'],
  ['INFO', 'INFO'],
  ['DEBUG1', 'DEBUG1'],
  ['DEBUG2', 'DEBUG2'],
  ['DEBUG', 'DEBUG1']
]);

/**
 * Parse QNX 8.0 `slog2info` text output.
 * Standard format:
 *   Nov 19 11:20:01.042        motor_ctrl.4102   2010  2  DEADLINE_VIOLATION iter=42 jitter_us=1842.4 ...
 * Also accepts ISO timestamps or severity names (INFO, ERROR, WARNING, CRITICAL, DEBUG1).
 */
export function parseSlog2(text = '') {
  const entries = [];
  if (!text || typeof text !== 'string') return entries;

  const lines = text.split(/\r?\n/);
  const reStandard =
    /^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\.\d{3,6}|\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(\S+)\s+(\d+)\s+([0-7A-Za-z]+)\s+(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('---')) continue;

    const m = raw.match(reStandard);
    if (!m) continue;

    const [, timestamp, bufferPid, codeStr, sevRaw, message] = m;
    const dotIdx = bufferPid.lastIndexOf('.');
    let buffer = bufferPid;
    let pid = null;
    if (dotIdx > 0 && /^\d+$/.test(bufferPid.slice(dotIdx + 1))) {
      buffer = bufferPid.slice(0, dotIdx);
      pid = Number.parseInt(bufferPid.slice(dotIdx + 1), 10);
    }

    const severity = SLOG2_SEVERITIES.get(sevRaw.toUpperCase()) || 'INFO';
    const jitterMatch = message.match(/jitter_us=([0-9]+(?:\.[0-9]+)?)/i);
    const budgetMatch = message.match(/budget_us=([0-9]+(?:\.[0-9]+)?)/i);
    const iterMatch = message.match(/iter=(\d+)/i);

    entries.push({
      line: i + 1,
      timestamp,
      buffer,
      pid,
      code: Number.parseInt(codeStr, 10),
      severity,
      message: message.trim(),
      metrics: {
        jitterUs: jitterMatch ? Number.parseFloat(jitterMatch[1]) : null,
        budgetUs: budgetMatch ? Number.parseFloat(budgetMatch[1]) : null,
        iter: iterMatch ? Number.parseInt(iterMatch[1], 10) : null
      }
    });
  }

  return entries;
}

const POLICY_MAP = {
  f: 'SCHED_FIFO',
  r: 'SCHED_RR',
  o: 'SCHED_OTHER',
  s: 'SCHED_SPORADIC',
  a: 'SCHED_ADAPTIVE'
};

/**
 * Parse QNX 8.0 `pidin -F "%a %b %p %J %S %h"` output.
 * Columns: PID TID PROCESS PRIO_POLICY STATE BLOCKED_ON [THREAD_NAME]
 * Example:
 *   4102   3   motor_ctrl   60f   MUTEX     4102:1   actuator_1khz
 *   4102   2   motor_ctrl   35f   RUNNING   -        diag_streamer
 *   4098   1   sensor_broker 55f  RECEIVE   1        ipc_broker
 */
export function parsePidin(text = '') {
  const threads = [];
  if (!text || typeof text !== 'string') return threads;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#') || /^pid\s+tid/i.test(raw) || raw.startsWith('---')) continue;

    const cols = raw.split(/\s+/);
    if (cols.length < 5) continue;

    const pid = Number.parseInt(cols[0], 10);
    const tid = Number.parseInt(cols[1], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(tid)) continue;

    const process = cols[2];
    const prioToken = cols[3];
    const prioMatch = prioToken.match(/^(\d+)([frosa])?$/i);
    const priority = prioMatch ? Number.parseInt(prioMatch[1], 10) : 10;
    const policyCode = prioMatch && prioMatch[2] ? prioMatch[2].toLowerCase() : 'r';
    const policy = POLICY_MAP[policyCode] || 'SCHED_RR';

    const state = cols[4].toUpperCase();
    const blockedRaw = cols[5] && cols[5] !== '-' && cols[5] !== '0' ? cols[5] : null;
    const threadName = cols.slice(6).join(' ') || `${process}:${tid}`;

    let blockedOn = null;
    if (blockedRaw) {
      const mPidTid = blockedRaw.match(/^(\d+)(?::(\d+))?(?:\(([^)]+)\))?$/);
      if (mPidTid) {
        blockedOn = {
          raw: blockedRaw,
          pid: Number.parseInt(mPidTid[1], 10),
          tid: mPidTid[2] ? Number.parseInt(mPidTid[2], 10) : null,
          label: mPidTid[3] || null
        };
      } else {
        blockedOn = { raw: blockedRaw, pid: null, tid: null, label: blockedRaw };
      }
    }

    threads.push({
      id: `${pid}:${tid}`,
      pid,
      tid,
      process,
      threadName,
      priority,
      policyCode,
      policy,
      state,
      blockedOn
    });
  }

  return threads;
}

/**
 * Parse QNX `traceprinter` decoded kernel trace output.
 * Supports:
 *   1. CSV format: time_us,cpu,class,event,pid,tid,prio,target_pid,target_tid,detail
 *   2. Native traceprinter format: t:0x00001234 CPU:00 THREAD THRUNNING pid:4102 tid:3 prio:60 ...
 */
export function parseTraceprinter(text = '') {
  const events = [];
  if (!text || typeof text !== 'string') return events;

  const lines = text.split(/\r?\n/);
  let isCsv = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#')) continue;

    if (/^time_us\s*,/i.test(raw) || /^cycle\s*,\s*time_us/i.test(raw)) {
      isCsv = true;
      continue;
    }

    if (isCsv || (raw.includes(',') && /^\d/.test(raw))) {
      const parts = raw.split(',').map((s) => s.trim());
      // Support both 10-column (time_us,...) and 11-column (cycle,time_us,...)
      let offset = 0;
      let cycle = null;
      if (parts.length >= 11 && /^\d+$/.test(parts[0]) && /^\d+(?:\.\d+)?$/.test(parts[1])) {
        cycle = Number.parseInt(parts[0], 10);
        offset = 1;
      }
      if (parts.length < 8 + offset) continue;

      const timeUs = Number.parseFloat(parts[offset]);
      const cpu = Number.parseInt(parts[offset + 1], 10) || 0;
      const eventClass = (parts[offset + 2] || 'THREAD').toUpperCase();
      const event = (parts[offset + 3] || '').toUpperCase();
      const pid = Number.parseInt(parts[offset + 4], 10);
      const tid = Number.parseInt(parts[offset + 5], 10);
      const prio = Number.parseInt(parts[offset + 6], 10);
      const targetPid = parts[offset + 7] && parts[offset + 7] !== '-' ? Number.parseInt(parts[offset + 7], 10) : null;
      const targetTid = parts[offset + 8] && parts[offset + 8] !== '-' ? Number.parseInt(parts[offset + 8], 10) : null;
      const detail = parts.slice(offset + 9).join(',').trim();

      if (!Number.isFinite(timeUs) || !Number.isFinite(pid)) continue;

      events.push({
        index: events.length,
        cycle: cycle ?? Math.round(timeUs * 2400),
        timeUs,
        cpu,
        eventClass,
        event,
        pid,
        tid: Number.isFinite(tid) ? tid : 1,
        prio: Number.isFinite(prio) ? prio : 10,
        targetPid: Number.isFinite(targetPid) ? targetPid : null,
        targetTid: Number.isFinite(targetTid) ? targetTid : null,
        detail
      });
      continue;
    }

    // Native traceprinter text line fallback:
    // t:0x0003a980 (100.0us) CPU:00 COMM MSG_SENDV pid:4102 tid:3 prio:60 target:4098:1 detail:READ_SENSOR
    const mNative = raw.match(
      /^t:(0x[0-9a-f]+|\d+)(?:\s+\(([0-9.]+)us\))?\s+CPU:(\d+)\s+(\S+)\s+(\S+)\s+pid:(\d+)\s+tid:(\d+)\s+prio:(\d+)(?:\s+target:(\d+)(?::(\d+))?)?(?:\s+(.*))?$/i
    );
    if (mNative) {
      const cycleVal = mNative[1].startsWith('0x') ? Number.parseInt(mNative[1], 16) : Number.parseInt(mNative[1], 10);
      const timeUs = mNative[2] ? Number.parseFloat(mNative[2]) : Number((cycleVal / 2400).toFixed(2));
      events.push({
        index: events.length,
        cycle: cycleVal,
        timeUs,
        cpu: Number.parseInt(mNative[3], 10),
        eventClass: mNative[4].toUpperCase(),
        event: mNative[5].toUpperCase(),
        pid: Number.parseInt(mNative[6], 10),
        tid: Number.parseInt(mNative[7], 10),
        prio: Number.parseInt(mNative[8], 10),
        targetPid: mNative[9] ? Number.parseInt(mNative[9], 10) : null,
        targetTid: mNative[10] ? Number.parseInt(mNative[10], 10) : null,
        detail: (mNative[11] || '').trim()
      });
    }
  }

  events.sort((a, b) => a.timeUs - b.timeUs || a.index - b.index);
  return events;
}

/**
 * Parse QNX Persistent Publish/Subscribe (PPS) object dumps (`/pps/...`).
 * Supports single or multiple `@object_name` sections and `attr:encoding:value` lines.
 */
export function parsePps(text = '', defaultPath = '/pps/qnx/telemetry') {
  const objects = [];
  if (!text || typeof text !== 'string') return objects;

  let current = null;
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('@')) {
      const name = line.slice(1).trim();
      const path = name.startsWith('/') ? name : `/pps/qnx/${name}`;
      current = {
        name,
        path,
        attributes: {}
      };
      objects.push(current);
      continue;
    }

    if (!current) {
      const fallbackName = defaultPath.split('/').pop() || 'telemetry';
      current = {
        name: fallbackName,
        path: defaultPath,
        attributes: {}
      };
      objects.push(current);
    }

    // Format: [+-]key:encoding:value  OR  key::value
    const firstColon = line.indexOf(':');
    if (firstColon <= 0) continue;

    let key = line.slice(0, firstColon).trim();
    let delta = null;
    if (key.startsWith('+') || key.startsWith('-')) {
      delta = key[0];
      key = key.slice(1);
    }

    const rest = line.slice(firstColon + 1);
    const secondColon = rest.indexOf(':');
    let encoding = 's';
    let rawValue = rest;

    if (secondColon >= 0) {
      encoding = rest.slice(0, secondColon).trim() || 's';
      rawValue = rest.slice(secondColon + 1).trim();
    }

    let value = rawValue;
    if (encoding === 'n') {
      const parsed = Number.parseFloat(rawValue);
      value = Number.isFinite(parsed) ? parsed : rawValue;
    } else if (encoding === 'b') {
      value = rawValue === 'true' || rawValue === '1';
    } else if (encoding === 'json') {
      try {
        value = JSON.parse(rawValue);
      } catch {
        value = rawValue;
      }
    }

    current.attributes[key] = {
      key,
      encoding,
      rawValue,
      value,
      delta
    };
  }

  return objects;
}

/**
 * Parse a complete QNX 8.0 diagnostic bundle.
 */
export function parseCaptureBundle(bundle = {}) {
  return {
    meta: bundle.meta || { name: 'Custom QNX 8.0 Capture', target: 'x86_64-neutrino-8.0' },
    logs: parseSlog2(bundle.slog2 || ''),
    threads: parsePidin(bundle.pidin || ''),
    events: parseTraceprinter(bundle.trace || ''),
    ppsObjects: parsePps(bundle.pps || '', bundle.ppsPath || '/pps/qnx/telemetry')
  };
}
