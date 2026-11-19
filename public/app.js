import { analyzeCapture, formatJsonReport, formatMarkdownReport } from './engine/analyzer.js';
import { PRESETS } from './engine/presets.js';

const STATE_COLORS = {
  RUNNING: '#10B981',
  PI_BOOST: '#00D4FF',
  MUTEX: '#EF4444',
  REPLY: '#F59E0B',
  SEND: '#F59E0B',
  RECEIVE: '#38BDF8',
  READY: '#A855F7',
  SLEEP: '#334155'
};

let currentBundle = PRESETS['brake-ecu-inversion'];
let currentPresetId = 'brake-ecu-inversion';
let currentDeadlineUs = 500;
let currentReport = null;

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

function renderKpis(report) {
  const badge = el('verdictBadge');
  if (report.status === 'PASS') {
    badge.className = 'badge badge-pass';
    badge.innerHTML = '<span class="pulse-dot"></span><span>RT PASS · EXIT 0</span>';
  } else {
    badge.className = 'badge badge-fail';
    badge.innerHTML = '<span class="pulse-dot"></span><span>RT VIOLATION · EXIT 2</span>';
  }

  const scoreEl = el('kpiScore');
  scoreEl.textContent = `${report.score}/100`;
  scoreEl.className = `kpi-value ${report.score >= 90 ? 'val-emerald' : report.score >= 60 ? 'val-amber' : 'val-crimson'}`;
  el('kpiVerdictSub').textContent = `Verdict: ${report.status} (CI Exit ${report.exitCode})`;

  const invEl = el('kpiInversions');
  invEl.textContent = String(report.summary.priorityInversions);
  invEl.className = `kpi-value ${report.summary.priorityInversions > 0 ? 'val-crimson' : 'val-emerald'}`;
  el('kpiInvSub').textContent =
    report.inversionBands.length > 0
      ? `Peak stall: ${report.inversionBands[0].durationUs} us`
      : 'Zero SCHED_FIFO inversions';

  const jitEl = el('kpiMaxJitter');
  jitEl.textContent = `${report.jitterStats.maxUs} us`;
  jitEl.className = `kpi-value ${report.jitterStats.maxUs > report.options.deadlineUs ? 'val-crimson' : 'val-emerald'}`;
  el('kpiJitterSub').textContent = `P95 ${report.jitterStats.p95Us}us · Budget ${report.options.deadlineUs}us`;

  const chEl = el('kpiChains');
  chEl.textContent = String(report.summary.ipcBlockChains);
  chEl.className = `kpi-value ${report.summary.ipcBlockChains > 0 ? 'val-amber' : 'val-emerald'}`;
  el('kpiChainsSub').textContent = `${report.ipcEdges.length} traced IPC hops`;

  const stEl = el('kpiStarved');
  stEl.textContent = String(report.summary.starvedThreads);
  stEl.className = `kpi-value ${report.summary.starvedThreads > 0 ? 'val-amber' : 'val-emerald'}`;
  el('kpiStarvedSub').textContent =
    report.starvationFindings.length > 0
      ? `${report.starvationFindings[0].threadName}: ${report.starvationFindings[0].waitedUs}us`
      : 'Zero starved READY threads';

  el('kpiThreads').textContent = String(report.summary.totalThreads);
  el('kpiThreadsSub').textContent = `${report.summary.fifoThreads} SCHED_FIFO · ${report.summary.totalTraceEvents} events`;
}

