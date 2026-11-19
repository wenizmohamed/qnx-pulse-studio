import { analyzeCapture, formatJsonReport, formatMarkdownReport } from './engine/analyzer.js';
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

const CAPTURE_TITLES = {
  'brake-ecu-inversion': 'Brake ECU Priority Inversion',
  'surgical-arm-clean': 'Surgical Arm Fixed PI',
  'qemu-starter': 'QEMU x86_64 Starter Capture',
  custom: 'Custom QNX 8.0 Capture'
};

let currentBundle = PRESETS['brake-ecu-inversion'];
let currentPresetId = 'brake-ecu-inversion';
let currentDeadlineUs = 500;
let currentReport = null;
let activeTab = 'findings';

let scrubUs = 0;
let scrubPlaying = false;
let scrubRafId = null;
let scrubLastFrameTs = 0;
let timelineGeom = { leftPad: 204, plotW: 1056, duration: 1980, rulerH: 26, height: 260 };

const el = (id) => document.getElementById(id);

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
    const clampedX = Math.max(timelineGeom.leftPad + 2, Math.min(timelineGeom.leftPad + timelineGeom.plotW - tagW, x - tagW / 2));
    cursorTag.setAttribute('x', clampedX.toFixed(1));
    cursorText.setAttribute('x', (clampedX + tagW / 2).toFixed(1));
    cursorText.textContent = `${Math.round(scrubUs)}µs`;
  }

  if (updateStatusbar && currentReport) {
    const activeStates = [];
    for (const lane of currentReport.timelineLanes) {
      const hit = lane.segments.find((s) => scrubUs >= s.startUs && scrubUs <= s.endUs);
      if (hit) {
        activeStates.push(`${lane.threadName}[${hit.state}]`);
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

  // Navbar status pill & LEDs
  const badge = el('verdictBadge');
  badge.className = isPass ? 'status-pill status-pass' : 'status-pill status-fail';
  badge.textContent = isPass ? 'PASS exit 0' : `FAIL exit ${report.exitCode}`;

  const brandLed = el('brandLed');
  if (brandLed) brandLed.className = isPass ? 'brand-dot is-pass' : 'brand-dot';

  const stageLed = el('stageLed');
  if (stageLed) stageLed.className = isPass ? 'stage-led is-pass' : 'stage-led';

  // Dynamic Masthead Title
  const heading = el('captureHeading');
  if (heading) {
    heading.textContent = CAPTURE_TITLES[currentPresetId] || report.meta?.name || 'QNX 8.0 Capture';
  }

  // 4 Segmented Capsules
  el('capThreads').textContent = `${report.summary.totalThreads} Threads (${report.summary.fifoThreads} FIFO)`;

  const capInv = el('capInversions');
  if (report.summary.priorityInversions > 0) {
    const peakUs = report.inversionBands[0]?.durationUs ?? 0;
    capInv.textContent = `${report.summary.priorityInversions} Inversion (${peakUs}µs)`;
    capInv.className = 'metric-capsule capsule-signal';
  } else {
    capInv.textContent = '0 Inversions (Clean PI)';
    capInv.className = 'metric-capsule capsule-emerald';
  }

  el('capContention').textContent = `${report.summary.ipcBlockChains} Blocked IPC · ${report.summary.starvedThreads} Starved`;
  el('capKernel').textContent = extractKernelLabel(report.meta?.target);

  const targetClock = el('targetClockMeta');
  if (targetClock) {
    targetClock.textContent = `${report.meta?.target || 'x86_64-neutrino-8.0'} · SYSPAGE(qtime)`;
  }

  // 3 Giant Borderless Open Numerals
  const numJitter = el('numMaxJitter');
  numJitter.textContent = `${report.jitterStats.maxUs}µs`;
  numJitter.className = `numeral-value ${report.jitterStats.maxUs > report.options.deadlineUs ? 'is-bad' : 'is-ok'}`;

  const numBudget = el('numBudget');
  numBudget.textContent = `${report.options.deadlineUs}µs`;

  const numGate = el('numCiGate');
  numGate.textContent = isPass ? 'exit 0' : `exit ${report.exitCode}`;
  numGate.className = `numeral-value ${isPass ? 'is-ok' : 'is-bad'}`;

  // Compare Before vs After PI Fix pill state
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
  const leftPad = 204;
  const rightPad = 20;
  const rulerH = 26;
  const bannerH = report.inversionBands.length > 0 ? 18 : 6;
  const topPad = rulerH + bannerH;
  const laneH = 36;
  const bottomPad = 10;
  const plotW = width - leftPad - rightPad;
  const height = Math.max(210, topPad + lanes.length * laneH + bottomPad);

  timelineGeom = { leftPad, plotW, duration, rulerH, height };

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  el('timelineMeta').textContent = `${lanes.length} lanes · ${duration}µs · ${report.ipcEdges.length} IPC edges`;

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
    <text x="12" y="17" fill="#8D98A9" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600">PRIO  THREAD (PID:TID)</text>
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
    const labelW = Math.min(Math.max(w, 250), 320);
    const tip = escapeHtml(
      `PRIORITY INVERSION (${inv.durationUs}µs): ${inv.highThread.name}[${inv.highThread.prio}f] blocked on ${inv.lowOwner.name}[${inv.lowOwner.prio}f] while ${inv.mediumThread.name}[${inv.mediumThread.prio}f] ran on CPU${inv.cpu}`
    );
    markup += `
      <g class="svg-hit" data-tip="${tip}" style="cursor:pointer;">
        <rect x="${x1.toFixed(1)}" y="${topPad}" width="${w.toFixed(1)}" height="${bandH}" fill="rgba(230,72,46,0.12)" />
        <rect x="${x1.toFixed(1)}" y="${topPad}" width="${w.toFixed(1)}" height="${bandH}" fill="url(#invHatch)" />
        <line x1="${x1.toFixed(1)}" y1="${rulerH}" x2="${x1.toFixed(1)}" y2="${topPad + bandH}" stroke="#E6482E" stroke-width="1.2" stroke-dasharray="3 2" />
        <line x1="${x2.toFixed(1)}" y1="${rulerH}" x2="${x2.toFixed(1)}" y2="${topPad + bandH}" stroke="#E6482E" stroke-width="1.2" stroke-dasharray="3 2" />
        <rect x="${x1.toFixed(1)}" y="${rulerH + 1}" width="${labelW.toFixed(1)}" height="16" rx="3" fill="#461A15" stroke="#E6482E" stroke-width="0.9" />
        <text x="${(x1 + 7).toFixed(1)}" y="${rulerH + 12}" fill="#FFA494" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700">INVERSION ${inv.durationUs}µs (p${inv.highThread.prio} stalled by p${inv.mediumThread.prio})</text>
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

    // Left track header
    const prioBorder = lane.priority >= 55 ? '#00A3E8' : lane.priority >= 35 ? '#E59A28' : '#4C566A';
    const prioText = lane.priority >= 55 ? '#7DD8FF' : lane.priority >= 35 ? '#F3BE63' : '#9AA4B5';
    markup += `
      <rect x="10" y="${y + 8}" width="34" height="19" rx="5" fill="#111419" stroke="${prioBorder}" stroke-width="1" />
      <text x="27" y="${y + 21}" fill="${prioText}" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700" text-anchor="middle">${lane.priority}f</text>
      <text x="52" y="${y + 16}" fill="#EFF3F8" font-family="JetBrains Mono, monospace" font-size="11" font-weight="600">${escapeHtml(lane.threadName.slice(0, 18))}</text>
      <text x="52" y="${y + 28}" fill="#7D8798" font-family="JetBrains Mono, monospace" font-size="9.5">${lane.pid}:${lane.tid}</text>
    `;

    // Execution bars (flat Perfetto hardware instrument style)
    for (const seg of lane.segments) {
      const sx = xOf(seg.startUs);
      const ex = xOf(seg.endUs);
      const sw = Math.max(2.5, ex - sx);
      const fill = STATE_COLORS[seg.state] || '#6C7686';
      const txtColor = STATE_TEXT_COLORS[seg.state] || '#EFF3F8';
      const tip = escapeHtml(
        `${lane.threadName} (${lane.id}, ${seg.prio}f) | ${seg.state} | ${seg.startUs}µs..${seg.endUs}µs (${seg.durationUs}µs) | CPU${seg.cpu}${seg.detail ? ' | ' + seg.detail : ''}`
      );
      const barH = 19;
      const barY = midY - barH / 2;
      const label = `${seg.state} ${seg.durationUs}µs`;
      const fitsFull = sw > label.length * 6.2 + 10;
      const fitsShort = !fitsFull && sw > 36;

      markup += `
        <g class="svg-hit" data-tip="${tip}" style="cursor:pointer;">
          <rect x="${sx.toFixed(1)}" y="${barY.toFixed(1)}" width="${sw.toFixed(1)}" height="${barH}" rx="3" fill="${fill}" stroke="#111419" stroke-width="0.9" />
          ${
            fitsFull
              ? `<text x="${(sx + 6).toFixed(1)}" y="${(midY + 3.5).toFixed(1)}" fill="${txtColor}" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="700">${escapeHtml(label)}</text>`
              : fitsShort
                ? `<text x="${(sx + 5).toFixed(1)}" y="${(midY + 3.5).toFixed(1)}" fill="${txtColor}" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700">${seg.durationUs}µs</text>`
                : ''
          }
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
  const initCursorUs = report.inversionBands.length > 0 ? Math.round((report.inversionBands[0].startUs + report.inversionBands[0].endUs) / 2) : Math.round(duration * 0.25);
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

  // Bind hit inspection
  const inspector = el('timelineInspector');
  svg.querySelectorAll('.svg-hit').forEach((node) => {
    const show = () => {
      inspector.innerHTML = `<span class="statusbar-text">${node.getAttribute('data-tip')}</span><span class="status-right">clock: SYSPAGE(qtime) · traceprinter</span>`;
    };
    node.addEventListener('mouseenter', show);
    node.addEventListener('click', show);
  });

  // Update scrub slider & button label for current duration
  stopScrubPlayback();
  updateScrubVisuals(scrubUs, false);
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
        <td class="col-wrap col-muted">0 priority inversions, max jitter ${report.jitterStats.maxUs}µs within ${report.options.deadlineUs}µs budget, 0 starved threads.</td>
        <td class="col-mono-wrap col-ok">Verified PTHREAD_PRIO_INHERIT priority boost on contended mutex.</td>
      </tr>
    `;
    return;
  }

  const rows = report.findings.filter((f) => {
    if (!q) return true;
    const hay = `${f.severity} ${f.category} ${f.title} ${f.description} ${f.remediation}`.toLowerCase();
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
        <td class="col-nowrap col-muted">${escapeHtml(f.category)}</td>
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
      label: 'Generate JSON report for CI pipeline gating',
      cmd: `node cli/qnx-pulse.mjs analyze ${sampleDir} --deadline ${deadline} --format json --out report.json`
    },
    {
      label: 'Generate Markdown audit report',
      cmd: `node cli/qnx-pulse.mjs analyze ${sampleDir} --deadline ${deadline} --format markdown --out report.md`
    },
    {
      label: 'Capture synchronized diagnostics on QNX Neutrino 8.0 target',
      cmd: `/proc/boot/capture-diag.sh /tmp/capture-${currentPresetId} 3`
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
  el('paneSlog2').classList.toggle('hidden', tabId !== 'slog2');
  el('panePidin').classList.toggle('hidden', tabId !== 'pidin');
  el('panePps').classList.toggle('hidden', tabId !== 'pps');
  el('paneCli').classList.toggle('hidden', tabId !== 'cli');

  el('slogSeverityFilter').classList.toggle('hidden', tabId !== 'slog2');
  el('inspectorFilter').classList.toggle('hidden', tabId === 'cli');
}

function renderActiveTable() {
  if (!currentReport) return;
  renderFindings(currentReport);
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
  // Capture dropdown switcher
  const sel = el('captureSelect');
  sel.addEventListener('change', () => {
    if (PRESETS[sel.value]) {
      selectPreset(sel.value);
    }
  });

  // Deadline numeric input
  const deadlineInput = el('deadlineInput');
  deadlineInput.addEventListener('input', () => {
    const parsed = Number.parseInt(deadlineInput.value, 10);
    if (!Number.isNaN(parsed) && parsed >= 10) {
      currentDeadlineUs = parsed;
      runAnalysis();
    }
  });

  // Live Microsecond Scrub Controls
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

  // Click anywhere on SVG plot to jump scrub cursor
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

  // 1-Click Compare Before vs After PI Fix toggle
  el('btnComparePi').addEventListener('click', () => {
    if (currentPresetId === 'surgical-arm-clean') {
      selectPreset('brake-ecu-inversion');
    } else {
      selectPreset('surgical-arm-clean');
    }
  });

  // Inspector tabs
  document.querySelectorAll('.insp-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      setActiveTab(btn.getAttribute('data-tab'));
    });
  });

  // Shared live filter + slog2 severity dropdown
  el('inspectorFilter').addEventListener('input', () => renderActiveTable());
  el('slogSeverityFilter').addEventListener('change', () => renderSlog2(currentReport));

  // Export buttons
  el('btnExportJson').addEventListener('click', () => {
    downloadFile(`qnx-pulse-audit-${currentPresetId}.json`, formatJsonReport(currentReport), 'application/json');
  });
  el('btnExportMd').addEventListener('click', () => {
    downloadFile(`qnx-pulse-audit-${currentPresetId}.md`, formatMarkdownReport(currentReport), 'text/markdown');
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

  // Honor URL query ?preset=...
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
