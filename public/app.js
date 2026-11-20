import {
  analyzeCapture,
  formatJsonReport,
  formatJunitReport,
  formatMarkdownReport,
  formatSarifReport
} from './engine/analyzer.js';
import { PRESETS } from './engine/presets.js';

const STATE_COLORS = {
  RUNNING: '#20B276',
  PI_BOOST: '#00A3E8',
  MUTEX: '#E6482E',
  REPLY: '#E59A28',
  SEND: '#E59A28',
  RECEIVE: '#56A8E8',
  READY: '#6C7686',
  SLEEP: '#28303E'
};

const STATE_TEXT_COLORS = {
  RUNNING: '#081711',
  PI_BOOST: '#041724',
  MUTEX: '#FFF6F4',
  REPLY: '#1B1204',
  SEND: '#1B1204',
  RECEIVE: '#081624',
  READY: '#F1F5FA',
  SLEEP: '#94A0B2'
};

const CPU_COLORS = ['#00A3E8', '#20B276', '#E59A28', '#A78BFA'];
const CPU_TEXT_COLORS = ['#041724', '#081711', '#1B1204', '#160B2E'];

const CAPTURE_TITLES = {
  'brake-ecu-inversion': 'Brake ECU Priority Inversion',
  'adas-multihop-pi': 'ADAS Multi-Hop PI Chain (4-Core SMP)',
  'surgical-arm-clean': 'Surgical Arm Fixed PI',
  'qemu-starter': 'QEMU x86_64 Starter Capture',
  custom: 'Custom QNX 8.0 Capture'
};

let currentBundle = PRESETS['brake-ecu-inversion'];
let currentPresetId = 'brake-ecu-inversion';
let currentDeadlineUs = 500;
let currentReport = null;
let activeTab = 'findings';
let smpLaneMode = false;

let scrubUs = 0;
let scrubPlaying = false;
let scrubRafId = null;
let scrubLastFrameTs = 0;
let timelineGeom = { leftPad: 236, plotW: 1024, duration: 1980, rulerH: 26, height: 260 };

const el = (id) => document.getElementById(id);

function cpuColor(cpu) {
  return CPU_COLORS[Math.abs(cpu || 0) % CPU_COLORS.length];
}

function cpuTextColor(cpu) {
  return CPU_TEXT_COLORS[Math.abs(cpu || 0) % CPU_TEXT_COLORS.length];
}

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function extractKernelLabel(targetStr) {
  if (!targetStr) return 'procnto-smp-instr';
  const paren = targetStr.match(/\(([^)]+)\)/);
  return paren ? paren[1] : targetStr;
}

function stopScrubPlayback() {
  scrubPlaying = false;
  if (scrubRafId !== null) {
    cancelAnimationFrame(scrubRafId);
    scrubRafId = null;
  }
  const btn = el('btnScrubPlay');
  const icon = el('scrubPlayIcon');
  const label = el('scrubPlayLabel');
  if (btn && icon && label) {
    btn.classList.remove('is-playing');
    btn.setAttribute('aria-pressed', 'false');
    icon.innerHTML = '&#9654;';
    const dur = Math.max(currentReport?.timelineDurationUs || 1000, 200);
    label.textContent = `Scrub 0->${dur}µs`;
  }
}

function updateScrubVisuals(us, updateStatusbar = false) {
  const duration = timelineGeom.duration || 1000;
  scrubUs = Math.max(0, Math.min(duration, us));

  const slider = el('scrubSlider');
  if (slider) {
    slider.max = String(duration);
    slider.value = String(Math.round(scrubUs));
  }

  const readout = el('scrubTimeReadout');
  if (readout) {
    readout.textContent = `t = ${Math.round(scrubUs)}µs`;
  }

  const x = timelineGeom.leftPad + (scrubUs / duration) * timelineGeom.plotW;
  const cursorLine = el('scrubCursorLine');
  const cursorTag = el('scrubCursorTag');
  const cursorText = el('scrubCursorText');

  if (cursorLine) {
    cursorLine.setAttribute('x1', x.toFixed(1));
    cursorLine.setAttribute('x2', x.toFixed(1));
  }
  if (cursorTag && cursorText) {
    const tagW = 56;
    const clampedX = Math.max(
      timelineGeom.leftPad + 2,
      Math.min(timelineGeom.leftPad + timelineGeom.plotW - tagW, x - tagW / 2)
    );
    cursorTag.setAttribute('x', clampedX.toFixed(1));
    cursorText.setAttribute('x', (clampedX + tagW / 2).toFixed(1));
    cursorText.textContent = `${Math.round(scrubUs)}µs`;
  }

  if (updateStatusbar && currentReport) {
    const activeStates = [];
    for (const lane of currentReport.timelineLanes) {
      const hit = lane.segments.find((s) => scrubUs >= s.startUs && scrubUs <= s.endUs);
      if (hit) {
        activeStates.push(`${lane.threadName}[${hit.state}@CPU${hit.cpu}]`);
      }
    }
    const inInv = currentReport.inversionBands.find((b) => scrubUs >= b.startUs && scrubUs <= b.endUs);
    const invPrefix = inInv ? `INVERSION WINDOW (${inInv.durationUs}µs) | ` : '';
    const summaryText = activeStates.length
      ? `${invPrefix}@ ${Math.round(scrubUs)}µs: ${activeStates.slice(0, 4).join(' · ')}`
      : `@ ${Math.round(scrubUs)}µs: idle / between trace markers`;

    const inspector = el('timelineInspector');
    if (inspector) {
      inspector.innerHTML = `<span class="statusbar-text">${escapeHtml(summaryText)}</span><span class="status-right">clock: SYSPAGE(qtime) · traceprinter</span>`;
    }
  }
}

function startScrubPlayback() {
  if (!currentReport) return;
  const duration = Math.max(currentReport.timelineDurationUs || 1000, 200);
  if (scrubUs >= duration - 10) {
    scrubUs = 0;
  }
  scrubPlaying = true;
  scrubLastFrameTs = performance.now();

  const btn = el('btnScrubPlay');
  const icon = el('scrubPlayIcon');
  const label = el('scrubPlayLabel');
  if (btn && icon && label) {
    btn.classList.add('is-playing');
    btn.setAttribute('aria-pressed', 'true');
    icon.innerHTML = '&#10074;&#10074;';
    label.textContent = 'Pause scrub';
  }

  const sweepDurationMs = 4200;
  const step = (now) => {
    if (!scrubPlaying) return;
    const dt = now - scrubLastFrameTs;
    scrubLastFrameTs = now;
    const nextUs = scrubUs + (dt / sweepDurationMs) * duration;
    if (nextUs >= duration) {
      updateScrubVisuals(duration, true);
      stopScrubPlayback();
      return;
    }
    updateScrubVisuals(nextUs, true);
    scrubRafId = requestAnimationFrame(step);
  };
  scrubRafId = requestAnimationFrame(step);
}