function renderSvgTimeline(report) {
  const svg = el('timelineSvg');
  const lanes = report.timelineLanes;
  const duration = Math.max(report.timelineDurationUs || 1000, 200);

  const leftPad = 195;
  const rightPad = 24;
  const topPad = 56;
  const laneH = 44;
  const bottomPad = 32;
  const width = 1160;
  const plotW = width - leftPad - rightPad;
  const height = Math.max(240, topPad + lanes.length * laneH + bottomPad);

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  el('timelineMeta').textContent = `${lanes.length} lanes · ${duration} us window · ${report.ipcEdges.length} IPC arrows`;

  const xOf = (us) => leftPad + (Math.max(0, Math.min(duration, us)) / duration) * plotW;
  const yOfLane = (idx) => topPad + idx * laneH;

  const laneIndex = new Map();
  lanes.forEach((l, i) => laneIndex.set(l.id, i));

  let markup = `
    <defs>
      <pattern id="invHatch" width="8" height="8" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
        <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(239,68,68,0.45)" stroke-width="2" />
      </pattern>
      <marker id="arrowSend" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="#F59E0B" />
      </marker>
      <marker id="arrowReply" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="#10B981" />
      </marker>
      <marker id="arrowPulse" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="#00D4FF" />
      </marker>
    </defs>
  `;

  // Vertical time gridlines
  const tickCount = 8;
  for (let i = 0; i <= tickCount; i++) {
    const us = Math.round((duration / tickCount) * i);
    const x = xOf(us);
    markup += `<line x1="${x.toFixed(1)}" y1="${topPad - 24}" x2="${x.toFixed(1)}" y2="${height - bottomPad}" stroke="#162230" stroke-width="1" />`;
    markup += `<text x="${x.toFixed(1)}" y="${topPad - 32}" fill="#688099" font-family="monospace" font-size="10.5" text-anchor="middle">${us}us</text>`;
  }

  // Priority Inversion vertical highlight bands
  for (const inv of report.inversionBands) {
    const x1 = xOf(inv.startUs);
    const x2 = xOf(inv.endUs);
    const w = Math.max(4, x2 - x1);
    const bandH = lanes.length * laneH;
    const tip = escapeHtml(
      `PRIORITY INVERSION (${inv.durationUs}us): ${inv.highThread.name}[p${inv.highThread.prio}] blocked on ${inv.lowOwner.name}[p${inv.lowOwner.prio}] while ${inv.mediumThread.name}[p${inv.mediumThread.prio}] ran on CPU${inv.cpu}`
    );
    markup += `
      <g class="svg-hit" data-tip="${tip}" style="cursor:pointer;">
        <rect x="${x1.toFixed(1)}" y="${topPad}" width="${w.toFixed(1)}" height="${bandH}" fill="rgba(239,68,68,0.14)" />
        <rect x="${x1.toFixed(1)}" y="${topPad}" width="${w.toFixed(1)}" height="${bandH}" fill="url(#invHatch)" stroke="#EF4444" stroke-width="1.2" stroke-dasharray="4 3" />
        <rect x="${x1.toFixed(1)}" y="${topPad - 22}" width="${Math.min(Math.max(w, 290), 340).toFixed(1)}" height="19" rx="4" fill="#EF4444" />
        <text x="${(x1 + 8).toFixed(1)}" y="${topPad - 9}" fill="#FFFFFF" font-family="monospace" font-size="10.5" font-weight="700">INVERSION ${inv.durationUs}us (p${inv.highThread.prio} stalled by p${inv.mediumThread.prio})</text>
      </g>
    `;
  }

  // Thread lanes and execution segments
  lanes.forEach((lane, idx) => {
    const y = yOfLane(idx);
    const midY = y + laneH / 2;

    markup += `<line x1="${leftPad}" y1="${y + laneH}" x2="${width - rightPad}" y2="${y + laneH}" stroke="#131e2a" stroke-width="1" />`;

    // Left lane label
    const prioColor = lane.priority >= 55 ? '#00D4FF' : lane.priority >= 35 ? '#F59E0B' : '#9FB3C8';
    markup += `
      <rect x="10" y="${y + 7}" width="38" height="22" rx="4" fill="rgba(0,212,255,0.1)" stroke="${prioColor}" stroke-opacity="0.5" />
      <text x="29" y="${y + 22}" fill="${prioColor}" font-family="monospace" font-size="11" font-weight="700" text-anchor="middle">${lane.priority}f</text>
      <text x="56" y="${y + 18}" fill="#E8F1F8" font-family="monospace" font-size="11.5" font-weight="600">${escapeHtml(lane.threadName.slice(0, 17))}</text>
      <text x="56" y="${y + 32}" fill="#688099" font-family="monospace" font-size="10">pid ${lane.pid}:${lane.tid}</text>
    `;

    // Segments
    for (const seg of lane.segments) {
      const sx = xOf(seg.startUs);
      const ex = xOf(seg.endUs);
      const sw = Math.max(3, ex - sx);
      const fill = STATE_COLORS[seg.state] || '#64748B';
      const opacity = seg.state === 'SLEEP' ? '0.45' : '0.9';
      const tip = escapeHtml(
        `${lane.threadName} (${lane.id}, prio ${seg.prio}f) · ${seg.state} · ${seg.startUs}us -> ${seg.endUs}us (${seg.durationUs}us) · CPU${seg.cpu}${seg.detail ? ' · ' + seg.detail : ''}`
      );
      markup += `
        <g class="svg-hit" data-tip="${tip}" style="cursor:pointer;">
          <rect x="${sx.toFixed(1)}" y="${(midY - 10).toFixed(1)}" width="${sw.toFixed(1)}" height="20" rx="3" fill="${fill}" fill-opacity="${opacity}" stroke="#070B0F" stroke-width="0.8" />
          ${
            sw > 58
              ? `<text x="${(sx + 6).toFixed(1)}" y="${(midY + 3.5).toFixed(1)}" fill="#070B0F" font-family="monospace" font-size="9.5" font-weight="700">${escapeHtml(seg.state)} ${seg.durationUs}us</text>`
              : ''
          }
        </g>
      `;
    }
  });

  // Directed IPC arrows (SEND / REPLY / PULSE)
  for (const edge of report.ipcEdges) {
    const fromIdx = laneIndex.get(edge.fromId);
    const toIdx = laneIndex.get(edge.toId);
    if (fromIdx === undefined || toIdx === undefined) continue;

    const x = xOf(edge.timeUs);
    const y1 = yOfLane(fromIdx) + laneH / 2;
    const y2 = yOfLane(toIdx) + laneH / 2;
    const stroke = edge.kind === 'PULSE' ? '#00D4FF' : edge.kind === 'REPLY' ? '#10B981' : '#F59E0B';
    const marker = edge.kind === 'PULSE' ? 'url(#arrowPulse)' : edge.kind === 'REPLY' ? 'url(#arrowReply)' : 'url(#arrowSend)';
    const dash = edge.kind === 'PULSE' ? '3 2' : '';
    const tip = escapeHtml(
      `IPC ${edge.kind} @ ${edge.timeUs}us: ${edge.fromName} (${edge.fromId}) -> ${edge.toName} (${edge.toId})${edge.detail ? ' · ' + edge.detail : ''}`
    );

    markup += `
      <g class="svg-hit" data-tip="${tip}" style="cursor:pointer;">
        <line x1="${x.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="2" ${dash ? `stroke-dasharray="${dash}"` : ''} marker-end="${marker}" />
        <circle cx="${x.toFixed(1)}" cy="${y1.toFixed(1)}" r="3" fill="${stroke}" />
      </g>
    `;
  }

  // Axis footer label
  markup += `<text x="${leftPad}" y="${height - 10}" fill="#688099" font-family="monospace" font-size="10.5">QNX Neutrino 8.0 Kernel Trace Timeline (microseconds from capture origin)</text>`;
  svg.innerHTML = markup;

  const inspector = el('timelineInspector');
  svg.querySelectorAll('.svg-hit').forEach((node) => {
    const show = () => {
      inspector.innerHTML = `<span style="color:var(--text-0);">${node.getAttribute('data-tip')}</span><span class="mono" style="color:var(--cyan);">LIVE KERNEL INSPECTOR</span>`;
    };
    node.addEventListener('mouseenter', show);
    node.addEventListener('click', show);
  });
}

