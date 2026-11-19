/**
 * QNX Pulse Studio - Real-Time Neutrino 8.0 Trace & IPC Diagnostics Engine
 *
 * Detects:
 *   1. Priority Inversions (high-prio SCHED_FIFO thread blocked on lower-prio owner while
 *      medium-prio thread preempts the CPU, without PTHREAD_PRIO_INHERIT boost)
 *   2. Blocked SEND / REPLY / MUTEX IPC Chains & Potential Deadlocks
 *   3. Hard-RT Deadline Jitter Violations (> deadlineUs, default 500us)
 *   4. Thread Starvation (READY threads starved beyond starvationUs, default 1000us)
 *
 * Produces structured AuditReport + Markdown / JSON reports + CI exitCode (0 pass, 2 violation).
 * SPDX-License-Identifier: MIT
 */

import { parseCaptureBundle } from './parsers.js';

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(1));
}

function threadKey(pid, tid) {
  return `${pid}:${tid}`;
}

function buildThreadLookup(threads, events) {
  const map = new Map();
  for (const t of threads) {
    map.set(t.id, { ...t });
  }
  for (const ev of events) {
    const id = threadKey(ev.pid, ev.tid);
    if (!map.has(id)) {
      map.set(id, {
        id,
        pid: ev.pid,
        tid: ev.tid,
        process: `pid_${ev.pid}`,
        threadName: `pid_${ev.pid}:${ev.tid}`,
        priority: ev.prio,
        policyCode: 'f',
        policy: 'SCHED_FIFO',
        state: 'READY',
        blockedOn: null
      });
    }
  }
  return map;
}

/**
 * Detect blocked SEND / REPLY / MUTEX IPC chains from pidin snapshot.
 */
function detectIpcChains(threads, threadMap) {
  const chains = [];
  const blockingStates = new Set(['SEND', 'REPLY', 'MUTEX', 'SEM', 'CONDVAR', 'JOIN']);

  for (const t of threads) {
    if (!blockingStates.has(t.state) || !t.blockedOn || !t.blockedOn.pid) continue;

    const visited = new Set([t.id]);
    const path = [
      {
        id: t.id,
        pid: t.pid,
        tid: t.tid,
        process: t.process,
        threadName: t.threadName,
        priority: t.priority,
        state: t.state
      }
    ];

    let cur = t;
    let isCycle = false;

    while (cur && cur.blockedOn && cur.blockedOn.pid) {
      const targetTid = cur.blockedOn.tid || 1;
      const nextId = threadKey(cur.blockedOn.pid, targetTid);
      const next =
        threadMap.get(nextId) ||
        threads.find((cand) => cand.pid === cur.blockedOn.pid) ||
        null;

      if (!next) {
        path.push({
          id: nextId,
          pid: cur.blockedOn.pid,
          tid: targetTid,
          process: cur.blockedOn.label || `pid_${cur.blockedOn.pid}`,
          threadName: cur.blockedOn.label || nextId,
          priority: null,
          state: 'UNKNOWN'
        });
        break;
      }

      if (visited.has(next.id)) {
        isCycle = true;
        path.push({
          id: next.id,
          pid: next.pid,
          tid: next.tid,
          process: next.process,
          threadName: next.threadName,
          priority: next.priority,
          state: next.state
        });
        break;
      }

      visited.add(next.id);
      path.push({
        id: next.id,
        pid: next.pid,
        tid: next.tid,
        process: next.process,
        threadName: next.threadName,
        priority: next.priority,
        state: next.state
      });

      if (!blockingStates.has(next.state)) break;
      cur = next;
    }

    if (path.length >= 2) {
      const head = path[0];
      const tail = path[path.length - 1];
      const hasPriorityDrop =
        tail.priority !== null && head.priority !== null && head.priority > tail.priority;

      if (isCycle || path.length >= 3 || hasPriorityDrop || head.state === 'MUTEX' || head.state === 'REPLY') {
        chains.push({
          id: `ipc-chain-${chains.length + 1}`,
          severity: isCycle ? 'CRITICAL' : hasPriorityDrop ? 'ERROR' : 'WARNING',
          isDeadlock: isCycle,
          hasPriorityDrop,
          hops: path.length - 1,
          head,
          tail,
          path,
          summary: isCycle
            ? `IPC Deadlock Cycle detected: ${path.map((n) => `${n.threadName}(${n.id})`).join(' -> ')}`
            : `Blocked ${head.state} chain (${path.length - 1} hop${path.length - 1 > 1 ? 's' : ''}): ${path
                .map((n) => `${n.threadName}[p${n.priority ?? '?'}]`)
                .join(' -> ')}`
        });
      }
    }
  }

  // Deduplicate sub-chains that are strict suffixes of longer chains
  const filtered = chains.filter((c) => {
    const sig = c.path.map((n) => n.id).join('>');
    return !chains.some((other) => other !== c && other.path.map((n) => n.id).join('>').endsWith(sig));
  });

  return filtered;
}