function renderSummary(report) {
  const isPass = report.status === 'PASS';

  const badge = el('verdictBadge');
  badge.className = isPass ? 'status-pill status-pass' : 'status-pill status-fail';
  badge.textContent = isPass ? 'PASS exit 0' : `FAIL exit ${report.exitCode}`;

  const brandLed = el('brandLed');
  if (brandLed) brandLed.className = isPass ? 'brand-dot is-pass' : 'brand-dot';

  const stageLed = el('stageLed');
  if (stageLed) stageLed.className = isPass ? 'stage-led is-pass' : 'stage-led';

  const heading = el('captureHeading');
  if (heading) {
    heading.textContent = CAPTURE_TITLES[currentPresetId] || report.meta?.name || 'QNX 8.0 Capture';
  }

  el('capThreads').textContent = `${report.summary.totalThreads} Threads (${report.summary.fifoThreads} FIFO)`;

  const capInv = el('capInversions');
  if (report.summary.multiHopPiChains > 0) {
    const worstWcbl = report.multiHopPiChains[0]?.wcbl;
    capInv.textContent = `${report.summary.multiHopPiChains} Multi-Hop PI (${worstWcbl?.beforePiUs ?? 0}µs)`;
    capInv.className = 'metric-capsule capsule-signal';
  } else if (report.summary.priorityInversions > 0) {
    const peakUs = report.inversionBands[0]?.durationUs ?? 0;
    capInv.textContent = `${report.summary.priorityInversions} Inversion (${peakUs}µs)`;
    capInv.className = 'metric-capsule capsule-signal';
  } else {
    capInv.textContent = '0 Inversions (Clean PI)';
    capInv.className = 'metric-capsule capsule-emerald';
  }

  el('capContention').textContent = `${report.summary.ipcBlockChains} Blocked IPC · ${report.summary.smpMigrations} Migr · ${report.summary.smpPreemptions} Preempts`;
  el('capKernel').textContent = extractKernelLabel(report.meta?.target);

  const targetClock = el('targetClockMeta');
  if (targetClock) {
    targetClock.textContent = `${report.meta?.target || 'x86_64-neutrino-8.0'} · ${report.summary.smpCores} SMP Cores`;
  }

  const numJitter = el('numMaxJitter');
  numJitter.textContent = `${report.jitterStats.maxUs}µs`;
  numJitter.className = `numeral-value ${report.jitterStats.maxUs > report.options.deadlineUs ? 'is-bad' : 'is-ok'}`;

  const numBudget = el('numBudget');
  numBudget.textContent = `${report.options.deadlineUs}µs`;

  const numGate = el('numCiGate');
  numGate.textContent = isPass ? 'exit 0' : `exit ${report.exitCode}`;
  numGate.className = `numeral-value ${isPass ? 'is-ok' : 'is-bad'}`;

  const compareBtn = el('btnComparePi');
  if (compareBtn) {
    if (currentPresetId === 'surgical-arm-clean') {
      compareBtn.classList.add('is-clean');
      compareBtn.textContent = 'Compare: Before PI Fix (1842µs)';
    } else {
      compareBtn.classList.remove('is-clean');
      compareBtn.textContent = 'Compare Before vs After PI Fix';
    }
  }
}