function renderFindings(report) {
  el('findingsCount').textContent = `${report.findings.length} finding${report.findings.length === 1 ? '' : 's'}`;
  const grid = el('findingsGrid');

  if (report.findings.length === 0) {
    grid.innerHTML = `
      <div class="finding-card" style="border-left-color: var(--emerald);">
        <div class="finding-head">
          <div class="finding-title">All Hard Real-Time Constraints Satisfied</div>
          <span class="badge badge-pass">PASS · EXIT 0</span>
        </div>
        <div class="finding-desc">
          Zero priority inversions, zero deadline violations above ${report.options.deadlineUs} us (max observed: ${report.jitterStats.maxUs} us), and zero starved SCHED_FIFO threads.
        </div>
        <div class="finding-fix">Verified: PTHREAD_PRIO_INHERIT priority boost kept critical section bounded.</div>
      </div>
    `;
    return;
  }

  grid.innerHTML = report.findings
    .map(
      (f) => `
      <article class="finding-card sev-${escapeHtml(f.severity)}">
        <div class="finding-head">
          <div class="finding-title">${escapeHtml(f.title)}</div>
          <span class="sev-tag sev-${escapeHtml(f.severity)}">${escapeHtml(f.severity)}</span>
        </div>
        <div class="finding-desc">${escapeHtml(f.description)}</div>
        <div class="finding-fix">Fix: ${escapeHtml(f.remediation)}</div>
      </article>
    `
    )
    .join('');
}