/**
 * Reconstruct per-thread timeline segments, IPC arrows, Priority Inversion bands, and Starvation.
 */
function analyzeTimeline(events, threadMap, options) {
  const starvationUs = options.starvationUs ?? 1000;
  const maxTimeUs = events.length ? events[events.length - 1].timeUs + 80 : 2000;

  const segmentsByThread = new Map();
  const activeSegment = new Map();
  const blockedOnOwner = new Map(); // waiterId -> { ownerId, state, sinceUs, waiterPrio, ownerPrio, detail }
  const readySince = new Map(); // tid -> startUs
  const piBoosted = new Set(); // ownerId currently boosted via PRIO_INHERIT

  const ipcEdges = [];
  const inversionBands = [];
  const starvationFindings = [];
  const traceJitters = [];

  let activeInversion = null;

  function ensureThread(pid, tid, prio) {
    const id = threadKey(pid, tid);
    if (!segmentsByThread.has(id)) {
      segmentsByThread.set(id, []);
    }
    if (!threadMap.has(id)) {
      threadMap.set(id, {
        id,
        pid,
        tid,
        process: `pid_${pid}`,
        threadName: `pid_${pid}:${tid}`,
        priority: prio,
        policyCode: 'f',
        policy: 'SCHED_FIFO',
        state: 'READY',
        blockedOn: null
      });
    }
    return id;
  }

  function closeSegment(id, endUs) {
    const seg = activeSegment.get(id);
    if (seg && endUs > seg.startUs) {
      seg.endUs = endUs;
      seg.durationUs = Number((endUs - seg.startUs).toFixed(1));
      segmentsByThread.get(id).push(seg);
    }
    activeSegment.delete(id);
  }

  function openSegment(id, state, startUs, cpu, prio, detail = '') {
    closeSegment(id, startUs);
    activeSegment.set(id, {
      id,
      state,
      startUs,
      endUs: startUs,
      durationUs: 0,
      cpu,
      prio,
      detail
    });
  }

  for (const ev of events) {
    const id = ensureThread(ev.pid, ev.tid, ev.prio);
    const meta = threadMap.get(id);
    const evName = ev.event;

    // Extract jitter metrics embedded in trace detail
    const jMatch = ev.detail.match(/jitter_us=([0-9]+(?:\.[0-9]+)?)/i);
    if (jMatch) {
      traceJitters.push({
        timeUs: ev.timeUs,
        pid: ev.pid,
        tid: ev.tid,
        threadName: meta.threadName,
        prio: ev.prio,
        jitterUs: Number.parseFloat(jMatch[1]),
        detail: ev.detail
      });
    }

    // Track priority inheritance boost events
    if (evName === 'PI_BOOST' || evName === 'PRIO_INHERIT' || evName === 'THPRIO_BOOST') {
      piBoosted.add(id);
      openSegment(id, 'PI_BOOST', ev.timeUs, ev.cpu, ev.prio, ev.detail || 'PTHREAD_PRIO_INHERIT boost');
      continue;
    }

    // Track IPC communication edges
    if (
      evName === 'MSG_SEND' ||
      evName === 'MSG_SENDV' ||
      evName === 'SEND' ||
      evName === 'MSG_REPLY' ||
      evName === 'MSG_REPLYV' ||
      evName === 'REPLY' ||
      evName === 'MSG_PULSE' ||
      evName === 'PULSE' ||
      evName === 'SEND_PULSE'
    ) {
      const kind =
        evName.includes('PULSE') ? 'PULSE' : evName.includes('REPLY') ? 'REPLY' : 'SEND';

      if (ev.targetPid !== null) {
        const targetId = ensureThread(ev.targetPid, ev.targetTid ?? 1, 55);
        ipcEdges.push({
          timeUs: ev.timeUs,
          kind,
          fromId: id,
          toId: targetId,
          fromName: meta.threadName,
          toName: threadMap.get(targetId)?.threadName || targetId,
          detail: ev.detail
        });

        if (kind === 'SEND') {
          openSegment(id, 'REPLY', ev.timeUs, ev.cpu, ev.prio, `Waiting reply from ${targetId}`);
        } else if (kind === 'REPLY') {
          // Target unblocked from REPLY
          openSegment(id, 'RUNNING', ev.timeUs, ev.cpu, ev.prio, ev.detail);
        }
      }
      continue;
    }

    if (evName === 'THMUTEX' || evName === 'MUTEX_BLOCK' || evName === 'SYNC_MUTEX_LOCK_BLOCK') {
      const ownerId =
        ev.targetPid !== null ? ensureThread(ev.targetPid, ev.targetTid ?? 1, 15) : null;
      const ownerMeta = ownerId ? threadMap.get(ownerId) : null;
      openSegment(id, 'MUTEX', ev.timeUs, ev.cpu, ev.prio, ev.detail || `Blocked on mutex (${ownerId || 'unknown'})`);

      if (ownerId && ownerMeta && ev.prio > ownerMeta.priority && !piBoosted.has(ownerId)) {
        blockedOnOwner.set(id, {
          waiterId: id,
          waiterName: meta.threadName,
          waiterPrio: ev.prio,
          ownerId,
          ownerName: ownerMeta.threadName,
          ownerPrio: ownerMeta.priority,
          sinceUs: ev.timeUs,
          detail: ev.detail
        });
      }
      continue;
    }

    if (evName === 'MUTEX_UNLOCK' || evName === 'SYNC_MUTEX_UNLOCK') {
      piBoosted.delete(id);
      // Close any active inversion associated with this owner
      if (activeInversion && activeInversion.ownerId === id) {
        activeInversion.endUs = ev.timeUs;
        activeInversion.durationUs = Number((ev.timeUs - activeInversion.startUs).toFixed(1));
        if (activeInversion.durationUs > 0) {
          inversionBands.push(activeInversion);
        }
        activeInversion = null;
      }
      for (const [wId, info] of blockedOnOwner.entries()) {
        if (info.ownerId === id) {
          blockedOnOwner.delete(wId);
        }
      }
      openSegment(id, 'RUNNING', ev.timeUs, ev.cpu, ev.prio, ev.detail || 'Mutex unlocked');
      continue;
    }

    if (evName === 'THRECEIVE' || evName === 'RECEIVE') {
      openSegment(id, 'RECEIVE', ev.timeUs, ev.cpu, ev.prio, ev.detail || 'MsgReceive() wait');
      continue;
    }

    if (evName === 'THNANOSLEEP' || evName === 'NANOSLEEP' || evName === 'SLEEP') {
      openSegment(id, 'SLEEP', ev.timeUs, ev.cpu, ev.prio, ev.detail || 'Periodic timer sleep');
      continue;
    }

    if (evName === 'THREADY' || evName === 'READY') {
      if (!readySince.has(id)) {
        readySince.set(id, ev.timeUs);
      }
      openSegment(id, 'READY', ev.timeUs, ev.cpu, ev.prio, ev.detail || 'Runnable in ready queue');
      continue;
    }

    if (evName === 'THRUNNING' || evName === 'RUNNING') {
      // Check starvation wait duration
      if (readySince.has(id)) {
        const waitedUs = Number((ev.timeUs - readySince.get(id)).toFixed(1));
        if (waitedUs >= starvationUs) {
          starvationFindings.push({
            id: `starve-${starvationFindings.length + 1}`,
            threadId: id,
            pid: ev.pid,
            tid: ev.tid,
            threadName: meta.threadName,
            priority: ev.prio,
            startUs: readySince.get(id),
            endUs: ev.timeUs,
            waitedUs
          });
        }
        readySince.delete(id);
      }

      // Check if this running thread is a MEDIUM-priority preemptor causing Priority Inversion!
      let triggeredInversion = false;
      for (const blk of blockedOnOwner.values()) {
        if (
          id !== blk.waiterId &&
          id !== blk.ownerId &&
          ev.prio > blk.ownerPrio &&
          ev.prio < blk.waiterPrio &&
          !piBoosted.has(blk.ownerId)
        ) {
          triggeredInversion = true;
          if (!activeInversion) {
            activeInversion = {
              id: `inv-${inversionBands.length + 1}`,
              startUs: ev.timeUs,
              endUs: ev.timeUs,
              durationUs: 0,
              cpu: ev.cpu,
              highThread: {
                id: blk.waiterId,
                name: blk.waiterName,
                prio: blk.waiterPrio
              },
              mediumThread: {
                id,
                name: meta.threadName,
                prio: ev.prio
              },
              lowOwner: {
                id: blk.ownerId,
                name: blk.ownerName,
                prio: blk.ownerPrio
              },
              ownerId: blk.ownerId,
              reason: `High-priority ${blk.waiterName} (p${blk.waiterPrio}) blocked on mutex held by ${blk.ownerName} (p${blk.ownerPrio}) while medium-priority ${meta.threadName} (p${ev.prio}) preempted CPU${ev.cpu}`
            };
          }
          break;
        }
      }

      // If high-priority waiter itself resumed running, close active inversion
      if (!triggeredInversion && activeInversion && (id === activeInversion.highThread.id || id === activeInversion.ownerId)) {
        activeInversion.endUs = ev.timeUs;
        activeInversion.durationUs = Number((ev.timeUs - activeInversion.startUs).toFixed(1));
        if (activeInversion.durationUs > 0) {
          inversionBands.push(activeInversion);
        }
        activeInversion = null;
      }

      const runState = piBoosted.has(id) ? 'PI_BOOST' : 'RUNNING';
      openSegment(id, runState, ev.timeUs, ev.cpu, ev.prio, ev.detail);
    }
  }

  // Finalize open segments
  for (const id of Array.from(activeSegment.keys())) {
    closeSegment(id, maxTimeUs);
  }

  // Finalize unclosed starvation
  for (const [id, startUs] of readySince.entries()) {
    const waitedUs = Number((maxTimeUs - startUs).toFixed(1));
    if (waitedUs >= starvationUs) {
      const meta = threadMap.get(id);
      starvationFindings.push({
        id: `starve-${starvationFindings.length + 1}`,
        threadId: id,
        pid: meta?.pid ?? 0,
        tid: meta?.tid ?? 0,
        threadName: meta?.threadName || id,
        priority: meta?.priority ?? 10,
        startUs,
        endUs: maxTimeUs,
        waitedUs
      });
    }
  }

  if (activeInversion) {
    activeInversion.endUs = maxTimeUs;
    activeInversion.durationUs = Number((maxTimeUs - activeInversion.startUs).toFixed(1));
    if (activeInversion.durationUs > 0) {
      inversionBands.push(activeInversion);
    }
  }

  // Build ordered timeline lanes (highest priority at top, matching RTOS oscilloscope convention)
  const timelineLanes = Array.from(segmentsByThread.entries())
    .map(([id, segments]) => {
      const meta = threadMap.get(id);
      return {
        id,
        pid: meta?.pid ?? 0,
        tid: meta?.tid ?? 0,
        process: meta?.process || id,
        threadName: meta?.threadName || id,
        priority: meta?.priority ?? 10,
        policy: meta?.policy || 'SCHED_FIFO',
        state: meta?.state || 'READY',
        segments
      };
    })
    .sort((a, b) => b.priority - a.priority || a.pid - b.pid || a.tid - b.tid);

  return {
    durationUs: maxTimeUs,
    timelineLanes,
    ipcEdges,
    inversionBands,
    starvationFindings,
    traceJitters
  };
}