function renderSvgTimeline(report) {
  const svg = el('timelineSvg');
  const lanes = report.timelineLanes;
  const duration = Math.max(report.timelineDurationUs || 1000, 200);

  const width = 1280;
  const leftPad = 236;
  const rightPad = 20;
  const rulerH = 26;
  const bannerH = report.inversionBands.length > 0 ? 18 : 6;
  const topPad = rulerH + bannerH;
  const laneH = 38;
  const bottomPad = 10;
  const plotW = width - leftPad - rightPad;
  const height = Math.max(216, topPad + lanes.length * laneH + bottomPad);

  timelineGeom = { leftPad, plotW, duration, rulerH, height };

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  el('timelineMeta').textContent = `${lanes.length} lanes · ${duration}µs · ${report.summary.smpCores} CPU · ${report.summary.smpMigrations}M/${report.summary.smpPreemptions}P`;

  const xOf = (us) => leftPad + (Math.max(0, Math.min(duration, us)) / duration) * plotW;
  const yOfLane = (idx) => topPad + idx * laneH;

  const laneIndex = new Map();
  lanes.forEach((l, i) => laneIndex.set(l.id, i));

  let markup = `
    <defs>
      <pattern id="invHatch" width="8" height="8" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
        <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(230,72,46,0.28)" stroke-width="1.6" />
      </pattern>
      <marker id="arrowSend" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
        <path d="M 0 1 L 8 4 L 0 7 z" fill="#E59A28" />
      </marker>
      <marker id="arrowReply" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
        <path d="M 0 1 L 8 4 L 0 7 z" fill="#20B276" />
      </marker>
      <marker id="arrowPulse" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
        <path d="M 0 1 L 8 4 L 0 7 z" fill="#00A3E8" />
      </marker>
    </defs>

    <!-- Deep Obsidian Oscilloscope Surface & Track Gutter -->
    <rect x="0" y="0" width="${width}" height="${height}" fill="#111419" />
    <rect x="0" y="0" width="${leftPad}" height="${height}" fill="#161A22" />
    <rect x="0" y="0" width="${width}" height="${rulerH}" fill="#161A22" />
    <line x1="0" y1="${rulerH}" x2="${width}" y2="${rulerH}" stroke="#262D3B" stroke-width="1" />
    <line x1="${leftPad}" y1="0" x2="${leftPad}" y2="${height}" stroke="#262D3B" stroke-width="1" />
    <text x="10" y="17" fill="#8D98A9" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">PRIO CPU  THREAD (PID:TID)</text>
  `;

  // Vertical hairline gridlines & ruler ticks in us
  const tickCount = 10;
  for (let i = 0; i <= tickCount; i++) {
    const us = Math.round((duration / tickCount) * i);
    const x = xOf(us);
    const anchor = i === 0 ? 'start' : i === tickCount ? 'end' : 'middle';
    const labelX = i === 0 ? x + 3 : i === tickCount ? x - 3 : x;

    markup += `<line x1="${x.toFixed(1)}" y1="${rulerH}" x2="${x.toFixed(1)}" y2="${height - bottomPad}" stroke="#1E2430" stroke-width="1" />`;
    markup += `<line x1="${x.toFixed(1)}" y1="${rulerH - 5}" x2="${x.toFixed(1)}" y2="${rulerH}" stroke="#444F63" stroke-width="1" />`;
    markup += `<text x="${labelX.toFixed(1)}" y="${rulerH - 9}" fill="#8D98A9" font-family="JetBrains Mono, monospace" font-size="10" text-anchor="${anchor}">${us}µs</text>`;
  }

  // Priority Inversion vertical band
  for (const inv of report.inversionBands) {
    const x1 = xOf(inv.startUs);
    const x2 = xOf(inv.endUs);
    const w = Math.max(4, x2 - x1);
    const bandH = lanes.length * laneH;
    const labelW = Math.min(Math.max(w, 270), 360);
    const hopTag = inv.isTransitive ? `${inv.hops}-HOP ` : '';
    const tip = escapeHtml(
      `${hopTag}PRIORITY INVERSION (${inv.durationUs}µs): ${inv.highThread.name}[${inv.highThread.prio}f] blocked on ${inv.lowOwner.name}[${inv.lowOwner.prio}f] while ${inv.mediumThread.name}[${inv.mediumThread.prio}f] ran on CPU${inv.cpu}`
    );
    markup += `
      <g class="svg-hit" data-tip="${tip}" style="cursor:pointer;">
        <rect x="${x1.toFixed(1)}" y="${topPad}" width="${w.toFixed(1)}" height="${bandH}" fill="rgba(230,72,46,0.12)" />
        <rect x="${x1.toFixed(1)}" y="${topPad}" width="${w.toFixed(1)}" height="${bandH}" fill="url(#invHatch)" />
        <line x1="${x1.toFixed(1)}" y1="${rulerH}" x2="${x1.toFixed(1)}" y2="${topPad + bandH}" stroke="#E6482E" stroke-width="1.2" stroke-dasharray="3 2" />
        <line x1="${x2.toFixed(1)}" y1="${rulerH}" x2="${x2.toFixed(1)}" y2="${topPad + bandH}" stroke="#E6482E" stroke-width="1.2" stroke-dasharray="3 2" />
        <rect x="${x1.toFixed(1)}" y="${rulerH + 1}" width="${labelW.toFixed(1)}" height="16" rx="3" fill="#461A15" stroke="#E6482E" stroke-width="0.9" />
        <text x="${(x1 + 7).toFixed(1)}" y="${rulerH + 12}" fill="#FFA494" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="700">${hopTag}INVERSION ${inv.durationUs}µs (p${inv.highThread.prio} stalled by p${inv.mediumThread.prio})</text>
      </g>
    `;
  }

  // Thread lanes and execution segments
  lanes.forEach((lane, idx) => {
    const y = yOfLane(idx);
    const midY = y + laneH / 2;

    if (idx % 2 === 1) {
      markup += `<rect x="${leftPad + 1}" y="${y}" width="${width - leftPad - 1}" height="${laneH}" fill="rgba(255,255,255,0.015)" />`;
    }
    markup += `<line x1="0" y1="${y + laneH}" x2="${width}" y2="${y + laneH}" stroke="#202633" stroke-width="1" />`;

    // Left track header with Priority pill + SMP CPU Core badge + thread name + preemption/migration counters
    const prioBorder = lane.priority >= 55 ? '#00A3E8' : lane.priority >= 35 ? '#E59A28' : '#4C566A';
    const prioText = lane.priority >= 55 ? '#7DD8FF' : lane.priority >= 35 ? '#F3BE63' : '#9AA4B5';
    const cColor = cpuColor(lane.primaryCpu);
    const cText = cpuTextColor(lane.primaryCpu);
    const subMeta =
      lane.migrationCount > 0
        ? `${lane.pid}:${lane.tid} · M:${lane.migrationCount} P:${lane.preemptionCount}`
        : `${lane.pid}:${lane.tid}${lane.preemptionCount > 0 ? ` · P:${lane.preemptionCount}` : ''}`;
    const laneTip = escapeHtml(
      `${lane.threadName} (${lane.id}, ${lane.priority}f ${lane.policy}) | Primary CPU${lane.primaryCpu} | Cores: ${lane.cpusUsed.map((c) => `CPU${c}`).join(',')} | Migrations: ${lane.migrationCount} | Preemptions: ${lane.preemptionCount}`
    );

    markup += `
      <g class="svg-hit" data-tip="${laneTip}" style="cursor:pointer;">
        <rect x="8" y="${y + 9}" width="32" height="19" rx="5" fill="#111419" stroke="${prioBorder}" stroke-width="1" />
        <text x="24" y="${y + 22}" fill="${prioText}" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="700" text-anchor="middle">${lane.priority}f</text>
        <rect x="44" y="${y + 9}" width="34" height="19" rx="5" fill="${cColor}" fill-opacity="0.22" stroke="${cColor}" stroke-width="1" />
        <text x="61" y="${y + 22}" fill="${cColor}" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700" text-anchor="middle">C${lane.primaryCpu}${lane.migrationCount > 0 ? '*' : ''}</text>
        <text x="84" y="${y + 16.5}" fill="#EFF3F8" font-family="JetBrains Mono, monospace" font-size="10.5" font-weight="600">${escapeHtml(lane.threadName.slice(0, 17))}</text>
        <text x="84" y="${y + 29}" fill="${lane.migrationCount > 0 ? '#F3BE63' : '#7D8798'}" font-family="JetBrains Mono, monospace" font-size="9">${escapeHtml(subMeta)}</text>
      </g>
    `;

    // Execution bars (Thread State mode OR SMP Core Affinity color mode)
    for (const seg of lane.segments) {
      const sx = xOf(seg.startUs);
      const ex = xOf(seg.endUs);
      const sw = Math.max(2.5, ex - sx);
      const isRunSeg = seg.state === 'RUNNING' || seg.state === 'PI_BOOST';
      const fill = smpLaneMode && isRunSeg ? cpuColor(seg.cpu) : STATE_COLORS[seg.state] || '#6C7686';
      const txtColor = smpLaneMode && isRunSeg ? cpuTextColor(seg.cpu) : STATE_TEXT_COLORS[seg.state] || '#EFF3F8';
      const tip = escapeHtml(
        `${lane.threadName} (${lane.id}, ${seg.prio}f) | ${seg.state} | ${seg.startUs}µs..${seg.endUs}µs (${seg.durationUs}µs) | CPU${seg.cpu}${seg.detail ? ' | ' + seg.detail : ''}`
      );
      const barH = 20;
      const barY = midY - barH / 2;
      const label = smpLaneMode && isRunSeg ? `CPU${seg.cpu} ${seg.durationUs}µs` : `${seg.state} ${seg.durationUs}µs`;
      const fitsFull = sw > label.length * 6.0 + 10;
      const fitsShort = !fitsFull && sw > 36;
      const cpuStripe = isRunSeg ? cpuColor(seg.cpu) : null;

      markup += `
        <g class="svg-hit" data-tip="${tip}" style="cursor:pointer;">
          <rect x="${sx.toFixed(1)}" y="${barY.toFixed(1)}" width="${sw.toFixed(1)}" height="${barH}" rx="3" fill="${fill}" stroke="#111419" stroke-width="0.9" />
          ${
            !smpLaneMode && cpuStripe && sw >= 6
              ? `<rect x="${(sx + 1).toFixed(1)}" y="${(barY + barH - 3.2).toFixed(1)}" width="${Math.max(2, sw - 2).toFixed(1)}" height="2.6" rx="1" fill="${cpuStripe}" />`
              : ''
          }
          ${
            fitsFull
              ? `<text x="${(sx + 6).toFixed(1)}" y="${(midY + 3).toFixed(1)}" fill="${txtColor}" font-family="JetBrains Mono, monospace" font-size="9.2" font-weight="700">${escapeHtml(label)}</text>`
              : fitsShort
                ? `<text x="${(sx + 5).toFixed(1)}" y="${(midY + 3).toFixed(1)}" fill="${txtColor}" font-family="JetBrains Mono, monospace" font-size="8.8" font-weight="700">${smpLaneMode && isRunSeg ? `C${seg.cpu}` : `${seg.durationUs}µs`}</text>`
                : ''
          }
        </g>
      `;
    }

    // SMP CPU-Core Migration diamond markers on this lane
    for (const migr of lane.migrations || []) {
      const mx = xOf(migr.timeUs);
      const my = midY;
      const toCol = cpuColor(migr.toCpu);
      const tip = escapeHtml(
        `SMP CORE MIGRATION @ ${migr.timeUs}µs | ${migr.threadName} (${migr.priority}f) migrated CPU${migr.fromCpu} -> CPU${migr.toCpu} | Fix: ThreadCtl(_NTO_TCTL_RUNMASK)`
      );
      markup += `
        <g class="svg-hit" data-tip="${tip}" style="cursor:pointer;">
          <polygon points="${mx.toFixed(1)},${(my - 8).toFixed(1)} ${(mx + 6.5).toFixed(1)},${my.toFixed(1)} ${mx.toFixed(1)},${(my + 8).toFixed(1)} ${(mx - 6.5).toFixed(1)},${my.toFixed(1)}" fill="${toCol}" stroke="#111419" stroke-width="1.3" />
          <text x="${(mx + 8).toFixed(1)}" y="${(my - 6).toFixed(1)}" fill="#F3BE63" font-family="JetBrains Mono, monospace" font-size="8.2" font-weight="700">C${migr.fromCpu}→C${migr.toCpu}</text>
        </g>
      `;
    }
  });

  // Directed IPC arrows
  for (const edge of report.ipcEdges) {
    const fromIdx = laneIndex.get(edge.fromId);
    const toIdx = laneIndex.get(edge.toId);
    if (fromIdx === undefined || toIdx === undefined) continue;

    const x = xOf(edge.timeUs);
    const y1 = yOfLane(fromIdx) + laneH / 2;
    const y2 = yOfLane(toIdx) + laneH / 2;
    const stroke = edge.kind === 'PULSE' ? '#00A3E8' : edge.kind === 'REPLY' ? '#20B276' : '#E59A28';
    const marker = edge.kind === 'PULSE' ? 'url(#arrowPulse)' : edge.kind === 'REPLY' ? 'url(#arrowReply)' : 'url(#arrowSend)';
    const dash = edge.kind === 'PULSE' ? '3 2' : '';
    const tip = escapeHtml(
      `IPC ${edge.kind} @ ${edge.timeUs}µs | ${edge.fromName} (${edge.fromId}) -> ${edge.toName} (${edge.toId})${edge.detail ? ' | ' + edge.detail : ''}`
    );

    markup += `
      <g class="svg-hit" data-tip="${tip}" style="cursor:pointer;">
        <line x1="${x.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="1.6" ${dash ? `stroke-dasharray="${dash}"` : ''} marker-end="${marker}" />
        <circle cx="${x.toFixed(1)}" cy="${y1.toFixed(1)}" r="2.4" fill="${stroke}" />
      </g>
    `;
  }

  // Live Microsecond Scrub Playhead Cursor
  const initCursorUs =
    report.inversionBands.length > 0
      ? Math.round((report.inversionBands[0].startUs + report.inversionBands[0].endUs) / 2)
      : Math.round(duration * 0.25);
  scrubUs = Math.min(duration, initCursorUs);
  const cx = xOf(scrubUs);
  const tagW = 56;
  const clampedTagX = Math.max(leftPad + 2, Math.min(leftPad + plotW - tagW, cx - tagW / 2));

  markup += `
    <g id="scrubCursorGroup" pointer-events="none">
      <line id="scrubCursorLine" x1="${cx.toFixed(1)}" y1="${rulerH}" x2="${cx.toFixed(1)}" y2="${height - bottomPad}" stroke="#00B8FF" stroke-width="1.6" />
      <rect id="scrubCursorTag" x="${clampedTagX.toFixed(1)}" y="4" width="${tagW}" height="17" rx="8.5" fill="#0086C9" stroke="#5CD0FF" stroke-width="0.9" />
      <text id="scrubCursorText" x="${(clampedTagX + tagW / 2).toFixed(1)}" y="15.5" fill="#FFFFFF" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="700" text-anchor="middle">${scrubUs}µs</text>
    </g>
  `;

  svg.innerHTML = markup;

  const inspector = el('timelineInspector');
  svg.querySelectorAll('.svg-hit').forEach((node) => {
    const show = () => {
      inspector.innerHTML = `<span class="statusbar-text">${node.getAttribute('data-tip')}</span><span class="status-right">clock: SYSPAGE(qtime) · traceprinter</span>`;
    };
    node.addEventListener('mouseenter', show);
    node.addEventListener('click', show);
  });

  stopScrubPlayback();
  updateScrubVisuals(scrubUs, false);
}

