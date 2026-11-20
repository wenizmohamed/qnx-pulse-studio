#!/usr/bin/env node
/**
 * QNX Pulse Studio - Headless Playwright E2E Verification & Screenshot Capture
 * Verifies 0 console errors, 0 page errors, 0px horizontal overflow on desktop (1440) & mobile (390),
 * all 4 Google Fonts loaded, live Scrub button, Compare Before/After PI Fix toggle, inspector tabs,
 * and Codelab checklist, and captures 4 crisp PNGs into `assets/`.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const ASSETS_DIR = path.join(ROOT, 'assets');
fs.mkdirSync(ASSETS_DIR, { recursive: true });

const REQUIRED_FONTS = ['Space Grotesk', 'Instrument Serif', 'Instrument Sans', 'JetBrains Mono'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const full = path.resolve(PUBLIC_DIR, rel);
      if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(full).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function checkOverflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    overflowPx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
  }));
}

async function checkFontsLoaded(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return page.evaluate((families) => {
    const loaded = new Set();
    for (const f of document.fonts) {
      if (f.status === 'loaded') {
        loaded.add(f.family.replace(/^["']|["']$/g, ''));
      }
    }
    return {
      loadedFamilies: Array.from(loaded),
      missingFamilies: families.filter((fam) => !loaded.has(fam))
    };
  }, REQUIRED_FONTS);
}

function findChromiumExecutable() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(base)) return undefined;
  const dirs = fs
    .readdirSync(base)
    .filter((d) => d.startsWith('chromium_headless_shell-') || d.startsWith('chromium-'))
    .sort()
    .reverse();
  for (const d of dirs) {
    const candidates = [
      path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
      path.join(base, d, 'chrome-win64', 'chrome.exe'),
      path.join(base, d, 'chrome-win', 'chrome.exe')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return undefined;
}

async function main() {
  const { server, baseUrl } = await startStaticServer();
  const executablePath = findChromiumExecutable();
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

  const consoleErrors = [];
  const pageErrors = [];
  const results = {};

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    // 1. Desktop `/` verification
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#timelineSvg rect');
    results.homeFonts = await checkFontsLoaded(page);
    if (results.homeFonts.missingFamilies.length > 0) {
      throw new Error(`Missing Google Fonts on /: ${results.homeFonts.missingFamilies.join(', ')}`);
    }

    results.homeDesktopOverflow = await checkOverflow(page);

    // Verify new Rank-#1 Multi-Hop PI Blocking Tree, SMP Core View, & Deadline Margin Histogram on adas-multihop-pi
    await page.selectOption('#captureSelect', 'adas-multihop-pi');
    const mhBadge = await page.textContent('#verdictBadge');
    const mhJitter = await page.textContent('#numMaxJitter');
    if (!mhBadge.toLowerCase().includes('exit 2') || !mhJitter.includes('2240')) {
      throw new Error(`adas-multihop-pi failed: badge=${mhBadge}, jitter=${mhJitter}`);
    }

    // Toggle SMP Core Affinity View on the obsidian oscilloscope
    await page.click('#btnSmpLaneMode');
    const smpPressed = await page.getAttribute('#btnSmpLaneMode', 'aria-pressed');
    if (smpPressed !== 'true') {
      throw new Error(`Expected #btnSmpLaneMode aria-pressed=true, got ${smpPressed}`);
    }
    await page.click('#btnSmpLaneMode');
    results.smpCoreViewToggleOk = true;

    // Verify Interactive Multi-Hop PI Blocking Tree SVG & WCBL panel
    await page.click('#tabPiTree');
    const piNodes = await page.locator('#piTreeSvg .pi-hit').count();
    const wcblText = await page.textContent('#piWcblSummary');
    if (piNodes < 5 || !wcblText.includes('145µs')) {
      throw new Error(`PI Blocking Tree verification failed: nodes=${piNodes}, wcbl=${wcblText}`);
    }
    await page.locator('#piTreeSvg .pi-hit').first().click();
    const piInspText = await page.textContent('#piTreeInspector');
    if (!piInspText || piInspText.includes('Click any thread node')) {
      throw new Error(`PI Blocking Tree click inspection did not update: ${piInspText}`);
    }
    await page.evaluate(() => {
      const sec = document.getElementById('diagnosticsSection');
      if (sec) sec.scrollIntoView({ block: 'start' });
    });
    await page.screenshot({ path: path.join(ASSETS_DIR, 'screen_4_multihop_pi.png'), fullPage: false });
    results.piBlockingTreeOk = { hitNodes: piNodes };

    // Verify 4-Core SMP Utilization + Deadline Margin Histogram + Affinity Table
    await page.click('#tabSmp');
    const coreTiles = await page.locator('#smpCoreGrid .smp-core-tile').count();
    const histBars = await page.locator('#marginHistogramSvg rect').count();
    const smpRows = await page.locator('#smpAffinityBody tr').count();
    if (coreTiles !== 4 || histBars < 5 || smpRows < 5) {
      throw new Error(`SMP & Margins verification failed: cores=${coreTiles}, histRects=${histBars}, rows=${smpRows}`);
    }
    results.smpAndMarginsOk = { coreTiles, histBars, smpRows };

    // Verify mobile 390px overflow on adas-multihop-pi with PI Tree & SMP tabs open!
    await page.setViewportSize({ width: 390, height: 844 });
    results.smpMobileOverflow = await checkOverflow(page);
    await page.click('#tabPiTree');
    results.piTreeMobileOverflow = await checkOverflow(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // Switch back to brake-ecu-inversion for remaining checks & screenshots
    await page.selectOption('#captureSelect', 'brake-ecu-inversion');
    await page.click('#tabFindings');

    // Verify 1-click Compare Before vs After PI Fix toggle
    await page.click('#btnComparePi');
    const cleanBadge = await page.textContent('#verdictBadge');
    const cleanJitter = await page.textContent('#numMaxJitter');
    if (!cleanBadge.toLowerCase().includes('exit 0') || !cleanJitter.includes('112.6')) {
      throw new Error(`Compare PI Fix failed: badge=${cleanBadge}, jitter=${cleanJitter}`);
    }

    // Verify deadline budget edit updates status
    await page.fill('#deadlineInput', '100');
    await page.dispatchEvent('#deadlineInput', 'input');
    const tightBadge = await page.textContent('#verdictBadge');
    if (!tightBadge.toLowerCase().includes('exit 2')) {
      throw new Error(`Expected exit 2 when deadline is tightened to 100us, got: ${tightBadge}`);
    }
    await page.fill('#deadlineInput', '500');
    await page.dispatchEvent('#deadlineInput', 'input');
    await page.evaluate(() => document.activeElement?.blur());

    // Toggle back to brake-ecu-inversion via Compare button
    await page.click('#btnComparePi');
    const failBadge = await page.textContent('#verdictBadge');
    const failJitter = await page.textContent('#numMaxJitter');
    if (!failBadge.toLowerCase().includes('exit 2') || !failJitter.includes('1842.4')) {
      throw new Error(`Expected exit 2 / 1842.4us after toggling back, got: ${failBadge} / ${failJitter}`);
    }
    results.comparePiToggleOk = true;

    // Verify live Scrub button advances cursor and updates readout
    const initialScrub = await page.textContent('#scrubTimeReadout');
    await page.click('#btnScrubPlay');
    await page.waitForTimeout(320);
    await page.click('#btnScrubPlay');
    const movedScrub = await page.textContent('#scrubTimeReadout');
    if (movedScrub === initialScrub) {
      throw new Error(`Scrub playback did not advance cursor: stayed at ${movedScrub}`);
    }
    results.scrubOk = { from: initialScrub, to: movedScrub };

    // Position scrub cursor inside inversion window (890us) for crisp screenshot framing
    await page.fill('#scrubSlider', '890');
    await page.dispatchEvent('#scrubSlider', 'input');

    // Screenshot 1: Full Workbench with Obsidian Oscilloscope + Findings Table (1440x900)
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(ASSETS_DIR, 'screen_1_ipc_timeline.png'), fullPage: false });

    // Thumbnail: 1280x720 crisp Swiss studio overview
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(ASSETS_DIR, 'thumbnail.png'), fullPage: false });

    // Verify all inspector tabs and capture Screen 2 on slog2info tab (1440x900)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click('#tabPidin');
    const pidinRows = await page.locator('#pidinBody tr').count();
    if (pidinRows < 5) throw new Error(`Expected >= 5 pidin rows, got ${pidinRows}`);

    await page.click('#tabPps');
    const ppsRows = await page.locator('#ppsBody tr').count();
    if (ppsRows < 5) throw new Error(`Expected >= 5 /pps rows, got ${ppsRows}`);

    await page.click('#tabCli');
    const cliBlocks = await page.locator('#cliPane .cli-row').count();
    if (cliBlocks < 3) throw new Error(`Expected >= 3 CLI blocks, got ${cliBlocks}`);

    await page.click('#tabSlog2');
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(240);
    const slogRows = await page.locator('#slogBody tr').count();
    if (slogRows < 5) throw new Error(`Expected >= 5 slog2 rows, got ${slogRows}`);
    results.inspectorTabsOk = true;

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(ASSETS_DIR, 'screen_2_slog2_pps.png'), fullPage: false });

    // 2. Mobile 390px `/` overflow check
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#tabFindings');
    await page.evaluate(() => window.scrollTo(0, 0));
    results.homeMobileOverflow = await checkOverflow(page);

    // 3. Desktop `/codelab.html` verification
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/codelab.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#step-7');
    results.codelabFonts = await checkFontsLoaded(page);
    if (results.codelabFonts.missingFamilies.length > 0) {
      throw new Error(`Missing Google Fonts on /codelab.html: ${results.codelabFonts.missingFamilies.join(', ')}`);
    }

    results.codelabDesktopOverflow = await checkOverflow(page);

    // Interact with checklist & verify progress
    await page.click('[data-toggle-step="1"]');
    await page.click('[data-toggle-step="2"]');
    const progressText = await page.textContent('#progressLabel');
    if (!progressText.includes('2 of 7')) {
      throw new Error(`Expected codelab progress '2 of 7', got: ${progressText}`);
    }
    results.codelabChecklistOk = true;

    // Verify diff mode switcher
    await page.click('.diff-mode-btn[data-diff="before"]');
    await page.click('.diff-mode-btn[data-diff="after"]');
    await page.click('.diff-mode-btn[data-diff="split"]');
    results.diffSwitcherOk = true;

    // Screenshot 3: `/codelab.html` showing sticky ceramic sidebar + Step 6 & Step 7 Before/After Diff & comparison table
    await page.evaluate(() => {
      const el = document.getElementById('step-6');
      if (el) window.scrollTo(0, el.offsetTop - 20);
    });
    await page.screenshot({ path: path.join(ASSETS_DIR, 'screen_3_codelab.png'), fullPage: false });

    // 4. Mobile 390px `/codelab.html` overflow check
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    results.codelabMobileOverflow = await checkOverflow(page);

    results.consoleErrors = consoleErrors;
    results.pageErrors = pageErrors;

    console.log(JSON.stringify(results, null, 2));

    const hasOverflow =
      results.homeDesktopOverflow.overflowPx > 0 ||
      results.homeMobileOverflow.overflowPx > 0 ||
      results.smpMobileOverflow.overflowPx > 0 ||
      results.piTreeMobileOverflow.overflowPx > 0 ||
      results.codelabDesktopOverflow.overflowPx > 0 ||
      results.codelabMobileOverflow.overflowPx > 0;

    if (consoleErrors.length > 0 || pageErrors.length > 0 || hasOverflow) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
