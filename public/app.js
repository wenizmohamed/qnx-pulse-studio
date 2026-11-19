import { analyzeCapture, formatJsonReport, formatMarkdownReport } from './engine/analyzer.js';
import { PRESETS } from './engine/presets.js';

const STATE_COLORS = {
  RUNNING: '#3FB950',
  PI_BOOST: '#2F9E8F',
  MUTEX: '#D94848',
  REPLY: '#D29922',
  SEND: '#D29922',
  RECEIVE: '#4C9AFF',
  READY: '#6E7681',
  SLEEP: '#2A3038'
};

const STATE_TEXT_COLORS = {
  RUNNING: '#0C1116',
  PI_BOOST: '#0C1116',
  MUTEX: '#FFF5F5',
  REPLY: '#0C1116',
  SEND: '#0C1116',
  RECEIVE: '#0C1116',
  READY: '#E6EDF3',
  SLEEP: '#8B949E'
};

let currentBundle = PRESETS['brake-ecu-inversion'];
let currentPresetId = 'brake-ecu-inversion';
let currentDeadlineUs = 500;
let currentReport = null;
let activeTab = 'findings';

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

function renderSummary(report) {
  const badge = el('verdictBadge');
  if (report.status === 'PASS') {
    badge.className = 'status-chip status-pass';
    badge.textContent = `PASS exit 0 · max ${report.jitterStats.maxUs}µs`;
  } else {
    badge.className = 'status-chip status-fail';
    badge.textContent = `FAIL exit ${report.exitCode} · max ${report.jitterStats.maxUs}µs`;
  }

  el('sumTarget').textContent = report.meta?.target || 'x86_64-neutrino-8.0 (procnto-smp-instr)';
  el('sumThreads').textContent = `${report.summary.totalThreads} (${report.summary.fifoThreads} FIFO)`;

  const jitEl = el('sumJitter');
  jitEl.textContent = `${report.jitterStats.maxUs}µs`;
  jitEl.className = `sum-v ${report.jitterStats.maxUs > report.options.deadlineUs ? 'is-bad' : 'is-ok'}`;

  const invEl = el('sumInversions');
  if (report.summary.priorityInversions > 0) {
    const peakUs = report.inversionBands[0]?.durationUs ?? 0;
    invEl.textContent = `${report.summary.priorityInversions} (${peakUs}µs)`;
    invEl.className = 'sum-v is-bad';
  } else {
    invEl.textContent = '0';
    invEl.className = 'sum-v is-ok';
  }

  const blkEl = el('sumBlocked');
  blkEl.textContent = String(report.summary.ipcBlockChains);
  blkEl.className = `sum-v ${report.summary.ipcBlockChains > 0 ? 'is-warn' : 'is-ok'}`;

  const stEl = el('sumStarved');
  stEl.textContent = String(report.summary.starvedThreads);
  stEl.className = `sum-v ${report.summary.starvedThreads > 0 ? 'is-warn' : 'is-ok'}`;
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
  const laneH = 42;
  const bottomPad = 10;
  const plotW = width - leftPad - rightPad;
  const height = Math.max(220, topPad + lanes.length * laneH + bottomPad);

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  el('timelineMeta').textContent = `${lanes.length} threads · ${duration}µs window · ${report.ipcEdges.length} IPC`;

  const xOf = (us) => leftPad + (Math.max(0, Math.min(duration, us)) / duration) * plotW;
  const yOfLane = (idx) => topPad + idx * laneH;

  const laneIndex = new Map();
  lanes.forEach((l, i) => laneIndex.set(l.id, i));

  let markup = `
    <defs>
      <pattern id="invHatch" width="8" height="8" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
        <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(217,72,72,0.22)" stroke-width="1.5" />
      </pattern>
      <marker id="arrowSend" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
        <path d="M 0 1 L 8 4 L 0 7 z" fill="#D29922" />
      </marker>
      <marker id="arrowReply" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
        <path d="M 0 1 L 8 4 L 0 7 z" fill="#3FB950" />
      </marker>
      <marker id="arrowPulse" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
        <path d="M 0 1 L 8 4 L 0 7 z" fill="#4C9AFF" />
      </marker>
    </defs>

    <!-- Canvas & Perfetto-style Left Track Gutter + Top Ruler -->
    <rect x="0" y="0" width="${width}" height="${height}" fill="#121417" />
    <rect x="0" y="0" width="${leftPad}" height="${height}" fill="#181B20" />
    <rect x="0" y="0" width="${width}" height="${rulerH}" fill="#181B20" />
    <line x1="0" y1="${rulerH}" x2="${width}" y2="${rulerH}" stroke="#262B33" stroke-width="1" />
    <line x1="${leftPad}" y1="0" x2="${leftPad}" y2="${height}" stroke="#262B33" stroke-width="1" />
    <text x="10" y="17" fill="#8B949E" font-family="monospace" font-size="10.5" font-weight="600">PRIO  THREAD (PID:TID)</text>
  `;

  // Vertical hairline gridlines & ruler ticks in us
  const tickCount = 10;
  for (let i = 0; i <= tickCount; i++) {
    const us = Math.round((duration / tickCount) * i);
    const x = xOf(us);
    const anchor = i === 0 ? 'start' : i === tickCount ? 'end' : 'middle';
    const labelX = i === 0 ? x + 2 : i === tickCount ? x - 2 : x;

    markup += `<line x1="${x.toFixed(1)}" y1="${rulerH}" x2="${x.toFixed(1)}" y2="${height - bottomPad}" stroke="#1E232A" stroke-width="1" />`;
    markup += `<line x1="${x.toFixed(1)}" y1="${rulerH - 5}" x2="${x.toFixed(1)}" y2="${rulerH}" stroke="#485261" stroke-width="1" />`;
    markup += `<text x="${labelX.toFixed(1)}" y="${rulerH - 9}" fill="#8B949E" font-family="monospace" font-size="10" text-anchor="${anchor}">${us}µs</text>`;
  }

  // Priority Inversion vertical band
  for (const inv of report.inversionBands) {
    const x1 = xOf(inv.startUs);
    const x2 = xOf(inv.endUs);
    const w = Math.max(4, x2 - x1);
    const bandH = lanes.length * laneH;
    const labelW = Math.min(Math.max(w, 240), 300);
    const tip = escapeHtml(
      `PRIORITY INVERSION (${inv.durationUs}µs): ${inv.highThread.name}[${inv.highThread.prio}f] blocked on ${inv.lowOwner.name}[${inv.lowOwner.prio}f] while ${inv.mediumThread.name}[${inv.mediumThread.prio}f] ran on CPU${inv.cpu}`
    );
    markup += `
      <g class="svg-hit" data-tip="${tip}" style="cursor:pointer;">
        <rect x="${x1.toFixed(1)}" y="${topPad}" width="${w.toFixed(1)}" height="${bandH}" fill="rgba(217,72,72,0.10)" />
        <rect x="${x1.toFixed(1)}" y="${topPad}" width="${w.toFixed(1)}" height="${bandH}" fill="url(#invHatch)" />
        <line x1="${x1.toFixed(1)}" y1="${rulerH}" x2="${x1.toFixed(1)}" y2="${topPad + bandH}" stroke="#D94848" stroke-width="1" stroke-dasharray="3 2" />
        <line x1="${x2.toFixed(1)}" y1="${rulerH}" x2="${x2.toFixed(1)}" y2="${topPad + bandH}" stroke="#D94848" stroke-width="1" stroke-dasharray="3 2" />
        <rect x="${x1.toFixed(1)}" y="${rulerH + 1}" width="${labelW.toFixed(1)}" height="16" rx="1" fill="#3B1A1E" stroke="#D94848" stroke-width="0.8" />
        <text x="${(x1 + 6).toFixed(1)}" y="${rulerH + 12}" fill="#F07171" font-family="monospace" font-size="10" font-weight="600">INVERSION ${inv.durationUs}µs (p${inv.highThread.prio} stalled by p${inv.mediumThread.prio})</text>
      </g>
    `;
  }

  // Thread lanes and execution segments
  lanes.forEach((lane, idx) => {
    const y = yOfLane(idx);
    const midY = y + laneH / 2;

    if (idx % 2 === 1) {
      markup += `<rect x="${leftPad + 1}" y="${y}" width="${width - leftPad - 1}" height="${laneH}" fill="rgba(255,255,255,0.012)" />`;
    }
    markup += `<line x1="0" y1="${y + laneH}" x2="${width}" y2="${y + laneH}" stroke="#262B33" stroke-width="1" />`;

    // Left track header
    const prioBorder = lane.priority >= 55 ? '#4C9AFF' : lane.priority >= 35 ? '#D29922' : '#485261';
    const prioText = lane.priority >= 55 ? '#8FC1FF' : lane.priority >= 35 ? '#E3B341' : '#8B949E';
    markup += `
      <rect x="8" y="${y + 9}" width="34" height="19" rx="2" fill="#121417" stroke="${prioBorder}" stroke-width="0.9" />
      <text x="25" y="${y + 22}" fill="${prioText}" font-family="monospace" font-size="10.5" font-weight="600" text-anchor="middle">${lane.priority}f</text>
      <text x="50" y="${y + 17}" fill="#E6EDF3" font-family="monospace" font-size="11.5" font-weight="600">${escapeHtml(lane.threadName.slice(0, 18))}</text>
      <text x="50" y="${y + 30}" fill="#8B949E" font-family="monospace" font-size="9.5">${lane.pid}:${lane.tid}</text>
    `;

    // Execution bars (flat Perfetto style, 1px radius)
    for (const seg of lane.segments) {
      const sx = xOf(seg.startUs);
      const ex = xOf(seg.endUs);
      const sw = Math.max(2, ex - sx);
      const fill = STATE_COLORS[seg.state] || '#6E7681';
      const txtColor = STATE_TEXT_COLORS[seg.state] || '#E6EDF3';
      const tip = escapeHtml(
        `${lane.threadName} (${lane.id}, ${seg.prio}f) | ${seg.state} | ${seg.startUs}µs..${seg.endUs}µs (${seg.durationUs}µs) | CPU${seg.cpu}${seg.detail ? ' | ' + seg.detail : ''}`
      );
      const barH = 20;
      const barY = midY - barH / 2;
      const label = `${seg.state} ${seg.durationUs}µs`;
      const fitsFull = sw > label.length * 6.2 + 10;
      const fitsShort = !fitsFull && sw > 36;

      markup += `
        <g class="svg-hit" data-tip="${tip}" style="cursor:pointer;">
          <rect x="${sx.toFixed(1)}" y="${barY.toFixed(1)}" width="${sw.toFixed(1)}" height="${barH}" rx="1" fill="${fill}" stroke="#121417" stroke-width="0.8" />
          ${
            fitsFull
              ? `<text x="${(sx + 5).toFixed(1)}" y="${(midY + 3.5).toFixed(1)}" fill="${txtColor}" font-family="monospace" font-size="9.5" font-weight="600">${escapeHtml(label)}</text>`
              : fitsShort
                ? `<text x="${(sx + 4).toFixed(1)}" y="${(midY + 3.5).toFixed(1)}" fill="${txtColor}" font-family="monospace" font-size="9" font-weight="600">${seg.durationUs}µs</text>`
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
    const stroke = edge.kind === 'PULSE' ? '#4C9AFF' : edge.kind === 'REPLY' ? '#3FB950' : '#D29922';
    const marker = edge.kind === 'PULSE' ? 'url(#arrowPulse)' : edge.kind === 'REPLY' ? 'url(#arrowReply)' : 'url(#arrowSend)';
    const dash = edge.kind === 'PULSE' ? '3 2' : '';
    const tip = escapeHtml(
      `IPC ${edge.kind} @ ${edge.timeUs}µs | ${edge.fromName} (${edge.fromId}) -> ${edge.toName} (${edge.toId})${edge.detail ? ' | ' + edge.detail : ''}`
    );

    markup += `
      <g class="svg-hit" data-tip="${tip}" style="cursor:pointer;">
        <line x1="${x.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="1.5" ${dash ? `stroke-dasharray="${dash}"` : ''} marker-end="${marker}" />
        <circle cx="${x.toFixed(1)}" cy="${y1.toFixed(1)}" r="2.2" fill="${stroke}" />
      </g>
    `;
  }

  svg.innerHTML = markup;

  const inspector = el('timelineInspector');
  svg.querySelectorAll('.svg-hit').forEach((node) => {
    const show = () => {
      inspector.innerHTML = `<span>${node.getAttribute('data-tip')}</span><span class="status-right">clock: SYSPAGE(qtime)</span>`;
    };
    node.addEventListener('mouseenter', show);
    node.addEventListener('click', show);
  });
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
        <td class="col-wrap">${escapeHtml(f.title)}</td>
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
          <td class="col-nowrap">${escapeHtml(t.threadName)}</td>
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
        <td class="col-nowrap">${escapeHtml(r.key)}</td>
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
      label: 'Run host CLI audit (returns exit 0 on PASS, exit 2 on RT violation)',
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
          <button class="tb-btn cli-copy-btn" data-cli-idx="${idx}" type="button">Copy</button>
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
  if (sel.value !== id) sel.value = id;
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
      meta: { name: 'Custom QNX 8.0 Capture', target: 'x86_64-neutrino-8.0 (custom)' },
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