/**
 * Interactive Multi-Hop Priority Inheritance Chain & Blocking Tree SVG Diagram + WCBL Panel
 */
function renderPiBlockingTree(report) {
  const chains = report.piChains || [];
  const trees = report.blockingTrees || [];
  const tabBtn = el('tabPiTree');
  if (tabBtn) {
    tabBtn.textContent = `PI Blocking Tree (${chains.length})`;
  }

  const svg = el('piTreeSvg');
  const titleEl = el('piDiagramTitle');
  const badgeEl = el('piDiagramBadge');
  const inspEl = el('piTreeInspector');
  const wcblEl = el('piWcblSummary');
  const listEl = el('piChainList');

  if (!trees.length) {
    titleEl.textContent = 'Verified Zero-Blocking Topology (PTHREAD_PRIO_INHERIT)';
    badgeEl.className = 'tag tag-PASS';
    badgeEl.textContent = 'CLEAN PI';
    svg.setAttribute('viewBox', '0 0 920 210');
    svg.innerHTML = `
      <rect x="0" y="0" width="920" height="210" fill="#111419" />
      <rect x="28" y="34" width="864" height="142" rx="14" fill="#161A22" stroke="#20B276" stroke-width="1.2" stroke-dasharray="5 4" />
      <text x="460" y="92" fill="#22C07E" font-family="JetBrains Mono, monospace" font-size="14" font-weight="700" text-anchor="middle">ZERO UNBOOSTED PRIORITY INHERITANCE CHAINS DETECTED</text>
      <text x="460" y="120" fill="#9AA4B5" font-family="JetBrains Mono, monospace" font-size="11.5" text-anchor="middle">All mutex contention windows resolved via QNX 8.0 PTHREAD_PRIO_INHERIT priority boost (max jitter ${report.jitterStats.maxUs}µs).</text>
    `;
    wcblEl.innerHTML = `
      <div class="wcbl-metric-box">
        <div class="wcbl-bar-head"><span>Observed Contention Latency</span><span class="col-ok">${report.jitterStats.maxUs}µs</span></div>
        <div class="wcbl-track"><div class="wcbl-fill wcbl-fill-good" style="width:${Math.min(100, Math.round((report.jitterStats.maxUs / Math.max(1, report.options.deadlineUs)) * 100))}%"></div></div>
        <span class="wcbl-delta-pill">PASS · Within ${report.options.deadlineUs}µs Hard-RT Budget</span>
      </div>
    `;
    listEl.innerHTML = `<div class="wcbl-chain-item"><div class="wcbl-chain-path">No unboosted blocking chains active in this capture.</div><div class="wcbl-chain-meta">Switch to adas-multihop-pi.cap or brake-ecu-inversion.cap to inspect transitive A->B->C blocking trees.</div></div>`;
    return;
  }

  // Pick the primary (deepest / worst WCBL) blocking tree for the main interactive SVG diagram
  const primary = [...trees].sort(
    (a, b) =>
      Number(b.hasDeadlock) - Number(a.hasDeadlock) ||
      b.maxDepth - a.maxDepth ||
      (b.worstBeforePiUs || 0) - (a.worstBeforePiUs || 0)
  )[0];

  const isMultiHop = primary.maxDepth >= 2;
  titleEl.textContent = primary.hasDeadlock
    ? `Circular Blocking Deadlock (${primary.maxDepth}-Hop Cycle)`
    : isMultiHop
      ? `Transitive ${primary.maxDepth}-Hop Blocking Tree -> ${primary.rootOwner.threadName}[${primary.rootOwner.priority}f]`
      : `Priority Inheritance Blocking Graph -> ${primary.rootOwner.threadName}[${primary.rootOwner.priority}f]`;

  if (primary.hasDeadlock) {
    badgeEl.className = 'tag tag-CRITICAL';
    badgeEl.textContent = 'DEADLOCK CYCLE';
  } else if (primary.piProtected) {
    badgeEl.className = 'tag tag-PASS';
    badgeEl.textContent = 'PI PROTECTED';
  } else if (isMultiHop) {
    badgeEl.className = 'tag tag-CRITICAL';
    badgeEl.textContent = `${primary.maxDepth}-HOP TRANSITIVE`;
  } else {
    badgeEl.className = 'tag tag-ERROR';
    badgeEl.textContent = 'UNBOOSTED MUTEX';
  }

  // Compute topological column depth (distance from terminal root owner: root at rightmost column)
  const depthFromRoot = new Map([[primary.rootOwner.id, 0]]);
  for (let pass = 0; pass < primary.nodes.length + 2; pass++) {
    for (const e of primary.edges) {
      if (depthFromRoot.has(e.toId)) {
        const nextD = depthFromRoot.get(e.toId) + 1;
        if (!depthFromRoot.has(e.fromId) || nextD > depthFromRoot.get(e.fromId)) {
          depthFromRoot.set(e.fromId, nextD);
        }
      }
    }
  }
  const maxCol = Math.max(1, ...Array.from(depthFromRoot.values()));
  const colGroups = new Map();
  for (const n of primary.nodes) {
    const d = depthFromRoot.get(n.id) ?? 0;
    const colIdx = maxCol - d; // Waiters on left (0), root owner on right (maxCol)
    if (!colGroups.has(colIdx)) colGroups.set(colIdx, []);
    colGroups.get(colIdx).push(n);
  }
  for (const arr of colGroups.values()) {
    arr.sort((a, b) => b.priority - a.priority);
  }

  const maxRows = Math.max(1, ...Array.from(colGroups.values()).map((a) => a.length));
  const width = 920;
  const nodeW = 196;
  const nodeH = 62;
  const preemptorRowH = primary.preemptors.length > 0 ? 64 : 18;
  const topOffset = 46;
  const rowGap = 24;
  const height = Math.max(248, topOffset + maxRows * (nodeH + rowGap) + preemptorRowH + 22);

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const padX = 34;
  const usableW = width - padX * 2 - nodeW;
  const colCount = maxCol + 1;
  const posById = new Map();

  for (let c = 0; c < colCount; c++) {
    const group = colGroups.get(c) || [];
    const x = colCount === 1 ? width / 2 - nodeW / 2 : padX + (c / (colCount - 1)) * usableW;
    const totalGroupH = group.length * nodeH + Math.max(0, group.length - 1) * rowGap;
    const startY = topOffset + (maxRows * (nodeH + rowGap) - rowGap - totalGroupH) / 2;
    group.forEach((n, rIdx) => {
      posById.set(n.id, { x, y: startY + rIdx * (nodeH + rowGap), node: n });
    });
  }

  let markup = `
    <defs>
      <marker id="piWaitArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="#E6482E" />
      </marker>
      <marker id="piBoostArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="#00A8F3" />
      </marker>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" fill="#111419" />
    <text x="18" y="24" fill="#8D98A9" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700">BLOCKING DIRECTION (WAITER -> MUTEX/IPC OWNER)   ·   CYAN ARC = TRANSITIVE PTHREAD_PRIO_INHERIT BOOST</text>
  `;

  // Draw blocking edges (solid crimson/amber arrows)
  for (const edge of primary.edges) {
    const fromP = posById.get(edge.fromId);
    const toP = posById.get(edge.toId);
    if (!fromP || !toP) continue;
    const x1 = fromP.x + nodeW;
    const y1 = fromP.y + nodeH / 2;
    const x2 = toP.x - 4;
    const y2 = toP.y + nodeH / 2;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const stroke = edge.piBoosted ? '#20B276' : '#E6482E';
    const label = `${edge.resource || edge.kind}${edge.waitDurationUs ? ` (${edge.waitDurationUs}µs)` : ''}`;
    const edgeTip = escapeHtml(
      `EDGE: ${edge.fromName} blocks on ${edge.kind} "${edge.resource || 'mutex'}" held by ${edge.toName}${edge.waitDurationUs ? ` for ${edge.waitDurationUs}µs` : ''} | Fix: pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_INHERIT)`
    );
    const pillW = Math.min(144, Math.max(76, label.length * 6.2 + 12));

    markup += `
      <g class="pi-hit" data-tip="${edgeTip}" style="cursor:pointer;">
        <path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + 36).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - 36).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="2.2" marker-end="url(#piWaitArrow)" />
        <rect x="${(mx - pillW / 2).toFixed(1)}" y="${(my - 11).toFixed(1)}" width="${pillW.toFixed(1)}" height="19" rx="9.5" fill="#1D222D" stroke="${stroke}" stroke-width="1" />
        <text x="${mx.toFixed(1)}" y="${(my + 2).toFixed(1)}" fill="#F4F7FB" font-family="JetBrains Mono, monospace" font-size="9" font-weight="600" text-anchor="middle">${escapeHtml(label.slice(0, 22))}</text>
      </g>
    `;
  }

  // Draw transitive PI boost arc from highest waiter to terminal root owner
  const rootPos = posById.get(primary.rootOwner.id);
  const topWaiter = primary.nodes.reduce((best, n) => (n.priority > best.priority ? n : best), primary.nodes[0]);
  const topPos = posById.get(topWaiter.id);
  if (rootPos && topPos && rootPos.node.id !== topPos.node.id && !primary.hasDeadlock) {
    const ax1 = topPos.x + nodeW / 2;
    const ay1 = topPos.y;
    const ax2 = rootPos.x + nodeW / 2;
    const ay2 = rootPos.y;
    const ctrlY = Math.max(28, Math.min(ay1, ay2) - 24);
    const boostTip = escapeHtml(
      `TRANSITIVE PI BOOST: PTHREAD_PRIO_INHERIT elevates ${primary.rootOwner.threadName} from ${primary.rootOwner.priority}f -> ${primary.maxWaiterPrio}f across ${primary.maxDepth} hop(s), cutting WCBL from ${primary.worstBeforePiUs}µs to ${primary.worstAfterPiUs}µs (-${primary.maxReductionPct}%)`
    );
    markup += `
      <g class="pi-hit" data-tip="${boostTip}" style="cursor:pointer;">
        <path d="M ${ax1.toFixed(1)} ${ay1.toFixed(1)} Q ${((ax1 + ax2) / 2).toFixed(1)} ${ctrlY.toFixed(1)} ${ax2.toFixed(1)} ${(ay2 - 4).toFixed(1)}" fill="none" stroke="#00A8F3" stroke-width="1.8" stroke-dasharray="5 3" marker-end="url(#piBoostArrow)" />
        <text x="${((ax1 + ax2) / 2).toFixed(1)}" y="${(ctrlY + 5).toFixed(1)}" fill="#7DD8FF" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="700" text-anchor="middle">PI BOOST: ${primary.rootOwner.priority}f → ${primary.maxWaiterPrio}f (-${primary.maxReductionPct}% WCBL)</text>
      </g>
    `;
  }

  // Draw thread nodes
  for (const { x, y, node } of posById.values()) {
    const isRoot = node.id === primary.rootOwner.id;
    const border = isRoot ? '#E6482E' : node.priority >= 55 ? '#00A8F3' : '#E59A28';
    const roleTag = isRoot ? 'TERMINAL OWNER' : depthFromRoot.get(node.id) === maxCol ? 'HIGH WAITER' : 'INTERMEDIATE';
    const cCol = cpuColor(node.cpu);
    const tip = escapeHtml(
      `NODE ${node.threadName} (${node.id}) | ${node.priority}f ${node.policy} | State: ${node.state} | CPU${node.cpu}${node.criticalSectionUs ? ` | CS hold: ${node.criticalSectionUs}µs` : ''} | ${isRoot ? `Needs boost to ${primary.maxWaiterPrio}f via PTHREAD_PRIO_INHERIT` : 'Blocked on lower-priority link'}`
    );

    markup += `
      <g class="pi-hit" data-tip="${tip}" style="cursor:pointer;">
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${nodeW}" height="${nodeH}" rx="12" fill="#181D27" stroke="${border}" stroke-width="1.6" />
        <rect x="${(x + 10).toFixed(1)}" y="${(y + 10).toFixed(1)}" width="36" height="19" rx="5" fill="${border}" fill-opacity="0.2" stroke="${border}" stroke-width="0.9" />
        <text x="${(x + 28).toFixed(1)}" y="${(y + 23).toFixed(1)}" fill="#FFFFFF" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700" text-anchor="middle">${node.priority}f</text>
        <rect x="${(x + 52).toFixed(1)}" y="${(y + 10).toFixed(1)}" width="38" height="19" rx="5" fill="${cCol}" fill-opacity="0.2" stroke="${cCol}" stroke-width="0.9" />
        <text x="${(x + 71).toFixed(1)}" y="${(y + 23).toFixed(1)}" fill="${cCol}" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700" text-anchor="middle">CPU${node.cpu}</text>
        <text x="${(x + nodeW - 10).toFixed(1)}" y="${(y + 22).toFixed(1)}" fill="#8D98A9" font-family="JetBrains Mono, monospace" font-size="8.2" font-weight="700" text-anchor="end">${roleTag}</text>
        <text x="${(x + 12).toFixed(1)}" y="${(y + 43).toFixed(1)}" fill="#F4F7FB" font-family="JetBrains Mono, monospace" font-size="11.5" font-weight="700">${escapeHtml(node.threadName.slice(0, 20))}</text>
        <text x="${(x + 12).toFixed(1)}" y="${(y + 55).toFixed(1)}" fill="#8D98A9" font-family="JetBrains Mono, monospace" font-size="9">${node.id} · ${node.state}${node.criticalSectionUs ? ` · CS ${node.criticalSectionUs}µs` : ''}</text>
      </g>
    `;
  }

  // Draw medium-priority preemptors strip at bottom of SVG
  if (primary.preemptors.length > 0) {
    const py = height - 44;
    markup += `<text x="18" y="${py + 15}" fill="#FFA494" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="700">MEDIUM-PRIO PREEMPTORS:</text>`;
    let px = 178;
    for (const pr of primary.preemptors.slice(0, 3)) {
      const label = `${pr.threadName} [${pr.priority}f · C${pr.cpu} · ${pr.burstUs}µs]`;
      const pw = Math.min(228, Math.max(150, label.length * 6.0 + 18));
      if (px + pw > width - 16) break;
      const prTip = escapeHtml(
        `PREEMPTOR ${pr.threadName} (${pr.priority}f) ran ${pr.burstUs}µs on CPU${pr.cpu}, starving ${primary.rootOwner.threadName} (${primary.rootOwner.priority}f) while ${primary.maxWaiterPrio}f waited. Blocked completely once PTHREAD_PRIO_INHERIT boosts owner to ${primary.maxWaiterPrio}f.`
      );
      markup += `
        <g class="pi-hit" data-tip="${prTip}" style="cursor:pointer;">
          <rect x="${px}" y="${py}" width="${pw.toFixed(1)}" height="24" rx="12" fill="#3C1915" stroke="#E6482E" stroke-width="1" stroke-dasharray="3 2" />
          <text x="${(px + pw / 2).toFixed(1)}" y="${py + 15}" fill="#FFB4A6" font-family="JetBrains Mono, monospace" font-size="9.2" font-weight="600" text-anchor="middle">${escapeHtml(label)}</text>
        </g>
      `;
      px += pw + 10;
    }
  }

  svg.innerHTML = markup;
  svg.querySelectorAll('.pi-hit').forEach((n) => {
    const show = () => {
      inspEl.textContent = n.getAttribute('data-tip');
    };
    n.addEventListener('mouseenter', show);
    n.addEventListener('click', show);
  });

  // Render WCBL Before vs After PTHREAD_PRIO_INHERIT Comparison Panel
  const beforeUs = primary.worstBeforePiUs;
  const afterUs = primary.worstAfterPiUs;
  const maxBar = Math.max(beforeUs || 1000, afterUs || 100, 1);
  const beforePct = beforeUs === null ? 100 : Math.min(100, Math.round((beforeUs / maxBar) * 100));
  const afterPct = Math.max(4, Math.min(100, Math.round((afterUs / maxBar) * 100)));

  wcblEl.innerHTML = `
    <div class="wcbl-metric-box">
      <div class="wcbl-bar-row">
        <div class="wcbl-bar-head">
          <span>Before PI (PTHREAD_PRIO_NONE)</span>
          <span class="col-bad">${beforeUs === null ? 'UNBOUNDED' : `${beforeUs}µs`}</span>
        </div>
        <div class="wcbl-track"><div class="wcbl-fill wcbl-fill-bad" style="width:${beforePct}%"></div></div>
      </div>
      <div class="wcbl-bar-row">
        <div class="wcbl-bar-head">
          <span>After PI (PTHREAD_PRIO_INHERIT)</span>
          <span class="col-ok">${afterUs}µs</span>
        </div>
        <div class="wcbl-track"><div class="wcbl-fill wcbl-fill-good" style="width:${afterPct}%"></div></div>
      </div>
      <span class="wcbl-delta-pill">-${primary.maxReductionPct}% Worst-Case Blocking (${beforeUs !== null ? `${(beforeUs - afterUs).toFixed(1)}µs saved` : 'Deadlock broken'})</span>
    </div>
  `;

  listEl.innerHTML = chains
    .map((c) => {
      const pathStr = c.nodes.map((n) => `${n.threadName}[${n.priority}f]`).join(' -> ');
      const beforeTxt = c.wcbl.beforePiUs === null ? 'UNBOUNDED' : `${c.wcbl.beforePiUs}µs`;
      return `
        <div class="wcbl-chain-item">
          <div class="wcbl-chain-path">${escapeHtml(pathStr)}</div>
          <div class="wcbl-chain-meta">${c.hops} hop${c.hops > 1 ? 's' : ''} · Before: ${beforeTxt} · After PI: ${c.wcbl.afterPiUs}µs (-${c.wcbl.reductionPct}%) · ${c.preemptors.length} preemptor${c.preemptors.length === 1 ? '' : 's'}</div>
        </div>
      `;
    })
    .join('');
}

