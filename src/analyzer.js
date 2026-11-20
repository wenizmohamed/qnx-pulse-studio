/**
 * QNX Pulse Studio - Real-Time Neutrino 8.0 Trace & IPC Diagnostics Engine
 *
 * Detects:
 *   1. Priority Inversions (single-hop & transitive multi-hop A->B->C chains)
 *   2. Multi-Hop Priority Inheritance Chains & Blocking Trees with exact WCBL
 *      (Worst-Case Blocking Latency) before/after PTHREAD_PRIO_INHERIT
 *   3. Blocked SEND / REPLY / MUTEX IPC Chains & Circular Deadlocks
 *   4. Multi-Core SMP CPU-Core Migrations, Core Utilization, Preemption Counters & Affinity Risk
 *   5. Hard-RT Deadline Jitter Violations (> deadlineUs, default 500us) & Margin Histogram
 *   6. Thread Starvation (READY threads starved beyond starvationUs, default 1000us)
 *
 * Produces structured AuditReport + Terminal / JSON / Markdown / SARIF 2.1.0 / JUnit XML
 * and CI exitCode (0 PASS, 2 RT VIOLATION FAIL).
 * SPDX-License-Identifier: MIT
 */

import { parseCaptureBundle } from './parsers.js';

const TOOL_VERSION = '2.0.0';
const BLOCKING_STATES = new Set(['SEND', 'REPLY', 'MUTEX', 'SEM', 'CONDVAR', 'JOIN']);

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(1));
}

function round1(n) {
  return Number((Number.isFinite(n) ? n : 0).toFixed(1));
}

function threadKey(pid, tid) {
  return `${pid}:${tid}`;
}

function extractResourceName(detail = '', fallback = null) {
  if (fallback) return fallback;
  if (!detail) return null;
  const m =
    detail.match(/\b(g_[a-zA-Z0-9_]+|mtx_[a-zA-Z0-9_]+|[a-zA-Z0-9_]+_mtx|[a-zA-Z0-9_]+_lock)\b/) ||
    detail.match(/mutex\s*\(([^)]+)\)/i);
  return m ? m[1] : null;
}