/**
 * Full QNX 8.0 capture analyzer.
 */
export function analyzeCapture(rawOrParsed, options = {}) {
  const deadlineUs = Number.isFinite(options.deadlineUs) ? options.deadlineUs : 500;
  const starvationUs = Number.isFinite(options.starvationUs) ? options.starvationUs : 1000;

  const parsed =
    Array.isArray(rawOrParsed?.logs) && Array.isArray(rawOrParsed?.threads)
      ? rawOrParsed
      : parseCaptureBundle(rawOrParsed);

  const threadMap = buildThreadLookup(parsed.threads, parsed.events);
  const ipcChains = detectIpcChains(parsed.threads, threadMap);
  const timeline = analyzeTimeline(parsed.events, threadMap, { starvationUs });

  // Aggregate jitter samples from both slog2 telemetry and traceprinter events
  const jitterSamples = [];
  for (const log of parsed.logs) {
    if (log.metrics.jitterUs !== null) {
      jitterSamples.push({
        source: 'slog2',
        timestamp: log.timestamp,
        pid: log.pid,
        buffer: log.buffer,
        jitterUs: log.metrics.jitterUs,
        iter: log.metrics.iter,
        message: log.message
      });
    }
  }
  for (const tj of timeline.traceJitters) {
    jitterSamples.push({
      source: 'traceprinter',
      timestamp: `${tj.timeUs.toFixed(1)}us`,
      pid: tj.pid,
      buffer: tj.threadName,
      jitterUs: tj.jitterUs,
      iter: null,
      message: tj.detail
    });
  }

  const jitterValues = jitterSamples.map((s) => s.jitterUs).sort((a, b) => a - b);
  const deadlineViolations = jitterSamples.filter((s) => s.jitterUs > deadlineUs);

  const jitterStats = {
    count: jitterValues.length,
    budgetUs: deadlineUs,
    minUs: jitterValues.length ? jitterValues[0] : 0,
    p50Us: percentile(jitterValues, 50),
    p95Us: percentile(jitterValues, 95),
    p99Us: percentile(jitterValues, 99),
    maxUs: jitterValues.length ? jitterValues[jitterValues.length - 1] : 0,
    violationsCount: deadlineViolations.length,
    violations: deadlineViolations
  };

  // Assemble unified prioritized findings list
  const findings = [];

  for (const inv of timeline.inversionBands) {
    findings.push({
      id: inv.id,
      category: 'PRIORITY_INVERSION',
      severity: 'CRITICAL',
      title: `Priority Inversion (${inv.durationUs} us): ${inv.highThread.name}[p${inv.highThread.prio}] stalled by ${inv.mediumThread.name}[p${inv.mediumThread.prio}]`,
      description: inv.reason,
      windowUs: [inv.startUs, inv.endUs],
      durationUs: inv.durationUs,
      entities: [inv.highThread.id, inv.mediumThread.id, inv.lowOwner.id],
      remediation:
        'Initialize shared mutex with pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_INHERIT) so QNX Neutrino 8.0 kernel boosts the low-priority owner to prio ' +
        inv.highThread.prio +
        ' immediately on contention.'
    });
  }

  for (const chain of ipcChains) {
    findings.push({
      id: chain.id,
      category: chain.isDeadlock ? 'IPC_DEADLOCK' : 'IPC_BLOCK_CHAIN',
      severity: chain.severity,
      title: chain.summary,
      description: `Head thread ${chain.head.threadName} (pid=${chain.head.pid}, tid=${chain.head.tid}, prio=${chain.head.priority}, state=${chain.head.state}) is blocked waiting on ${chain.tail.threadName} (pid=${chain.tail.pid}, state=${chain.tail.state}).`,
      entities: chain.path.map((n) => n.id),
      remediation: chain.isDeadlock
        ? 'Break circular MsgSend() dependency using asynchronous MsgSendPulse() or non-blocking reply queue.'
        : 'Ensure server thread runs with priority inheritance enabled (default for QNX MsgSend/MsgReceive channels unless _NTO_CHF_FIXED_PRIORITY is set) and minimize critical section duration.'
    });
  }

  if (deadlineViolations.length > 0) {
    const worst = deadlineViolations.reduce((a, b) => (b.jitterUs > a.jitterUs ? b : a), deadlineViolations[0]);
    findings.push({
      id: 'rt-deadline-jitter',
      category: 'DEADLINE_VIOLATION',
      severity: 'ERROR',
      title: `Hard-RT Deadline Exceeded: max ${jitterStats.maxUs} us > ${deadlineUs} us budget (${deadlineViolations.length} violation${deadlineViolations.length > 1 ? 's' : ''})`,
      description: `Worst jitter observed in ${worst.buffer} (pid=${worst.pid ?? 'n/a'}) at ${worst.timestamp}: ${worst.jitterUs} us (budget ${deadlineUs} us).`,
      entities: worst.pid ? [`${worst.pid}`] : [],
      remediation:
        'Eliminate priority inversions with PTHREAD_PRIO_INHERIT, pin 1kHz control thread with ThreadCtl(_NTO_TCTL_RUNMASK) to an isolated CPU core, and avoid blocking slog2/PPS I/O inside the control loop.'
    });
  }

  for (const st of timeline.starvationFindings) {
    findings.push({
      id: st.id,
      category: 'THREAD_STARVATION',
      severity: 'WARNING',
      title: `Thread Starvation: ${st.threadName} (${st.threadId}, p${st.priority}) waited ${st.waitedUs} us in READY queue`,
      description: `Thread ${st.threadName} became READY at ${st.startUs} us and did not receive CPU time until ${st.endUs} us (threshold ${starvationUs} us).`,
      entities: [st.threadId],
      remediation:
        'Check higher-priority SCHED_FIFO busy loops or configure QNX Adaptive Partitioning (APS) budget guarantees for lower-priority telemetry tasks.'
    });
  }

  const criticalCount = findings.filter((f) => f.severity === 'CRITICAL').length;
  const errorCount = findings.filter((f) => f.severity === 'ERROR').length;
  const warningCount = findings.filter((f) => f.severity === 'WARNING').length;

  const hasRtViolation =
    timeline.inversionBands.length > 0 ||
    deadlineViolations.length > 0 ||
    ipcChains.some((c) => c.isDeadlock) ||
    criticalCount > 0 ||
    errorCount > 0;

  let score = 100;
  score -= timeline.inversionBands.length * 32;
  score -= Math.min(30, deadlineViolations.length * 10);
  score -= ipcChains.filter((c) => c.isDeadlock).length * 40;
  score -= ipcChains.filter((c) => !c.isDeadlock && c.hasPriorityDrop).length * 12;
  score -= timeline.starvationFindings.length * 8;
  score = Math.max(0, Math.min(100, score));

  const fifoThreads = parsed.threads.filter((t) => t.policy === 'SCHED_FIFO').length;
  const slogErrors = parsed.logs.filter((l) => l.severity === 'CRITICAL' || l.severity === 'ERROR').length;

  return {
    tool: 'QNX Pulse Studio',
    version: '1.0.0',
    meta: parsed.meta,
    status: hasRtViolation ? 'FAIL' : 'PASS',
    exitCode: hasRtViolation ? 2 : 0,
    score,
    options: { deadlineUs, starvationUs },
    summary: {
      totalThreads: parsed.threads.length,
      fifoThreads,
      totalTraceEvents: parsed.events.length,
      totalLogs: parsed.logs.length,
      slogErrors,
      ppsObjectCount: parsed.ppsObjects.length,
      priorityInversions: timeline.inversionBands.length,
      ipcBlockChains: ipcChains.length,
      deadlineViolations: deadlineViolations.length,
      starvedThreads: timeline.starvationFindings.length,
      criticalFindings: criticalCount,
      errorFindings: errorCount,
      warningFindings: warningCount
    },
    jitterStats,
    findings,
    ipcChains,
    inversionBands: timeline.inversionBands,
    starvationFindings: timeline.starvationFindings,
    ipcEdges: timeline.ipcEdges,
    timelineDurationUs: timeline.durationUs,
    timelineLanes: timeline.timelineLanes,
    threads: parsed.threads,
    logs: parsed.logs,
    ppsObjects: parsed.ppsObjects
  };
}