/**
 * Multi-Core SMP Utilization Cards, Deadline Margin Histogram SVG, and Thread Affinity Table
 */
function renderSmpAndMargins(report) {
  const smp = report.smpAnalytics;
  const hist = report.deadlineHistogram;

  const badge = el('smpSummaryBadge');
  if (badge) {
    badge.className = smp.totalMigrations > 0 ? 'tag tag-WARNING' : 'tag tag-PASS';
    badge.textContent = `${smp.coreCount} Cores · ${smp.totalMigrations} Migr · ${smp.totalPreemptions} Preempts`;
  }

  const tabSmp = el('tabSmp');
  if (tabSmp) {
    tabSmp.textContent = `SMP & Margins (${smp.coreCount}C)`;
  }

  // 1. CPU Core Utilization Cards
  const coreGrid = el('smpCoreGrid');
  coreGrid.innerHTML = smp.perCoreStats
    .map((c) => {
      const col = cpuColor(c.cpu);
      const cls = `core-badge-${c.cpu % 4}`;
      return `
        <div class="smp-core-tile">
          <div class="smp-core-head">
            <span class="core-badge ${cls}">${c.label}</span>
            <span>${c.utilizationPct}%</span>
          </div>
          <div class="smp-util-track">
            <div class="smp-util-fill" style="width:${Math.min(100, Math.max(2, c.utilizationPct))}%;background:${col};"></div>
          </div>
          <div class="smp-core-stats">
            <span>Run ${c.runningUs}µs</span>
            <span>CSW ${c.contextSwitches} · Pre ${c.preemptions}</span>
          </div>
        </div>
      `;
    })
    .join('');

  // 2. Interactive SVG Deadline Margin Histogram
  const hBadge = el('histHeadroomBadge');
  if (hBadge) {
    const ok = hist.worstMarginUs >= 0;
    hBadge.className = ok ? 'tag tag-PASS' : 'tag tag-CRITICAL';
    hBadge.textContent = ok
      ? `+${hist.worstMarginUs}µs Headroom (${hist.headroomPct}%)`
      : `${hist.worstMarginUs}µs Overrun (${hist.overBudgetCount} miss)`;
  }

  const hSvg = el('marginHistogramSvg');
  const w = 520;
  const h = 190;
  const padL = 36;
  const padR = 16;
  const padT = 22;
  const padB = 42;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const barGap = 14;
  const barW = (plotW - barGap * (hist.buckets.length - 1)) / hist.buckets.length;
  const maxCnt = Math.max(1, hist.maxBucketCount);

  const bucketColor = (status) => {
    if (status === 'violation') return '#E6482E';
    if (status === 'tight') return '#E59A28';
    if (status === 'warn') return '#00A3E8';
    return '#168A5B';
  };

  let hm = `
    <rect x="0" y="0" width="${w}" height="${h}" rx="10" fill="#FFFFFF" />
    <line x1="${padL}" y1="${padT + plotH}" x2="${w - padR}" y2="${padT + plotH}" stroke="rgba(20,22,26,0.16)" stroke-width="1" />
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="rgba(20,22,26,0.16)" stroke-width="1" />
  `;

  // Vertical dashed budget boundary between 75-100% and >100% OVER
  const budgetLineX = padL + 4 * barW + 3.5 * barGap;
  hm += `
    <line x1="${budgetLineX.toFixed(1)}" y1="${padT - 6}" x2="${budgetLineX.toFixed(1)}" y2="${padT + plotH}" stroke="#E6482E" stroke-width="1.4" stroke-dasharray="4 3" />
    <text x="${(budgetLineX - 4).toFixed(1)}" y="${padT - 8}" fill="#E6482E" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="700" text-anchor="end">Budget ${hist.budgetUs}µs</text>
  `;

  hist.buckets.forEach((b, i) => {
    const bx = padL + i * (barW + barGap);
    const bh = b.count > 0 ? Math.max(10, (b.count / maxCnt) * (plotH - 12)) : 3;
    const by = padT + plotH - bh;
    const col = bucketColor(b.status);
    hm += `
      <g>
        <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="6" fill="${col}" fill-opacity="${b.count > 0 ? '0.88' : '0.18'}" />
        <text x="${(bx + barW / 2).toFixed(1)}" y="${(by - 5).toFixed(1)}" fill="#14161A" font-family="JetBrains Mono, monospace" font-size="10.5" font-weight="700" text-anchor="middle">${b.count}</text>
        <text x="${(bx + barW / 2).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" fill="#3E434D" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="700" text-anchor="middle">${escapeHtml(b.label)}</text>
        <text x="${(bx + barW / 2).toFixed(1)}" y="${(padT + plotH + 29).toFixed(1)}" fill="#646873" font-family="JetBrains Mono, monospace" font-size="8.5" text-anchor="middle">${escapeHtml(b.rangeUs)}</text>
      </g>
    `;
  });

  hSvg.innerHTML = hm;

  // 3. SMP Thread Affinity & Migration Table
  const q = getFilterQuery();
  const tbody = el('smpAffinityBody');
  const lanes = report.timelineLanes.filter((l) => {
    if (!q) return true;
    const hay = `${l.threadName} ${l.id} cpu${l.primaryCpu} ${l.affinityStatus} ${l.policy}`.toLowerCase();
    return hay.includes(q);
  });

  if (!lanes.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="col-muted">No SMP thread lanes match current filter.</td></tr>';
    return;
  }

  tbody.innerHTML = lanes
    .map((l) => {
      const coresBadges = l.cpusUsed
        .map((c) => `<span class="core-badge core-badge-${c % 4}">CPU${c}</span>`)
        .join(' ');
      const guidance =
        l.migrationCount > 0 && l.priority >= 50
          ? `Pin with ThreadCtl(_NTO_TCTL_RUNMASK, (void*)(1u << ${l.primaryCpu}))`
          : l.migrationCount > 0
            ? 'Background migration acceptable (non-critical tier)'
            : `Pinned on CPU${l.primaryCpu} (0 migrations)`;
      return `
        <tr class="${l.migrationCount > 0 && l.priority >= 50 ? 'row-blocked' : ''}">
          <td class="col-nowrap"><strong>${escapeHtml(l.threadName)}</strong> <span class="col-muted">(${escapeHtml(l.id)})</span></td>
          <td class="col-nowrap"><strong>${l.priority}f</strong></td>
          <td class="col-nowrap"><span class="core-badge core-badge-${l.primaryCpu % 4}">CPU${l.primaryCpu}</span></td>
          <td class="col-nowrap">${coresBadges}</td>
          <td class="col-nowrap ${l.migrationCount > 0 ? 'col-bad' : 'col-ok'}">${l.migrationCount}</td>
          <td class="col-nowrap ${l.preemptionCount > 0 ? 'col-warn' : 'col-muted'}">${l.preemptionCount}</td>
          <td class="col-nowrap"><span class="tag ${l.migrationCount > 0 ? 'tag-WARNING' : 'tag-PASS'}">${l.affinityStatus}</span></td>
          <td class="col-mono-wrap ${l.migrationCount > 0 && l.priority >= 50 ? 'col-bad' : 'col-ok'}">${escapeHtml(guidance)}</td>
        </tr>
      `;
    })
    .join('');
}