function renderSlog2(report) {
  const sevFilter = el('slogSeverityFilter').value;
  const query = el('slogSearch').value.trim().toLowerCase();

  const filtered = report.logs.filter((l) => {
    if (sevFilter !== 'ALL' && l.severity !== sevFilter) return false;
    if (query) {
      const hay = `${l.buffer}.${l.pid ?? ''} ${l.code} ${l.severity} ${l.message}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  const list = el('slogList');
  if (!filtered.length) {
    list.innerHTML = '<div style="padding:14px;color:var(--text-2);">No slog2 entries match current filter.</div>';
    return;
  }

  list.innerHTML = filtered
    .map(
      (l) => `
      <div class="slog-row">
        <span class="slog-ts">${escapeHtml(l.timestamp.replace(/^[A-Za-z]+\s+\d+\s+/, ''))}</span>
        <span class="slog-buf">${escapeHtml(l.buffer)}${l.pid ? '.' + l.pid : ''}</span>
        <span class="sev-tag sev-${escapeHtml(l.severity)}">${escapeHtml(l.severity)}</span>
        <span class="slog-msg">${escapeHtml(l.message)}</span>
      </div>
    `
    )
    .join('');
}

function renderPidin(report) {
  const tbody = el('pidinBody');
  tbody.innerHTML = report.threads
    .map(
      (t) => `
      <tr>
        <td style="color:var(--cyan);">${escapeHtml(t.id)}</td>
        <td>${escapeHtml(t.process)}</td>
        <td>${escapeHtml(t.threadName)}</td>
        <td><strong>${t.priority}${escapeHtml(t.policyCode)}</strong> <span style="color:var(--text-2);font-size:10.5px;">${escapeHtml(t.policy.replace('SCHED_', ''))}</span></td>
        <td><span class="state-pill state-${escapeHtml(t.state)}">${escapeHtml(t.state)}</span></td>
        <td style="color:${t.blockedOn ? '#fbbf24' : 'var(--text-2)'};">${escapeHtml(t.blockedOn ? t.blockedOn.raw : '-')}</td>
      </tr>
    `
    )
    .join('');
}

function renderPps(report) {
  const grid = el('ppsGrid');
  if (!report.ppsObjects.length) {
    grid.innerHTML = '<div style="color:var(--text-2);">No /pps/ objects present in this capture.</div>';
    return;
  }

  grid.innerHTML = report.ppsObjects
    .map((obj) => {
      const attrs = Object.values(obj.attributes)
        .map((a) => {
          const valText = typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value);
          const isAlert =
            valText.includes('DEGRADED') ||
            valText.includes('INVERSION') ||
            (a.key === 'inversion_detected' && a.value === true);
          return `
            <div class="pps-attr-row">
              <span class="pps-key">${escapeHtml(a.key)}<span class="pps-enc">${escapeHtml(a.encoding)}</span></span>
              <span class="pps-val ${isAlert ? 'alert' : ''}">${escapeHtml(valText)}</span>
            </div>
          `;
        })
        .join('');

      return `
        <div class="pps-card">
          <div class="pps-card-head">
            <span>${escapeHtml(obj.path)}</span>
            <span style="color:var(--text-2);font-size:10.5px;">${Object.keys(obj.attributes).length} attrs</span>
          </div>
          <div>${attrs}</div>
        </div>
      `;
    })
    .join('');
}

function runAnalysis() {
  currentReport = analyzeCapture(currentBundle, { deadlineUs: currentDeadlineUs });

  el('scenarioTitle').textContent = currentReport.meta?.name || 'Custom QNX 8.0 Capture';
  el('scenarioDesc').textContent =
    PRESETS[currentPresetId]?.description ||
    'Live analysis of user-imported QNX 8.0 slog2, pidin, traceprinter, and /pps/ diagnostic streams.';
  el('scenarioTarget').textContent = currentReport.meta?.target || 'x86_64-neutrino-8.0';

  renderKpis(currentReport);
  renderSvgTimeline(currentReport);
  renderFindings(currentReport);
  renderSlog2(currentReport);
  renderPidin(currentReport);
  renderPps(currentReport);
}

function setupInteractions() {
  // Preset switcher
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-preset');
      if (!PRESETS[id]) return;
      currentPresetId = id;
      currentBundle = PRESETS[id];
      document.querySelectorAll('.preset-btn').forEach((b) => b.classList.toggle('active', b === btn));
      runAnalysis();
    });
  });

  // Deadline threshold slider
  const slider = el('deadlineSlider');
  slider.addEventListener('input', () => {
    currentDeadlineUs = Number.parseInt(slider.value, 10);
    el('deadlineValue').textContent = `${currentDeadlineUs} us`;
    runAnalysis();
  });

  // slog2 filters
  el('slogSeverityFilter').addEventListener('change', () => renderSlog2(currentReport));
  el('slogSearch').addEventListener('input', () => renderSlog2(currentReport));

  // Diagnostic view tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.getAttribute('data-view');
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      const grid = el('diagGrid');
      const pSlog = el('paneSlog2');
      const pPidin = el('panePidin');
      const pPps = el('panePps');

      if (view === 'all') {
        grid.classList.remove('single-col');
        pSlog.classList.remove('hidden');
        pPidin.classList.remove('hidden');
        pPps.classList.remove('hidden');
      } else {
        grid.classList.add('single-col');
        pSlog.classList.toggle('hidden', view !== 'slog2');
        pPidin.classList.toggle('hidden', view !== 'pidin');
        pPps.classList.toggle('hidden', view !== 'pps');
      }
    });
  });

  // Export buttons
  el('btnExportJson').addEventListener('click', () => {
    downloadFile(`qnx-pulse-audit-${currentPresetId}.json`, formatJsonReport(currentReport), 'application/json');
  });
  el('btnExportMd').addEventListener('click', () => {
    downloadFile(`qnx-pulse-audit-${currentPresetId}.md`, formatMarkdownReport(currentReport), 'text/markdown');
  });

  // Custom Capture Importer
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
    document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
    currentBundle = {
      meta: { name: 'Custom Imported QNX 8.0 Bundle', target: 'x86_64-neutrino-8.0 (Custom)' },
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
    document
      .querySelectorAll('.preset-btn')
      .forEach((b) => b.classList.toggle('active', b.getAttribute('data-preset') === urlPreset));
  }
}

setupInteractions();
runAnalysis();