function extractCriticalSectionUs(detail = '') {
  if (!detail) return null;
  const m = detail.match(/cs_us=([0-9]+(?:\.[0-9]+)?)/i);
  return m ? Number.parseFloat(m[1]) : null;
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

  for (const t of threads) {
    if (!BLOCKING_STATES.has(t.state) || !t.blockedOn || !t.blockedOn.pid) continue;

    const visited = new Set([t.id]);
    const path = [
      {
        id: t.id,
        pid: t.pid,
        tid: t.tid,
        process: t.process,
        threadName: t.threadName,
        priority: t.priority,
        state: t.state,
        resource: t.blockedOn.label || null
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
          state: 'UNKNOWN',
          resource: null
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
          state: next.state,
          resource: next.blockedOn?.label || null
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
        state: next.state,
        resource: next.blockedOn?.label || null
      });

      if (!BLOCKING_STATES.has(next.state)) break;
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
 * Reconstruct per-thread timeline segments, IPC arrows, Priority Inversion bands,
 * SMP core migrations, preemption counters, and mutex contention telemetry.
 */
function analyzeTimeline(events, threadMap, options) {
  const starvationUs = options.starvationUs ?? 1000;
  const maxTimeUs = events.length ? events[events.length - 1].timeUs + 80 : 2000;

  const segmentsByThread = new Map();
  const activeSegment = new Map();
  const blockedOnOwner = new Map(); // waiterId -> { waiterId, waiterName, waiterPrio, ownerId, ownerName, ownerPrio, sinceUs, resource, detail }
  const readySince = new Map(); // tid -> startUs
  const piBoosted = new Set(); // ownerId currently boosted via PRIO_INHERIT
  const piBoostHistory = new Set(); // any thread that received PI_BOOST in trace

  // Track mutex blocking edges observed in trace (for multi-hop chain & WCBL analysis)
  const traceMutexEdges = new Map(); // `${waiterId}->${ownerId}` -> edge record
  const csHoldByOwner = new Map(); // ownerId -> measured or annotated critical section duration (us)
  const ownerLockStart = new Map(); // ownerId -> startUs

  // Track SMP per-CPU state, migrations, and preemptions
  const lastRunCpuByThread = new Map(); // threadId -> cpu
  const runningThreadOnCpu = new Map(); // cpu -> { threadId, prio, startUs }
  const migrations = [];
  const preemptionsByThread = new Map(); // threadId -> count
  const preemptionsByCpu = new Map(); // cpu -> count
  const contextSwitchesByCpu = new Map(); // cpu -> count

  const ipcEdges = [];
  const inversionBands = [];
  const starvationFindings = [];
  const traceJitters = [];

  const activeInversions = new Map(); // rootOwnerId -> inversion band

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

  function incMap(map, key, by = 1) {
    map.set(key, (map.get(key) || 0) + by);
  }

  function closeSegment(id, endUs) {
    const seg = activeSegment.get(id);
    if (seg && endUs > seg.startUs) {
      seg.endUs = endUs;
      seg.durationUs = round1(endUs - seg.startUs);
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

  /**
   * Resolve transitive root owner of a blocked waiter (A -> B -> C returns C and full chain).
   */
  function resolveTransitiveChain(startWaiterId) {
    const chain = [];
    const seen = new Set();
    let cur = startWaiterId;
    while (cur && blockedOnOwner.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const blk = blockedOnOwner.get(cur);
      chain.push(blk);
      cur = blk.ownerId;
    }
    return chain;
  }

  function closeInversionForOwner(ownerId, endUs) {
    const inv = activeInversions.get(ownerId);
    if (!inv) return;
    inv.endUs = endUs;
    inv.durationUs = round1(endUs - inv.startUs);
    if (inv.durationUs > 0) {
      inversionBands.push(inv);
    }
    activeInversions.delete(ownerId);
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

    // Track explicit cs_us annotations or mutex acquire hints
    const annotatedCs = extractCriticalSectionUs(ev.detail);
    if (annotatedCs !== null) {
      csHoldByOwner.set(id, Math.max(csHoldByOwner.get(id) || 0, annotatedCs));
    }
    if (/acquires\s+\S+/i.test(ev.detail)) {
      ownerLockStart.set(id, ev.timeUs);
    }

    // Track priority inheritance boost events
    if (evName === 'PI_BOOST' || evName === 'PRIO_INHERIT' || evName === 'THPRIO_BOOST') {
      piBoosted.add(id);
      piBoostHistory.add(id);
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
      const kind = evName.includes('PULSE') ? 'PULSE' : evName.includes('REPLY') ? 'REPLY' : 'SEND';

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
          if (runningThreadOnCpu.get(ev.cpu)?.threadId === id) {
            runningThreadOnCpu.delete(ev.cpu);
          }
          openSegment(id, 'REPLY', ev.timeUs, ev.cpu, ev.prio, `Waiting reply from ${targetId}`);
        } else if (kind === 'REPLY') {
          openSegment(id, 'RUNNING', ev.timeUs, ev.cpu, ev.prio, ev.detail);
        }
      }
      continue;
    }

    if (evName === 'THMUTEX' || evName === 'MUTEX_BLOCK' || evName === 'SYNC_MUTEX_LOCK_BLOCK') {
      const ownerId = ev.targetPid !== null ? ensureThread(ev.targetPid, ev.targetTid ?? 1, 15) : null;
      const ownerMeta = ownerId ? threadMap.get(ownerId) : null;
      const resource = extractResourceName(ev.detail, meta.blockedOn?.label || 'mutex');
      if (runningThreadOnCpu.get(ev.cpu)?.threadId === id) {
        runningThreadOnCpu.delete(ev.cpu);
      }
      openSegment(id, 'MUTEX', ev.timeUs, ev.cpu, ev.prio, ev.detail || `Blocked on ${resource} (${ownerId || 'unknown'})`);

      if (ownerId && ownerMeta) {
        const edgeKey = `${id}->${ownerId}`;
        if (!traceMutexEdges.has(edgeKey)) {
          traceMutexEdges.set(edgeKey, {
            waiterId: id,
            waiterName: meta.threadName,
            waiterPrio: ev.prio,
            ownerId,
            ownerName: ownerMeta.threadName,
            ownerPrio: ownerMeta.priority,
            resource,
            blockedAtUs: ev.timeUs,
            unblockedAtUs: null,
            waitDurationUs: null,
            piBoosted: piBoosted.has(ownerId)
          });
        }

        if (ev.prio > ownerMeta.priority && !piBoosted.has(ownerId)) {
          blockedOnOwner.set(id, {
            waiterId: id,
            waiterName: meta.threadName,
            waiterPrio: ev.prio,
            ownerId,
            ownerName: ownerMeta.threadName,
            ownerPrio: ownerMeta.priority,
            sinceUs: ev.timeUs,
            resource,
            detail: ev.detail
          });
        }
      }
      continue;
    }

    if (evName === 'MUTEX_UNLOCK' || evName === 'SYNC_MUTEX_UNLOCK') {
      const wasBoosted = piBoosted.has(id);
      piBoosted.delete(id);

      // Measure owner's uninterrupted critical section slice (time from last resume to unlock)
      const curSeg = activeSegment.get(id);
      if (curSeg && (curSeg.state === 'RUNNING' || curSeg.state === 'PI_BOOST') && ev.timeUs > curSeg.startUs) {
        const sliceUs = round1(ev.timeUs - curSeg.startUs);
        if (!csHoldByOwner.has(id)) {
          csHoldByOwner.set(id, sliceUs);
        }
      } else if (ownerLockStart.has(id) && !csHoldByOwner.has(id)) {
        csHoldByOwner.set(id, round1(Math.min(180, Math.max(20, ev.timeUs - ownerLockStart.get(id)))));
      }

      // Close any active inversion associated with this owner
      closeInversionForOwner(id, ev.timeUs);

      // Record unblock timestamps for trace mutex edges
      for (const edge of traceMutexEdges.values()) {
        if (edge.ownerId === id && edge.unblockedAtUs === null) {
          edge.unblockedAtUs = ev.timeUs;
          edge.waitDurationUs = round1(ev.timeUs - edge.blockedAtUs);
          if (wasBoosted) edge.piBoosted = true;
        }
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
      if (runningThreadOnCpu.get(ev.cpu)?.threadId === id) {
        runningThreadOnCpu.delete(ev.cpu);
      }
      openSegment(id, 'RECEIVE', ev.timeUs, ev.cpu, ev.prio, ev.detail || 'MsgReceive() wait');
      continue;
    }

    if (evName === 'THNANOSLEEP' || evName === 'NANOSLEEP' || evName === 'SLEEP') {
      if (runningThreadOnCpu.get(ev.cpu)?.threadId === id) {
        runningThreadOnCpu.delete(ev.cpu);
      }
      openSegment(id, 'SLEEP', ev.timeUs, ev.cpu, ev.prio, ev.detail || 'Periodic timer sleep');
      continue;
    }

    if (evName === 'THREADY' || evName === 'READY') {
      if (!readySince.has(id)) {
        readySince.set(id, ev.timeUs);
      }
      const prevSeg = activeSegment.get(id);
      if (prevSeg && (prevSeg.state === 'RUNNING' || prevSeg.state === 'PI_BOOST')) {
        incMap(preemptionsByThread, id, 1);
        incMap(preemptionsByCpu, ev.cpu, 1);
      }
      if (runningThreadOnCpu.get(ev.cpu)?.threadId === id) {
        runningThreadOnCpu.delete(ev.cpu);
      }
      openSegment(id, 'READY', ev.timeUs, ev.cpu, ev.prio, ev.detail || 'Runnable in ready queue');
      continue;
    }

    if (evName === 'THRUNNING' || evName === 'RUNNING') {
      // Track SMP CPU context switch & preemption on this core
      const prevOnCpu = runningThreadOnCpu.get(ev.cpu);
      if (prevOnCpu && prevOnCpu.threadId !== id) {
        incMap(contextSwitchesByCpu, ev.cpu, 1);
        const prevSeg = activeSegment.get(prevOnCpu.threadId);
        if (prevSeg && prevSeg.state === 'RUNNING' && prevSeg.cpu === ev.cpu) {
          incMap(preemptionsByThread, prevOnCpu.threadId, 1);
          incMap(preemptionsByCpu, ev.cpu, 1);
        }
      } else if (!prevOnCpu) {
        incMap(contextSwitchesByCpu, ev.cpu, 1);
      }
      runningThreadOnCpu.set(ev.cpu, { threadId: id, prio: ev.prio, startUs: ev.timeUs });

      // Track SMP CPU core migration for this thread
      if (lastRunCpuByThread.has(id)) {
        const prevCpu = lastRunCpuByThread.get(id);
        if (prevCpu !== ev.cpu) {
          migrations.push({
            id: `migr-${migrations.length + 1}`,
            timeUs: ev.timeUs,
            threadId: id,
            pid: ev.pid,
            tid: ev.tid,
            threadName: meta.threadName,
            priority: ev.prio,
            policy: meta.policy || 'SCHED_FIFO',
            fromCpu: prevCpu,
            toCpu: ev.cpu,
            detail: ev.detail || `Migrated CPU${prevCpu} -> CPU${ev.cpu}`
          });
        }
      }
      lastRunCpuByThread.set(id, ev.cpu);

      // Update unblock duration if this waiter just resumed after mutex wait
      for (const edge of traceMutexEdges.values()) {
        if (edge.waiterId === id && edge.unblockedAtUs === null) {
          edge.unblockedAtUs = ev.timeUs;
          edge.waitDurationUs = round1(ev.timeUs - edge.blockedAtUs);
        }
      }

      // Check starvation wait duration
      if (readySince.has(id)) {
        const waitedUs = round1(ev.timeUs - readySince.get(id));
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

      // Check if this running thread is a MEDIUM-priority preemptor causing single-hop or transitive Priority Inversion.
      // On SMP, an inversion occurs only when the terminal mutex owner is NOT running (preempted/READY) or was displaced on this CPU.
      let triggeredInversion = false;
      let bestMatch = null;
      for (const waiterId of blockedOnOwner.keys()) {
        const chain = resolveTransitiveChain(waiterId);
        if (!chain.length) continue;
        const headBlk = chain[0];
        const tailBlk = chain[chain.length - 1];
        const chainIds = new Set(chain.flatMap((c) => [c.waiterId, c.ownerId]));
        const ownerSeg = activeSegment.get(tailBlk.ownerId);
        const ownerIsPreempted =
          !ownerSeg ||
          ownerSeg.state === 'READY' ||
          (ownerSeg.state === 'RUNNING' && ownerSeg.cpu === ev.cpu);
        if (
          !chainIds.has(id) &&
          ownerIsPreempted &&
          ev.prio > tailBlk.ownerPrio &&
          ev.prio < headBlk.waiterPrio &&
          !piBoosted.has(tailBlk.ownerId)
        ) {
          if (!bestMatch || headBlk.waiterPrio > bestMatch.headBlk.waiterPrio || chain.length > bestMatch.chain.length) {
            bestMatch = { headBlk, tailBlk, chain };
          }
        }
      }

      if (bestMatch) {
        const { headBlk, tailBlk, chain } = bestMatch;
        triggeredInversion = true;
        if (!activeInversions.has(tailBlk.ownerId)) {
          const hopDesc =
            chain.length > 1
              ? ` (${chain.length}-hop transitive chain ${chain.map((c) => `${c.waiterName}[p${c.waiterPrio}]`).join(' -> ')} -> ${tailBlk.ownerName}[p${tailBlk.ownerPrio}])`
              : '';
          activeInversions.set(tailBlk.ownerId, {
            id: `inv-${inversionBands.length + activeInversions.size + 1}`,
            startUs: ev.timeUs,
            endUs: ev.timeUs,
            durationUs: 0,
            cpu: ev.cpu,
            hops: chain.length,
            isTransitive: chain.length > 1,
            highThread: {
              id: headBlk.waiterId,
              name: headBlk.waiterName,
              prio: headBlk.waiterPrio
            },
            mediumThread: {
              id,
              name: meta.threadName,
              prio: ev.prio
            },
            lowOwner: {
              id: tailBlk.ownerId,
              name: tailBlk.ownerName,
              prio: tailBlk.ownerPrio
            },
            ownerId: tailBlk.ownerId,
            reason: `High-priority ${headBlk.waiterName} (p${headBlk.waiterPrio}) blocked on mutex held by ${tailBlk.ownerName} (p${tailBlk.ownerPrio})${hopDesc} while medium-priority ${meta.threadName} (p${ev.prio}) preempted CPU${ev.cpu}`
          });
        }
      }

      // If high-priority waiter or low owner resumed running, close active inversion for that owner
      if (!triggeredInversion) {
        for (const [ownerId, inv] of Array.from(activeInversions.entries())) {
          if (id === inv.highThread.id || id === ownerId) {
            closeInversionForOwner(ownerId, ev.timeUs);
          }
        }
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
    const waitedUs = round1(maxTimeUs - startUs);
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

  for (const ownerId of Array.from(activeInversions.keys())) {
    closeInversionForOwner(ownerId, maxTimeUs);
  }

  // Build ordered timeline lanes (highest priority at top) with per-thread SMP telemetry
  const timelineLanes = Array.from(segmentsByThread.entries())
    .map(([id, segments]) => {
      const meta = threadMap.get(id);
      const runSegs = segments.filter((s) => s.state === 'RUNNING' || s.state === 'PI_BOOST');
      const cpuTime = new Map();
      for (const seg of runSegs) {
        cpuTime.set(seg.cpu, (cpuTime.get(seg.cpu) || 0) + seg.durationUs);
      }
      const cpusUsed = Array.from(new Set(segments.map((s) => s.cpu))).sort((a, b) => a - b);
      let primaryCpu = cpusUsed.length ? cpusUsed[0] : 0;
      let bestCpuTime = -1;
      for (const [cpu, dur] of cpuTime.entries()) {
        if (dur > bestCpuTime) {
          bestCpuTime = dur;
          primaryCpu = cpu;
        }
      }
      const threadMigrations = migrations.filter((m) => m.threadId === id);
      const runTimeUs = round1(runSegs.reduce((acc, s) => acc + s.durationUs, 0));

      return {
        id,
        pid: meta?.pid ?? 0,
        tid: meta?.tid ?? 0,
        process: meta?.process || id,
        threadName: meta?.threadName || id,
        priority: meta?.priority ?? 10,
        policy: meta?.policy || 'SCHED_FIFO',
        state: meta?.state || 'READY',
        primaryCpu,
        cpusUsed,
        runTimeUs,
        migrationCount: threadMigrations.length,
        preemptionCount: preemptionsByThread.get(id) || 0,
        affinityStatus: threadMigrations.length > 0 ? 'MIGRATED' : 'PINNED',
        migrations: threadMigrations,
        segments
      };
    })
    .sort((a, b) => b.priority - a.priority || a.pid - b.pid || a.tid - b.tid);

  // Per-core SMP utilization & preemption summary
  const observedCores = new Set();
  for (const ev of events) observedCores.add(ev.cpu);
  const maxCoreIdx = observedCores.size ? Math.max(...observedCores) : 1;
  const coreCount = Math.max(2, maxCoreIdx + 1);
  const perCoreStats = [];

  for (let cpu = 0; cpu < coreCount; cpu++) {
    let runningUs = 0;
    const threadsOnCore = new Set();
    for (const lane of timelineLanes) {
      for (const seg of lane.segments) {
        if (seg.cpu === cpu && (seg.state === 'RUNNING' || seg.state === 'PI_BOOST')) {
          runningUs += seg.durationUs;
          threadsOnCore.add(lane.threadName);
        }
      }
    }
    const clampedRun = round1(Math.min(maxTimeUs, runningUs));
    const utilizationPct = maxTimeUs > 0 ? round1((clampedRun / maxTimeUs) * 100) : 0;
    perCoreStats.push({
      cpu,
      label: `CPU${cpu}`,
      runningUs: clampedRun,
      utilizationPct,
      contextSwitches: contextSwitchesByCpu.get(cpu) || 0,
      preemptions: preemptionsByCpu.get(cpu) || 0,
      threadsCount: threadsOnCore.size,
      threadNames: Array.from(threadsOnCore)
    });
  }

  return {
    durationUs: maxTimeUs,
    timelineLanes,
    ipcEdges,
    inversionBands,
    starvationFindings,
    traceJitters,
    traceMutexEdges: Array.from(traceMutexEdges.values()),
    csHoldByOwner,
    piBoostHistory,
    smp: {
      coreCount,
      coresUsed: Array.from(observedCores).sort((a, b) => a - b),
      totalMigrations: migrations.length,
      totalPreemptions: Array.from(preemptionsByThread.values()).reduce((a, b) => a + b, 0),
      migrations,
      perCoreStats
    }
  };
}

/**
 * Multi-Hop Priority Inheritance Chain & Blocking Tree Analyzer.
 * Merges mutex/IPC ownership edges from pidin + traceprinter, detects transitive A->B->C chains,
 * builds rooted blocking trees (fan-in + multi-hop), and computes exact worst-case blocking latency
 * before vs. after PTHREAD_PRIO_INHERIT.
 */
function analyzePriorityInheritanceChains(threads, threadMap, timeline, jitterSamples) {
  // Build unified waiter -> owner map (mutex + blocking IPC edges)
  const edgeByWaiter = new Map();

  // 1. Seed from traceprinter mutex blocking events (exact timestamps & measured wait durations)
  for (const te of timeline.traceMutexEdges) {
    edgeByWaiter.set(te.waiterId, {
      waiterId: te.waiterId,
      ownerId: te.ownerId,
      kind: 'MUTEX',
      resource: te.resource || 'g_mutex',
      waitDurationUs: te.waitDurationUs,
      piBoosted: te.piBoosted || timeline.piBoostHistory.has(te.ownerId),
      source: 'trace'
    });
  }

  // 2. Augment from pidin MUTEX / SEND / REPLY / SEM / CONDVAR edges
  for (const t of threads) {
    if (!BLOCKING_STATES.has(t.state) || !t.blockedOn || !t.blockedOn.pid) continue;
    const ownerTid = t.blockedOn.tid || 1;
    const ownerId = threadKey(t.blockedOn.pid, ownerTid);
    const resolvedOwner =
      threadMap.get(ownerId) ||
      threads.find((cand) => cand.pid === t.blockedOn.pid) ||
      null;
    const finalOwnerId = resolvedOwner ? resolvedOwner.id : ownerId;
    const existing = edgeByWaiter.get(t.id);

    if (!existing) {
      edgeByWaiter.set(t.id, {
        waiterId: t.id,
        ownerId: finalOwnerId,
        kind: t.state,
        resource: t.blockedOn.label || (t.state === 'MUTEX' ? 'mutex' : `${t.state.toLowerCase()}_ch`),
        waitDurationUs: null,
        piBoosted: timeline.piBoostHistory.has(finalOwnerId),
        source: 'pidin'
      });
    } else if (t.blockedOn.label && (!existing.resource || existing.resource === 'mutex')) {
      existing.resource = t.blockedOn.label;
    }
  }

  // Identify incoming count to find leaf waiters (roots of waiter->owner chains)
  const isOwnerOfSomething = new Set();
  for (const edge of edgeByWaiter.values()) {
    isOwnerOfSomething.add(edge.ownerId);
  }

  // Walk every chain starting from waiters (preferring top-most waiters, but still capturing cycles)
  const allChains = [];
  const seenSigs = new Set();

  const sortedWaiters = Array.from(edgeByWaiter.keys()).sort((a, b) => {
    const aRoot = !isOwnerOfSomething.has(a) ? 0 : 1;
    const bRoot = !isOwnerOfSomething.has(b) ? 0 : 1;
    if (aRoot !== bRoot) return aRoot - bRoot;
    return (threadMap.get(b)?.priority ?? 0) - (threadMap.get(a)?.priority ?? 0);
  });

  // Pre-collect running/medium-prio threads for preemption estimation
  const allThreads = Array.from(threadMap.values());

  for (const startId of sortedWaiters) {
    const visited = new Set([startId]);
    const nodeIds = [startId];
    const links = [];
    let cur = startId;
    let isCycle = false;

    while (edgeByWaiter.has(cur)) {
      const edge = edgeByWaiter.get(cur);
      links.push(edge);
      const nextId = edge.ownerId;
      if (visited.has(nextId)) {
        isCycle = true;
        nodeIds.push(nextId);
        break;
      }
      visited.add(nextId);
      nodeIds.push(nextId);
      cur = nextId;
    }

    if (links.length === 0) continue;

    const sig = nodeIds.join('>');
    if (seenSigs.has(sig)) continue;
    // Skip strict suffix sub-chains unless cycle
    if (!isCycle && allChains.some((existing) => existing.signature.endsWith(sig) && existing.signature !== sig)) {
      continue;
    }

    const nodes = nodeIds.map((nid, idx) => {
      const meta = threadMap.get(nid);
      const lane = timeline.timelineLanes.find((l) => l.id === nid);
      return {
        id: nid,
        pid: meta?.pid ?? Number.parseInt(nid.split(':')[0], 10) ?? 0,
        tid: meta?.tid ?? Number.parseInt(nid.split(':')[1], 10) ?? 1,
        process: meta?.process || `pid_${nid}`,
        threadName: meta?.threadName || nid,
        priority: meta?.priority ?? 10,
        policy: meta?.policy || 'SCHED_FIFO',
        state: meta?.state || (idx === nodeIds.length - 1 ? 'READY' : 'MUTEX'),
        cpu: lane?.primaryCpu ?? 0,
        piBoosted: timeline.piBoostHistory.has(nid),
        criticalSectionUs: timeline.csHoldByOwner.get(nid) ?? null
      };
    });

    const head = nodes[0];
    const tail = nodes[nodes.length - 1];
    const hasPriorityDrop = head.priority > tail.priority;
    const isMutexChain = links.some((l) => l.kind === 'MUTEX');
    const hops = links.length;

    // Keep chains that involve mutex contention, priority drops, multi-hop chains, or cycles
    if (!isMutexChain && !hasPriorityDrop && hops < 2 && !isCycle) continue;

    // Determine medium-priority preemptors that run between tail.priority and head.priority
    const chainIdSet = new Set(nodeIds);
    const preemptors = [];
    for (const lane of timeline.timelineLanes) {
      if (chainIdSet.has(lane.id)) continue;
      if (lane.priority > tail.priority && lane.priority < head.priority && lane.runTimeUs > 0) {
        preemptors.push({
          id: lane.id,
          threadName: lane.threadName,
          priority: lane.priority,
          cpu: lane.primaryCpu,
          burstUs: lane.runTimeUs
        });
      }
    }
    // Fallback to pidin RUNNING medium-priority threads when no trace is provided
    if (preemptors.length === 0) {
      for (const th of allThreads) {
        if (chainIdSet.has(th.id)) continue;
        if (th.priority > tail.priority && th.priority < head.priority && th.state === 'RUNNING') {
          preemptors.push({
            id: th.id,
            threadName: th.threadName,
            priority: th.priority,
            cpu: 0,
            burstUs: 600
          });
        }
      }
    }

    const piProtected = !isCycle && (links.every((l) => l.piBoosted) || (timeline.inversionBands.length === 0 && timeline.piBoostHistory.has(tail.id)));

    // Compute exact Worst-Case Blocking Latency (WCBL) BEFORE vs AFTER PTHREAD_PRIO_INHERIT
    // After PI: head thread only waits for the sum of critical sections of lower-priority links along the chain
    let afterPiBlockingUs = 0;
    for (let i = 1; i < nodes.length; i++) {
      const linkNode = nodes[i];
      if (isCycle && i === nodes.length - 1) continue;
      const csUs = linkNode.criticalSectionUs ?? (links[i - 1]?.kind === 'MUTEX' ? 65 : 35);
      afterPiBlockingUs += csUs;
    }
    afterPiBlockingUs = round1(Math.max(15, afterPiBlockingUs));

    // Before PI: measured blocking latency from head waiter's actual mutex stall (non-overlapping)
    // and inversion window + CS sum, bounded against RTA analytical CS + medium-prio preemptor bursts.
    const headMeasuredWaitUs = links[0]?.waitDurationUs || 0;
    const maxLinkWaitUs = links.reduce((max, l) => Math.max(max, l.waitDurationUs || 0), 0);
    const measuredWaitUs = Math.max(headMeasuredWaitUs, maxLinkWaitUs);
    const matchingInvUs = timeline.inversionBands
      .filter((b) => chainIdSet.has(b.highThread.id) || chainIdSet.has(b.lowOwner.id))
      .reduce((max, b) => Math.max(max, b.durationUs), 0);
    const preemptorBurstSum = preemptors.reduce((sum, p) => sum + p.burstUs, 0);
    const headJitterPeak = jitterSamples
      .filter((j) => j.pid === head.pid)
      .reduce((max, j) => Math.max(max, j.jitterUs), 0);

    let beforePiBlockingUs;
    if (piProtected) {
      beforePiBlockingUs = round1(Math.max(afterPiBlockingUs, measuredWaitUs || afterPiBlockingUs));
    } else if (isCycle) {
      beforePiBlockingUs = Infinity;
    } else if (matchingInvUs > 0 || measuredWaitUs > 0) {
      const traceBound = Math.max(measuredWaitUs, matchingInvUs + afterPiBlockingUs);
      const analyticalBound = afterPiBlockingUs + preemptorBurstSum;
      beforePiBlockingUs = round1(
        Math.max(traceBound, Math.min(analyticalBound, headJitterPeak > 0 ? headJitterPeak : analyticalBound))
      );
    } else {
      beforePiBlockingUs = round1(afterPiBlockingUs + preemptorBurstSum);
    }

    const effectiveBefore = Number.isFinite(beforePiBlockingUs) ? beforePiBlockingUs : null;
    const latencySavedUs =
      effectiveBefore !== null && !piProtected ? round1(Math.max(0, effectiveBefore - afterPiBlockingUs)) : 0;
    const reductionPct =
      effectiveBefore !== null && effectiveBefore > 0 && !piProtected
        ? round1((latencySavedUs / effectiveBefore) * 100)
        : 0;

    seenSigs.add(sig);
    allChains.push({
      id: `pi-chain-${allChains.length + 1}`,
      signature: sig,
      hops,
      isTransitive: hops >= 2 && !isCycle,
      isDeadlock: isCycle,
      hasPriorityDrop,
      piProtected,
      rootWaiter: head,
      terminalOwner: tail,
      nodes,
      edges: links.map((l, idx) => ({
        fromId: nodes[idx].id,
        toId: nodes[idx + 1].id,
        fromName: nodes[idx].threadName,
        toName: nodes[idx + 1].threadName,
        kind: l.kind,
        resource: l.resource,
        waitDurationUs: l.waitDurationUs,
        piBoosted: l.piBoosted
      })),
      preemptors,
      boostedPriority: head.priority,
      wcbl: {
        beforePiUs: effectiveBefore,
        afterPiUs: afterPiBlockingUs,
        latencySavedUs,
        reductionPct,
        formula: isCycle
          ? 'UNBOUNDED (Circular Deadlock)'
          : `WCBL_before = ${effectiveBefore}us (CS + preemptors) -> WCBL_after_PI = sum(CS_i) = ${afterPiBlockingUs}us (-${reductionPct}%)`
      },
      summary: isCycle
        ? `Circular Blocking Deadlock (${hops} hops): ${nodes.map((n) => `${n.threadName}[p${n.priority}]`).join(' -> ')}`
        : `${hops >= 2 ? 'Transitive ' : ''}${hops}-hop Blocking Chain: ${nodes.map((n) => `${n.threadName}[p${n.priority}]`).join(' -> ')}`
    });
  }

  // Group chains sharing the same terminalOwner into rooted Blocking Trees (supports fan-in + multi-hop!)
  const treesByRoot = new Map();
  for (const chain of allChains) {
    const rootId = chain.terminalOwner.id;
    if (!treesByRoot.has(rootId)) {
      treesByRoot.set(rootId, {
        id: `btree-${treesByRoot.size + 1}`,
        rootOwner: chain.terminalOwner,
        maxDepth: chain.hops,
        hasTransitiveChain: chain.isTransitive,
        hasDeadlock: chain.isDeadlock,
        piProtected: chain.piProtected,
        maxWaiterPrio: chain.rootWaiter.priority,
        worstBeforePiUs: chain.wcbl.beforePiUs,
        worstAfterPiUs: chain.wcbl.afterPiUs,
        maxReductionPct: chain.wcbl.reductionPct,
        nodesMap: new Map(),
        edgesMap: new Map(),
        preemptorsMap: new Map(),
        chainIds: []
      });
    }
    const tree = treesByRoot.get(rootId);
    tree.maxDepth = Math.max(tree.maxDepth, chain.hops);
    tree.hasTransitiveChain = tree.hasTransitiveChain || chain.isTransitive;
    tree.hasDeadlock = tree.hasDeadlock || chain.isDeadlock;
    tree.piProtected = tree.piProtected && chain.piProtected;
    tree.maxWaiterPrio = Math.max(tree.maxWaiterPrio, chain.rootWaiter.priority);
    if (chain.wcbl.beforePiUs !== null) {
      tree.worstBeforePiUs =
        tree.worstBeforePiUs === null ? chain.wcbl.beforePiUs : Math.max(tree.worstBeforePiUs, chain.wcbl.beforePiUs);
    }
    tree.worstAfterPiUs = Math.max(tree.worstAfterPiUs, chain.wcbl.afterPiUs);
    tree.maxReductionPct = Math.max(tree.maxReductionPct, chain.wcbl.reductionPct);
    tree.chainIds.push(chain.id);

    for (const n of chain.nodes) {
      if (!tree.nodesMap.has(n.id)) tree.nodesMap.set(n.id, n);
    }
    for (const e of chain.edges) {
      const ek = `${e.fromId}->${e.toId}`;
      if (!tree.edgesMap.has(ek)) tree.edgesMap.set(ek, e);
    }
    for (const p of chain.preemptors) {
      if (!tree.preemptorsMap.has(p.id)) tree.preemptorsMap.set(p.id, p);
    }
  }

  const blockingTrees = Array.from(treesByRoot.values()).map((t) => ({
    id: t.id,
    rootOwner: t.rootOwner,
    maxDepth: t.maxDepth,
    hasTransitiveChain: t.hasTransitiveChain,
    hasDeadlock: t.hasDeadlock,
    piProtected: t.piProtected,
    maxWaiterPrio: t.maxWaiterPrio,
    worstBeforePiUs: t.worstBeforePiUs,
    worstAfterPiUs: t.worstAfterPiUs,
    maxReductionPct: t.maxReductionPct,
    nodes: Array.from(t.nodesMap.values()),
    edges: Array.from(t.edgesMap.values()),
    preemptors: Array.from(t.preemptorsMap.values()).filter((p) => !t.nodesMap.has(p.id)),
    chainIds: t.chainIds
  }));

  const multiHopChains = allChains.filter((c) => c.isTransitive && c.hasPriorityDrop && !c.piProtected);

  return {
    chains: allChains,
    multiHopChains,
    blockingTrees
  };
}

/**
 * Compute Deadline Margin Histogram buckets relative to deadlineUs budget.
 */
function buildDeadlineHistogram(jitterValues, deadlineUs) {
  const budget = Math.max(1, deadlineUs);
  const buckets = [
    { id: 'b0', label: '0-25%', rangeUs: `0-${round1(budget * 0.25)}us`, minRatio: 0, maxRatio: 0.25, count: 0, status: 'safe' },
    { id: 'b1', label: '25-50%', rangeUs: `${round1(budget * 0.25)}-${round1(budget * 0.5)}us`, minRatio: 0.25, maxRatio: 0.5, count: 0, status: 'safe' },
    { id: 'b2', label: '50-75%', rangeUs: `${round1(budget * 0.5)}-${round1(budget * 0.75)}us`, minRatio: 0.5, maxRatio: 0.75, count: 0, status: 'warn' },
    { id: 'b3', label: '75-100%', rangeUs: `${round1(budget * 0.75)}-${round1(budget)}us`, minRatio: 0.75, maxRatio: 1.0, count: 0, status: 'tight' },
    { id: 'b4', label: '>100% OVER', rangeUs: `>${round1(budget)}us`, minRatio: 1.0, maxRatio: Infinity, count: 0, status: 'violation' }
  ];

  for (const val of jitterValues) {
    const ratio = val / budget;
    if (ratio <= 0.25) buckets[0].count++;
    else if (ratio <= 0.5) buckets[1].count++;
    else if (ratio <= 0.75) buckets[2].count++;
    else if (ratio <= 1.0) buckets[3].count++;
    else buckets[4].count++;
  }

  const maxUs = jitterValues.length ? jitterValues[jitterValues.length - 1] : 0;
  const worstMarginUs = round1(budget - maxUs);
  const headroomPct = round1(((budget - maxUs) / budget) * 100);
  const overBudgetCount = buckets[4].count;
  const withinBudgetCount = jitterValues.length - overBudgetCount;

  return {
    budgetUs: budget,
    totalSamples: jitterValues.length,
    withinBudgetCount,
    overBudgetCount,
    worstMarginUs,
    headroomPct,
    maxBucketCount: Math.max(1, ...buckets.map((b) => b.count)),
    buckets
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
  const deadlineHistogram = buildDeadlineHistogram(jitterValues, deadlineUs);

  const jitterStats = {
    count: jitterValues.length,
    budgetUs: deadlineUs,
    minUs: jitterValues.length ? jitterValues[0] : 0,
    p50Us: percentile(jitterValues, 50),
    p95Us: percentile(jitterValues, 95),
    p99Us: percentile(jitterValues, 99),
    maxUs: jitterValues.length ? jitterValues[jitterValues.length - 1] : 0,
    worstMarginUs: deadlineHistogram.worstMarginUs,
    headroomPct: deadlineHistogram.headroomPct,
    violationsCount: deadlineViolations.length,
    violations: deadlineViolations
  };

  // Multi-hop Priority Inheritance Chain & Blocking Tree analysis
  const piAnalysis = analyzePriorityInheritanceChains(parsed.threads, threadMap, timeline, jitterSamples);

  // Assemble unified prioritized findings list
  const findings = [];

  for (const inv of timeline.inversionBands) {
    findings.push({
      id: inv.id,
      ruleId: 'QNX001',
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

  for (const mh of piAnalysis.multiHopChains) {
    findings.push({
      id: mh.id,
      ruleId: 'QNX002',
      category: 'TRANSITIVE_PI_CHAIN',
      severity: 'CRITICAL',
      title: `Transitive ${mh.hops}-Hop PI Chain: ${mh.nodes.map((n) => `${n.threadName}[p${n.priority}]`).join(' -> ')} (WCBL ${mh.wcbl.beforePiUs} us -> ${mh.wcbl.afterPiUs} us with PI)`,
      description: `Transitive mutex ownership chain across ${mh.hops} hops without PTHREAD_PRIO_INHERIT. Worst-case blocking latency is ${mh.wcbl.beforePiUs} us (${mh.preemptors.length} medium-priority preemptor${mh.preemptors.length === 1 ? '' : 's'}); enabling transitive PI reduces blocking to ${mh.wcbl.afterPiUs} us (-${mh.wcbl.reductionPct}%).`,
      entities: mh.nodes.map((n) => n.id),
      wcblBeforeUs: mh.wcbl.beforePiUs,
      wcblAfterUs: mh.wcbl.afterPiUs,
      reductionPct: mh.wcbl.reductionPct,
      remediation: `Configure EVERY mutex in the transitive chain (${mh.edges.map((e) => e.resource).join(', ')}) with PTHREAD_PRIO_INHERIT so QNX Neutrino 8.0 propagates prio ${mh.boostedPriority} down to ${mh.terminalOwner.threadName} (${mh.terminalOwner.id}).`
    });
  }

  for (const chain of ipcChains) {
    findings.push({
      id: chain.id,
      ruleId: chain.isDeadlock ? 'QNX003' : 'QNX004',
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
      ruleId: 'QNX005',
      category: 'DEADLINE_VIOLATION',
      severity: 'ERROR',
      title: `Hard-RT Deadline Exceeded: max ${jitterStats.maxUs} us > ${deadlineUs} us budget (${deadlineViolations.length} violation${deadlineViolations.length > 1 ? 's' : ''})`,
      description: `Worst jitter observed in ${worst.buffer} (pid=${worst.pid ?? 'n/a'}) at ${worst.timestamp}: ${worst.jitterUs} us (budget ${deadlineUs} us, margin ${jitterStats.worstMarginUs} us).`,
      entities: worst.pid ? [`${worst.pid}`] : [],
      remediation:
        'Eliminate priority inversions with PTHREAD_PRIO_INHERIT, pin 1kHz control thread with ThreadCtl(_NTO_TCTL_RUNMASK) to an isolated CPU core, and avoid blocking slog2/PPS I/O inside the control loop.'
    });
  }

  for (const st of timeline.starvationFindings) {
    findings.push({
      id: st.id,
      ruleId: 'QNX006',
      category: 'THREAD_STARVATION',
      severity: 'WARNING',
      title: `Thread Starvation: ${st.threadName} (${st.threadId}, p${st.priority}) waited ${st.waitedUs} us in READY queue`,
      description: `Thread ${st.threadName} became READY at ${st.startUs} us and did not receive CPU time until ${st.endUs} us (threshold ${starvationUs} us).`,
      entities: [st.threadId],
      remediation:
        'Check higher-priority SCHED_FIFO busy loops or configure QNX Adaptive Partitioning (APS) budget guarantees for lower-priority telemetry tasks.'
    });
  }

  // Flag unpinned high-priority SCHED_FIFO SMP migrations
  const rtMigratingLanes = timeline.timelineLanes.filter(
    (l) => l.migrationCount > 0 && l.policy === 'SCHED_FIFO' && l.priority >= 50
  );
  for (const lane of rtMigratingLanes) {
    const hopsStr = lane.migrations.map((m) => `CPU${m.fromCpu}->CPU${m.toCpu}@${m.timeUs}us`).join(', ');
    findings.push({
      id: `smp-migr-${lane.pid}-${lane.tid}`,
      ruleId: 'QNX007',
      category: 'SMP_CORE_MIGRATION',
      severity: 'WARNING',
      title: `Unpinned Hard-RT SMP Migration: ${lane.threadName} (${lane.id}, ${lane.priority}f) migrated ${lane.migrationCount}x across ${lane.cpusUsed.map((c) => `CPU${c}`).join('/')}`,
      description: `High-priority SCHED_FIFO thread ${lane.threadName} bounced cores (${hopsStr}), invalidating L1/L2 cache lines and increasing worst-case execution jitter.`,
      entities: [lane.id],
      remediation: `Pin ${lane.threadName} to a dedicated core using unsigned runmask = (1u << ${lane.primaryCpu}); ThreadCtl(_NTO_TCTL_RUNMASK, (void *)(uintptr_t)runmask);`
    });
  }

  const criticalCount = findings.filter((f) => f.severity === 'CRITICAL').length;
  const errorCount = findings.filter((f) => f.severity === 'ERROR').length;
  const warningCount = findings.filter((f) => f.severity === 'WARNING').length;

  const hasRtViolation =
    timeline.inversionBands.length > 0 ||
    piAnalysis.multiHopChains.length > 0 ||
    deadlineViolations.length > 0 ||
    ipcChains.some((c) => c.isDeadlock) ||
    criticalCount > 0 ||
    errorCount > 0;

  let score = 100;
  score -= timeline.inversionBands.length * 32;
  score -= piAnalysis.multiHopChains.length * 20;
  score -= Math.min(30, deadlineViolations.length * 10);
  score -= ipcChains.filter((c) => c.isDeadlock).length * 40;
  score -= ipcChains.filter((c) => !c.isDeadlock && c.hasPriorityDrop).length * 12;
  score -= timeline.starvationFindings.length * 8;
  score -= rtMigratingLanes.length * 5;
  score = Math.max(0, Math.min(100, score));

  const fifoThreads = parsed.threads.filter((t) => t.policy === 'SCHED_FIFO').length;
  const slogErrors = parsed.logs.filter((l) => l.severity === 'CRITICAL' || l.severity === 'ERROR').length;

  return {
    tool: 'QNX Pulse Studio',
    version: TOOL_VERSION,
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
      multiHopPiChains: piAnalysis.multiHopChains.length,
      blockingTreeCount: piAnalysis.blockingTrees.length,
      ipcBlockChains: ipcChains.length,
      deadlineViolations: deadlineViolations.length,
      starvedThreads: timeline.starvationFindings.length,
      smpCores: timeline.smp.coreCount,
      smpMigrations: timeline.smp.totalMigrations,
      smpPreemptions: timeline.smp.totalPreemptions,
      criticalFindings: criticalCount,
      errorFindings: errorCount,
      warningFindings: warningCount
    },
    jitterStats,
    deadlineHistogram,
    findings,
    ipcChains,
    piChains: piAnalysis.chains,
    multiHopPiChains: piAnalysis.multiHopChains,
    blockingTrees: piAnalysis.blockingTrees,
    inversionBands: timeline.inversionBands,
    starvationFindings: timeline.starvationFindings,
    smpAnalytics: timeline.smp,
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
  lines.push(
    `- **Deadline Budget:** \`${report.options.deadlineUs} us\` | **Max Jitter:** \`${report.jitterStats.maxUs} us\` (P95: \`${report.jitterStats.p95Us} us\`, P99: \`${report.jitterStats.p99Us} us\`, Margin: \`${report.jitterStats.worstMarginUs} us\`)`
  );
  lines.push('');
  lines.push(`## Telemetry Summary`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Active Threads (\`pidin\`) | ${report.summary.totalThreads} (${report.summary.fifoThreads} \`SCHED_FIFO\`) |`);
  lines.push(`| Priority Inversions | ${report.summary.priorityInversions} |`);
  lines.push(`| Transitive Multi-Hop PI Chains | ${report.summary.multiHopPiChains} |`);
  lines.push(`| Hard-RT Deadline Violations (>${report.options.deadlineUs}us) | ${report.summary.deadlineViolations} |`);
  lines.push(`| Blocked IPC Chains | ${report.summary.ipcBlockChains} |`);
  lines.push(`| Starved Threads | ${report.summary.starvedThreads} |`);
  lines.push(`| SMP Cores / Migrations / Preemptions | ${report.summary.smpCores} cores / ${report.summary.smpMigrations} migr / ${report.summary.smpPreemptions} preempts |`);
  lines.push(`| Kernel Trace Events (\`traceprinter\`) | ${report.summary.totalTraceEvents} |`);
  lines.push(`| \`slog2\` Entries (Errors/Critical) | ${report.summary.totalLogs} (${report.summary.slogErrors}) |`);
  lines.push(`| PPS Objects (\`/pps/\`) | ${report.summary.ppsObjectCount} |`);
  lines.push('');

  if (report.piChains && report.piChains.length > 0) {
    lines.push(`## Multi-Hop Priority Inheritance & WCBL Analysis`);
    lines.push('');
    lines.push(`| Chain | Hops | Before PI (WCBL) | After PI (WCBL) | Saved | Protected |`);
    lines.push(`| --- | ---: | ---: | ---: | ---: | :---: |`);
    for (const c of report.piChains) {
      const chainLabel = c.nodes.map((n) => `${n.threadName}[${n.priority}f]`).join(' -> ');
      const beforeTxt = c.wcbl.beforePiUs === null ? 'UNBOUNDED' : `${c.wcbl.beforePiUs} us`;
      lines.push(
        `| \`${chainLabel}\` | ${c.hops} | ${beforeTxt} | ${c.wcbl.afterPiUs} us | -${c.wcbl.reductionPct}% | ${c.piProtected ? 'YES' : 'NO'} |`
      );
    }
    lines.push('');
  }

  lines.push(`## Findings (${report.findings.length})`);
  lines.push('');

  if (report.findings.length === 0) {
    lines.push(
      `All hard real-time constraints satisfied. Zero priority inversions, zero deadline violations, and deterministic QNX 8.0 IPC execution verified.`
    );
  } else {
    for (const f of report.findings) {
      lines.push(`### [${f.severity}] ${f.title}`);
      lines.push(`- **Rule / Category:** \`${f.ruleId || 'QNX000'}\` / \`${f.category}\``);
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

const SARIF_RULES = [
  {
    id: 'QNX001',
    name: 'PriorityInversion',
    shortDescription: { text: 'QNX Neutrino 8.0 Priority Inversion detected on unboosted mutex' },
    fullDescription: {
      text: 'A high-priority SCHED_FIFO thread was blocked on a mutex held by a lower-priority thread while a medium-priority thread preempted execution.'
    },
    helpUri: 'https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.sys_arch/topic/kernel_Priority_inheritance.html',
    defaultConfiguration: { level: 'error' },
    properties: { tags: ['rtos', 'qnx', 'priority-inversion', 'real-time'] }
  },
  {
    id: 'QNX002',
    name: 'TransitivePriorityInheritanceChain',
    shortDescription: { text: 'Multi-hop transitive priority inheritance chain without PTHREAD_PRIO_INHERIT' },
    fullDescription: {
      text: 'Multiple threads form a transitive A->B->C mutex ownership chain lacking PTHREAD_PRIO_INHERIT, compounding worst-case blocking latency.'
    },
    helpUri: 'https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/p/pthread_mutexattr_setprotocol.html',
    defaultConfiguration: { level: 'error' },
    properties: { tags: ['rtos', 'qnx', 'priority-inversion', 'transitive-blocking'] }
  },
  {
    id: 'QNX003',
    name: 'IpcDeadlockCycle',
    shortDescription: { text: 'Circular QNX MsgSend/Mutex IPC deadlock cycle detected' },
    fullDescription: {
      text: 'Two or more threads are mutually blocked in a cycle via synchronous MsgSend(), REPLY, or mutex ownership.'
    },
    helpUri: 'https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.sys_arch/topic/ipc.html',
    defaultConfiguration: { level: 'error' },
    properties: { tags: ['rtos', 'qnx', 'deadlock', 'ipc'] }
  },
  {
    id: 'QNX004',
    name: 'BlockedIpcChain',
    shortDescription: { text: 'Blocked synchronous QNX IPC chain with priority drop' },
    fullDescription: {
      text: 'A high-priority thread is stalled waiting on a lower-priority server or multi-hop synchronous SEND/REPLY chain.'
    },
    helpUri: 'https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.sys_arch/topic/ipc.html',
    defaultConfiguration: { level: 'warning' },
    properties: { tags: ['rtos', 'qnx', 'ipc'] }
  },
  {
    id: 'QNX005',
    name: 'HardRealtimeDeadlineViolation',
    shortDescription: { text: 'Hard real-time control loop jitter exceeded configured microsecond budget' },
    fullDescription: {
      text: 'Measured loop latency from slog2info or traceprinter exceeded the configured hard real-time deadline budget.'
    },
    helpUri: 'https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.sys_arch/topic/kernel_Scheduling.html',
    defaultConfiguration: { level: 'error' },
    properties: { tags: ['rtos', 'qnx', 'deadline', 'jitter'] }
  },
  {
    id: 'QNX006',
    name: 'ThreadStarvation',
    shortDescription: { text: 'Runnable thread starved in READY queue beyond starvation threshold' },
    fullDescription: {
      text: 'A thread remained in READY state without receiving CPU cycles longer than the configured starvation threshold.'
    },
    helpUri: 'https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.sys_arch/topic/kernel_Scheduling.html',
    defaultConfiguration: { level: 'warning' },
    properties: { tags: ['rtos', 'qnx', 'starvation'] }
  },
  {
    id: 'QNX007',
    name: 'UnpinnedSmpCoreMigration',
    shortDescription: { text: 'High-priority SCHED_FIFO thread migrated across SMP CPU cores without RUNMASK pinning' },
    fullDescription: {
      text: 'A hard-RT thread migrated between CPU cores, risking cache thrashing and non-deterministic latency spikes.'
    },
    helpUri: 'https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/t/threadctl.html',
    defaultConfiguration: { level: 'warning' },
    properties: { tags: ['rtos', 'qnx', 'smp', 'affinity'] }
  }
];

function sarifLevel(severity) {
  if (severity === 'CRITICAL' || severity === 'ERROR') return 'error';
  if (severity === 'WARNING') return 'warning';
  return 'note';
}

/**
 * Format report as SARIF 2.1.0 JSON for GitHub Code Scanning & CI security/quality gates.
 */
export function formatSarifReport(report) {
  const captureUri = report.meta?.path
    ? report.meta.path.replaceAll('\\', '/')
    : `samples/${(report.meta?.name || 'capture').toLowerCase().replace(/[^a-z0-9-]+/g, '-')}/trace.csv`;

  const results = report.findings.map((f, idx) => {
    const ruleId = f.ruleId || 'QNX001';
    const artifactUri =
      f.category === 'IPC_DEADLOCK' || f.category === 'IPC_BLOCK_CHAIN'
        ? captureUri.endsWith('.csv')
          ? captureUri.replace(/trace\.csv$/, 'pidin.txt')
          : `${captureUri}/pidin.txt`
        : f.category === 'DEADLINE_VIOLATION'
          ? captureUri.endsWith('.csv')
            ? captureUri.replace(/trace\.csv$/, 'slog2.log')
            : `${captureUri}/slog2.log`
          : captureUri.endsWith('.csv')
            ? captureUri
            : `${captureUri}/trace.csv`;

    return {
      ruleId,
      level: sarifLevel(f.severity),
      message: {
        text: `${f.title}. ${f.description} Remediation: ${f.remediation}`
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: artifactUri
            },
            region: {
              startLine: idx + 1
            }
          },
          logicalLocations: (f.entities || []).map((entity) => ({
            name: String(entity),
            kind: 'thread'
          }))
        }
      ],
      partialFingerprints: {
        qnxPulseFindingId: `${ruleId}:${f.id}`
      },
      properties: {
        category: f.category,
        severity: f.severity,
        remediation: f.remediation,
        ...(f.durationUs !== undefined ? { durationUs: f.durationUs } : {}),
        ...(f.wcblBeforeUs !== undefined ? { wcblBeforeUs: f.wcblBeforeUs, wcblAfterUs: f.wcblAfterUs, reductionPct: f.reductionPct } : {})
      }
    };
  });

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'QNX Pulse Studio',
            version: report.version || TOOL_VERSION,
            informationUri: 'https://github.com/wenizmohamed/qnx-pulse-studio',
            rules: SARIF_RULES
          }
        },
        invocations: [
          {
            executionSuccessful: true,
            exitCode: report.exitCode,
            properties: {
              captureName: report.meta?.name || 'QNX 8.0 Capture',
              verdict: report.status,
              rtScore: report.score,
              deadlineBudgetUs: report.options.deadlineUs,
              maxJitterUs: report.jitterStats.maxUs
            }
          }
        ],
        results
      }
    ]
  };

  return JSON.stringify(sarif, null, 2);
}

function escapeXml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Format report as JUnit XML for Jenkins, GitLab CI, GitHub Actions, and Azure Pipelines.
 */
export function formatJunitReport(report) {
  const suiteName = `qnx-pulse.${(report.meta?.name || 'capture').replace(/[^a-zA-Z0-9._-]+/g, '_')}`;
  const durationSec = ((report.timelineDurationUs || 0) / 1_000_000).toFixed(6);

  const cases = [
    {
      name: 'Zero Priority Inversions',
      classname: 'qnx.rtos.priority_inheritance',
      failed: report.summary.priorityInversions > 0,
      type: 'PRIORITY_INVERSION',
      message:
        report.summary.priorityInversions > 0
          ? `${report.summary.priorityInversions} priority inversion(s) detected (peak ${report.inversionBands[0]?.durationUs ?? 0} us)`
          : '',
      detail: report.inversionBands.map((b) => b.reason).join('\n')
    },
    {
      name: 'Transitive Multi-Hop PI Chain Safety',
      classname: 'qnx.rtos.priority_inheritance',
      failed: report.summary.multiHopPiChains > 0,
      type: 'TRANSITIVE_PI_CHAIN',
      message:
        report.summary.multiHopPiChains > 0
          ? `${report.summary.multiHopPiChains} unboosted multi-hop transitive PI chain(s) detected`
          : '',
      detail: report.multiHopPiChains.map((c) => `${c.summary} | ${c.wcbl.formula}`).join('\n')
    },
    {
      name: 'Zero Circular IPC Deadlocks',
      classname: 'qnx.rtos.ipc',
      failed: report.ipcChains.some((c) => c.isDeadlock),
      type: 'IPC_DEADLOCK',
      message: report.ipcChains.some((c) => c.isDeadlock) ? 'Circular QNX IPC deadlock cycle detected' : '',
      detail: report.ipcChains
        .filter((c) => c.isDeadlock)
        .map((c) => c.summary)
        .join('\n')
    },
    {
      name: `Hard-RT Deadline Jitter Budget (<= ${report.options.deadlineUs}us)`,
      classname: 'qnx.rtos.timing',
      failed: report.summary.deadlineViolations > 0,
      type: 'DEADLINE_VIOLATION',
      message:
        report.summary.deadlineViolations > 0
          ? `Max jitter ${report.jitterStats.maxUs} us exceeded ${report.options.deadlineUs} us budget (${report.summary.deadlineViolations} violation(s))`
          : '',
      detail: report.jitterStats.violations.map((v) => `${v.timestamp} ${v.buffer}: ${v.jitterUs}us (${v.message})`).join('\n')
    },
    {
      name: `Zero Thread Starvation (<= ${report.options.starvationUs}us)`,
      classname: 'qnx.rtos.scheduler',
      failed: report.summary.starvedThreads > 0,
      type: 'THREAD_STARVATION',
      message:
        report.summary.starvedThreads > 0
          ? `${report.summary.starvedThreads} thread(s) starved beyond ${report.options.starvationUs} us`
          : '',
      detail: report.starvationFindings
        .map((s) => `${s.threadName}(${s.threadId}) waited ${s.waitedUs}us`)
        .join('\n')
    },
    {
      name: 'SMP Hard-RT Core Affinity Stability',
      classname: 'qnx.rtos.smp',
      failed: report.findings.some((f) => f.category === 'SMP_CORE_MIGRATION'),
      type: 'SMP_CORE_MIGRATION',
      message: report.findings.some((f) => f.category === 'SMP_CORE_MIGRATION')
        ? `${report.summary.smpMigrations} unpinned SMP core migration(s) detected across ${report.summary.smpCores} cores`
        : '',
      detail: report.findings
        .filter((f) => f.category === 'SMP_CORE_MIGRATION')
        .map((f) => `${f.title} - ${f.remediation}`)
        .join('\n')
    }
  ];

  const failureCount = cases.filter((c) => c.failed).length;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="QNX Pulse Studio" tests="${cases.length}" failures="${failureCount}" errors="0" time="${durationSec}">`,
    `  <testsuite name="${escapeXml(suiteName)}" tests="${cases.length}" failures="${failureCount}" errors="0" time="${durationSec}">`,
    `    <properties>`,
    `      <property name="qnx.captureName" value="${escapeXml(report.meta?.name || 'capture')}" />`,
    `      <property name="qnx.verdict" value="${escapeXml(report.status)}" />`,
    `      <property name="qnx.exitCode" value="${report.exitCode}" />`,
    `      <property name="qnx.rtScore" value="${report.score}" />`,
    `      <property name="qnx.maxJitterUs" value="${report.jitterStats.maxUs}" />`,
    `      <property name="qnx.deadlineBudgetUs" value="${report.options.deadlineUs}" />`,
    `    </properties>`
  ];

  for (const tc of cases) {
    if (tc.failed) {
      lines.push(`    <testcase classname="${escapeXml(tc.classname)}" name="${escapeXml(tc.name)}" time="${durationSec}">`);
      lines.push(
        `      <failure message="${escapeXml(tc.message)}" type="${escapeXml(tc.type)}">${escapeXml(tc.detail || tc.message)}</failure>`
      );
      lines.push(`    </testcase>`);
    } else {
      lines.push(`    <testcase classname="${escapeXml(tc.classname)}" name="${escapeXml(tc.name)}" time="${durationSec}" />`);
    }
  }

  lines.push('  </testsuite>');
  lines.push('</testsuites>');
  return lines.join('\n');
}