function getFilterQuery() {
  return (el('inspectorFilter')?.value || '').trim().toLowerCase();
}

function renderFindings(report) {
  el('tabFindings').textContent = `Findings (${report.findings.length})`;
  const tbody = el('findingsBody');
  const q = getFilterQuery();

  if (report.findings.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td class="col-nowrap"><span class="tag tag-PASS">PASS</span></td>
        <td class="col-nowrap col-ok">RT_GATE</td>
        <td class="col-wrap">All real-time constraints satisfied (exit 0)</td>
        <td class="col-wrap col-muted">0 priority inversions, max jitter ${report.jitterStats.maxUs}µs within ${report.options.deadlineUs}µs budget, 0 starved threads, 0 RT SMP migrations.</td>
        <td class="col-mono-wrap col-ok">Verified PTHREAD_PRIO_INHERIT priority boost on contended mutex.</td>
      </tr>
    `;
    return;
  }

  const rows = report.findings.filter((f) => {
    if (!q) return true;
    const hay = `${f.severity} ${f.ruleId || ''} ${f.category} ${f.title} ${f.description} ${f.remediation}`.toLowerCase();
    return hay.includes(q);
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="col-muted">No findings match current filter.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map(
      (f) => `
      <tr>
        <td class="col-nowrap"><span class="tag tag-${escapeHtml(f.severity)}">${escapeHtml(f.severity)}</span></td>
        <td class="col-nowrap col-muted">${escapeHtml(f.ruleId ? `${f.ruleId} · ${f.category}` : f.category)}</td>
        <td class="col-wrap"><strong>${escapeHtml(f.title)}</strong></td>
        <td class="col-wrap col-muted">${escapeHtml(f.description)}</td>
        <td class="col-mono-wrap col-ok">${escapeHtml(f.remediation)}</td>
      </tr>
    `
    )
    .join('');
}

function renderSlog2(report) {
  el('tabSlog2').textContent = `slog2info (${report.logs.length})`;
  const sevFilter = el('slogSeverityFilter').value;
  const q = getFilterQuery();

  const filtered = report.logs.filter((l) => {
    if (sevFilter !== 'ALL' && l.severity !== sevFilter) return false;
    if (q) {
      const hay = `${l.timestamp} ${l.buffer}.${l.pid ?? ''} ${l.code} ${l.severity} ${l.message}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const tbody = el('slogBody');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="col-muted">No slog2info entries match current filter.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered
    .map(
      (l) => `
      <tr>
        <td class="col-nowrap col-muted">${escapeHtml(l.timestamp.replace(/^[A-Za-z]+\s+\d+\s+/, ''))}</td>
        <td class="col-nowrap col-accent">${escapeHtml(l.buffer)}${l.pid ? '.' + l.pid : ''}</td>
        <td class="col-nowrap col-muted">${escapeHtml(l.code)}</td>
        <td class="col-nowrap"><span class="tag tag-${escapeHtml(l.severity)}">${escapeHtml(l.severity)}</span></td>
        <td class="col-mono-wrap">${escapeHtml(l.message)}</td>
      </tr>
    `
    )
    .join('');
}

function renderPidin(report) {
  el('tabPidin').textContent = `pidin -F (${report.threads.length})`;
  const q = getFilterQuery();
  const rows = report.threads.filter((t) => {
    if (!q) return true;
    const hay = `${t.id} ${t.process} ${t.threadName} ${t.priority}${t.policyCode} ${t.policy} ${t.state} ${t.blockedOn?.raw || ''}`.toLowerCase();
    return hay.includes(q);
  });

  const tbody = el('pidinBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="col-muted">No pidin threads match current filter.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map((t) => {
      const isBlocked = t.state === 'MUTEX' || t.state === 'SEND' || t.state === 'REPLY';
      return `
        <tr class="${isBlocked ? 'row-blocked' : ''}">
          <td class="col-nowrap col-accent">${escapeHtml(t.id)}</td>
          <td class="col-nowrap">${escapeHtml(t.process)}</td>
          <td class="col-nowrap"><strong>${escapeHtml(t.threadName)}</strong></td>
          <td class="col-nowrap"><strong>${t.priority}${escapeHtml(t.policyCode)}</strong></td>
          <td class="col-nowrap col-muted">${escapeHtml(t.policy)}</td>
          <td class="col-nowrap"><span class="tag tag-${escapeHtml(t.state)}">${escapeHtml(t.state)}</span></td>
          <td class="col-nowrap ${t.blockedOn ? 'col-warn' : 'col-muted'}">${escapeHtml(t.blockedOn ? t.blockedOn.raw : '-')}</td>
        </tr>
      `;
    })
    .join('');
}