export function formatJsonReport(report) {
  return JSON.stringify(report, null, 2);
}

export function formatMarkdownReport(report) {
  const lines = [];
  lines.push(`# QNX Pulse Studio - Real-Time Audit Report`);
  lines.push('');
  lines.push(`- **Target Capture:** ${report.meta?.name || 'QNX 8.0 Capture'} (\`${report.meta?.target || 'x86_64-neutrino-8.0'}\`)`);
  lines.push(`- **Verdict:** **${report.status}** (CI Exit Code \`${report.exitCode}\`)`);
  lines.push(`- **RT Determinism Score:** **${report.score} / 100**`);
  lines.push(`- **Deadline Budget:** \`${report.options.deadlineUs} us\` | **Max Jitter:** \`${report.jitterStats.maxUs} us\` (P95: \`${report.jitterStats.p95Us} us\`, P99: \`${report.jitterStats.p99Us} us\`)`);
  lines.push('');
  lines.push(`## Telemetry Summary`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Active Threads (\`pidin\`) | ${report.summary.totalThreads} (${report.summary.fifoThreads} \`SCHED_FIFO\`) |`);
  lines.push(`| Priority Inversions | ${report.summary.priorityInversions} |`);
  lines.push(`| Hard-RT Deadline Violations (>${report.options.deadlineUs}us) | ${report.summary.deadlineViolations} |`);
  lines.push(`| Blocked IPC Chains | ${report.summary.ipcBlockChains} |`);
  lines.push(`| Starved Threads | ${report.summary.starvedThreads} |`);
  lines.push(`| Kernel Trace Events (\`traceprinter\`) | ${report.summary.totalTraceEvents} |`);
  lines.push(`| \`slog2\` Entries (Errors/Critical) | ${report.summary.totalLogs} (${report.summary.slogErrors}) |`);
  lines.push(`| PPS Objects (\`/pps/\`) | ${report.summary.ppsObjectCount} |`);
  lines.push('');
  lines.push(`## Findings (${report.findings.length})`);
  lines.push('');

  if (report.findings.length === 0) {
    lines.push(`All hard real-time constraints satisfied. Zero priority inversions, zero deadline violations, and deterministic QNX 8.0 IPC execution verified.`);
  } else {
    for (const f of report.findings) {
      lines.push(`### [${f.severity}] ${f.title}`);
      lines.push(`- **Category:** \`${f.category}\``);
      lines.push(`- **Detail:** ${f.description}`);
      lines.push(`- **Remediation:** ${f.remediation}`);
      lines.push('');
    }
  }

  lines.push(`## \`pidin\` Thread Snapshot`);
  lines.push('');
  lines.push(`| PID:TID | Process | Thread | Prio/Policy | State | Blocked On |`);
  lines.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const t of report.threads) {
    lines.push(
      `| \`${t.id}\` | \`${t.process}\` | \`${t.threadName}\` | \`${t.priority}${t.policyCode}\` (${t.policy}) | **${t.state}** | \`${t.blockedOn ? t.blockedOn.raw : '-'}\` |`
    );
  }
  lines.push('');
  return lines.join('\n');
}