function renderPps(report) {
  el('tabPps').textContent = `/pps (${report.ppsObjects.length})`;
  const tbody = el('ppsBody');
  const q = getFilterQuery();

  const flatRows = [];
  for (const obj of report.ppsObjects) {
    for (const attr of Object.values(obj.attributes)) {
      const valText = typeof attr.value === 'object' ? JSON.stringify(attr.value) : String(attr.value);
      const isAlert =
        valText.includes('DEGRADED') ||
        valText.includes('INVERSION') ||
        (attr.key === 'inversion_detected' && attr.value === true);
      flatRows.push({ path: obj.path, key: attr.key, enc: attr.encoding, valText, isAlert });
    }
  }

  const filtered = flatRows.filter((r) => {
    if (!q) return true;
    return `${r.path} ${r.key} ${r.enc} ${r.valText}`.toLowerCase().includes(q);
  });

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="col-muted">No /pps attributes match current filter.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered
    .map(
      (r) => `
      <tr>
        <td class="col-nowrap col-accent">${escapeHtml(r.path)}</td>
        <td class="col-nowrap"><strong>${escapeHtml(r.key)}</strong></td>
        <td class="col-nowrap col-muted">${escapeHtml(r.enc)}</td>
        <td class="col-mono-wrap ${r.isAlert ? 'col-bad' : 'col-ok'}">${escapeHtml(r.valText)}</td>
      </tr>
    `
    )
    .join('');
}

function renderCliPane(report) {
  const sampleDir = currentPresetId === 'custom' ? '/path/to/capture-dir' : `samples/${currentPresetId}`;
  const deadline = report.options.deadlineUs;
  const commands = [
    {
      label: 'Run host CLI audit (exit 0 on PASS, exit 2 on RT violation)',
      cmd: `node cli/qnx-pulse.mjs analyze ${sampleDir} --deadline ${deadline}`
    },
    {
      label: 'Export SARIF 2.1.0 for GitHub Code Scanning (.github/workflows/qnx-pulse-gate.yml)',
      cmd: `node cli/qnx-pulse.mjs analyze ${sampleDir} --deadline ${deadline} --format sarif --out reports/qnx-pulse.sarif`
    },
    {
      label: 'Export JUnit XML for CI test runners (Jenkins / GitLab / GitHub Actions)',
      cmd: `node cli/qnx-pulse.mjs analyze ${sampleDir} --deadline ${deadline} --format junit --out reports/qnx-pulse.junit.xml`
    },
    {
      label: 'Generate JSON + Markdown audit reports',
      cmd: `node cli/qnx-pulse.mjs analyze ${sampleDir} --deadline ${deadline} --format markdown --out report.md`
    }
  ];

  const pane = el('cliPane');
  pane.innerHTML = commands
    .map(
      (item, idx) => `
      <div class="cli-row">
        <div class="cli-row-head">
          <span>${escapeHtml(item.label)}</span>
          <button class="code-copy-btn cli-copy-btn" data-cli-idx="${idx}" type="button">Copy</button>
        </div>
        <pre>${escapeHtml(item.cmd)}</pre>
      </div>
    `
    )
    .join('');

  pane.querySelectorAll('.cli-copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number.parseInt(btn.getAttribute('data-cli-idx'), 10);
      const cmd = commands[idx]?.cmd;
      if (!cmd) return;
      try {
        await navigator.clipboard.writeText(cmd);
        btn.textContent = 'Copied';
        setTimeout(() => {
          btn.textContent = 'Copy';
        }, 1200);
      } catch {
        btn.textContent = 'Ctrl+C';
        setTimeout(() => {
          btn.textContent = 'Copy';
        }, 1200);
      }
    });
  });
}

function setActiveTab(tabId) {
  activeTab = tabId;
  document.querySelectorAll('.insp-tab').forEach((btn) => {
    const isSel = btn.getAttribute('data-tab') === tabId;
    btn.classList.toggle('active', isSel);
    btn.setAttribute('aria-selected', isSel ? 'true' : 'false');
  });

  el('paneFindings').classList.toggle('hidden', tabId !== 'findings');
  el('panePiTree').classList.toggle('hidden', tabId !== 'pitree');
  el('paneSmp').classList.toggle('hidden', tabId !== 'smp');
  el('paneSlog2').classList.toggle('hidden', tabId !== 'slog2');
  el('panePidin').classList.toggle('hidden', tabId !== 'pidin');
  el('panePps').classList.toggle('hidden', tabId !== 'pps');
  el('paneCli').classList.toggle('hidden', tabId !== 'cli');

  el('slogSeverityFilter').classList.toggle('hidden', tabId !== 'slog2');
  el('inspectorFilter').classList.toggle('hidden', tabId === 'cli' || tabId === 'pitree');
}

function renderActiveTable() {
  if (!currentReport) return;
  renderFindings(currentReport);
  renderPiBlockingTree(currentReport);
  renderSmpAndMargins(currentReport);
  renderSlog2(currentReport);
  renderPidin(currentReport);
  renderPps(currentReport);
  renderCliPane(currentReport);
}

function runAnalysis() {
  currentReport = analyzeCapture(currentBundle, { deadlineUs: currentDeadlineUs });
  renderSummary(currentReport);
  renderSvgTimeline(currentReport);
  renderActiveTable();
}

function selectPreset(id) {
  if (!PRESETS[id]) return;
  currentPresetId = id;
  currentBundle = PRESETS[id];
  const sel = el('captureSelect');
  if (sel && sel.value !== id) sel.value = id;
  runAnalysis();
}

function setupInteractions() {
  const sel = el('captureSelect');
  sel.addEventListener('change', () => {
    if (PRESETS[sel.value]) {
      selectPreset(sel.value);
    }
  });

  const deadlineInput = el('deadlineInput');
  deadlineInput.addEventListener('input', () => {
    const parsed = Number.parseInt(deadlineInput.value, 10);
    if (!Number.isNaN(parsed) && parsed >= 10) {
      currentDeadlineUs = parsed;
      runAnalysis();
    }
  });

  el('btnScrubPlay').addEventListener('click', () => {
    if (scrubPlaying) stopScrubPlayback();
    else startScrubPlayback();
  });

  el('scrubSlider').addEventListener('input', (e) => {
    stopScrubPlayback();
    const val = Number.parseFloat(e.target.value);
    if (!Number.isNaN(val)) {
      updateScrubVisuals(val, true);
    }
  });

  el('timelineSvg').addEventListener('click', (e) => {
    const svg = el('timelineSvg');
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const scaleX = 1280 / rect.width;
    const svgX = (e.clientX - rect.left) * scaleX;
    if (svgX >= timelineGeom.leftPad && svgX <= timelineGeom.leftPad + timelineGeom.plotW) {
      stopScrubPlayback();
      const ratio = (svgX - timelineGeom.leftPad) / timelineGeom.plotW;
      updateScrubVisuals(ratio * timelineGeom.duration, true);
    }
  });

  // SMP Core Affinity Lane View toggle
  const smpBtn = el('btnSmpLaneMode');
  if (smpBtn) {
    smpBtn.addEventListener('click', () => {
      smpLaneMode = !smpLaneMode;
      smpBtn.classList.toggle('is-active', smpLaneMode);
      smpBtn.setAttribute('aria-pressed', smpLaneMode ? 'true' : 'false');
      smpBtn.textContent = smpLaneMode ? 'State View' : 'SMP Core View';
      if (currentReport) renderSvgTimeline(currentReport);
    });
  }

  // 1-Click Compare Before vs After PI Fix toggle
  el('btnComparePi').addEventListener('click', () => {
    if (currentPresetId === 'surgical-arm-clean') {
      selectPreset('brake-ecu-inversion');
    } else {
      selectPreset('surgical-arm-clean');
    }
  });

  document.querySelectorAll('.insp-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      setActiveTab(btn.getAttribute('data-tab'));
    });
  });

  el('inspectorFilter').addEventListener('input', () => renderActiveTable());
  el('slogSeverityFilter').addEventListener('change', () => renderSlog2(currentReport));

  // Export buttons: JSON, Markdown, SARIF 2.1.0, JUnit XML
  el('btnExportJson').addEventListener('click', () => {
    downloadFile(`qnx-pulse-audit-${currentPresetId}.json`, formatJsonReport(currentReport), 'application/json');
  });
  el('btnExportMd').addEventListener('click', () => {
    downloadFile(`qnx-pulse-audit-${currentPresetId}.md`, formatMarkdownReport(currentReport), 'text/markdown');
  });
  el('btnExportSarif').addEventListener('click', () => {
    downloadFile(`qnx-pulse-audit-${currentPresetId}.sarif`, formatSarifReport(currentReport), 'application/sarif+json');
  });
  el('btnExportJunit').addEventListener('click', () => {
    downloadFile(`qnx-pulse-audit-${currentPresetId}.junit.xml`, formatJunitReport(currentReport), 'application/xml');
  });

  // Open Capture Importer Drawer
  const importPanel = el('importPanel');
  el('btnToggleImport').addEventListener('click', () => {
    importPanel.classList.toggle('hidden');
    if (!importPanel.classList.contains('hidden')) {
      el('inputPidin').value = currentBundle.pidin || '';
      el('inputTrace').value = currentBundle.trace || '';
      el('inputSlog2').value = currentBundle.slog2 || '';
      el('inputPps').value = currentBundle.pps || '';
    }
  });
  el('btnCloseImport').addEventListener('click', () => importPanel.classList.add('hidden'));

  async function ingestFiles(fileList) {
    for (const file of fileList) {
      const text = await file.text();
      const name = file.name.toLowerCase();
      if (name.includes('pidin')) el('inputPidin').value = text;
      else if (name.includes('trace') || name.endsWith('.csv')) el('inputTrace').value = text;
      else if (name.includes('pps') || name.endsWith('.pps')) el('inputPps').value = text;
      else el('inputSlog2').value = text;
    }
  }

  el('fileInput').addEventListener('change', (e) => ingestFiles(e.target.files));

  const dz = el('dropzone');
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('dragover');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    if (e.dataTransfer?.files?.length) ingestFiles(e.dataTransfer.files);
  });

  el('btnRunCustom').addEventListener('click', () => {
    currentPresetId = 'custom';
    currentBundle = {
      meta: { name: 'Custom QNX 8.0 Capture', target: 'x86_64-neutrino-8.0 (procnto-smp-instr)' },
      pidin: el('inputPidin').value,
      trace: el('inputTrace').value,
      slog2: el('inputSlog2').value,
      pps: el('inputPps').value
    };
    importPanel.classList.add('hidden');
    runAnalysis();
  });

  const params = new URLSearchParams(window.location.search);
  const urlPreset = params.get('preset');
  if (urlPreset && PRESETS[urlPreset]) {
    currentPresetId = urlPreset;
    currentBundle = PRESETS[urlPreset];
    sel.value = urlPreset;
  }
}

setupInteractions();
setActiveTab('findings');
runAnalysis();
