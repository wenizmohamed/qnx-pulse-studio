#!/usr/bin/env node
/**
 * QNX Pulse Studio - Headless Playwright E2E Verification & Screenshot Capture
 * Verifies 0 console errors, 0 page errors, 0px horizontal overflow on desktop (1440) & mobile (390)
 * for both `/` and `/codelab.html`, and captures 4 crisp PNGs into `assets/`.
 *
 * Run with:
 *   set NODE_PATH=C:\Users\user\.claude\mostaql\torn-zone\zone-devvit\node_modules
 *   node scripts/e2e-verify.mjs
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

    results.homeDesktopOverflow = await checkOverflow(page);

    // Verify capture selector switch (clean -> inversion)
    await page.selectOption('#captureSelect', 'surgical-arm-clean');
    const cleanBadge = await page.textContent('#verdictBadge');
    if (!cleanBadge.toLowerCase().includes('exit 0')) {
      throw new Error(`Expected exit 0 on surgical-arm-clean, got: ${cleanBadge}`);
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

    // Switch back to brake-ecu-inversion
    await page.selectOption('#captureSelect', 'brake-ecu-inversion');
    const failBadge = await page.textContent('#verdictBadge');
    if (!failBadge.toLowerCase().includes('exit 2')) {
      throw new Error(`Expected exit 2 on brake-ecu-inversion, got: ${failBadge}`);
    }
    results.presetSwitchOk = true;

    // Click inversion band to populate statusbar readout
    const firstHit = page.locator('#timelineSvg .svg-hit').first();
    await firstHit.dispatchEvent('click');

    // Screenshot 1: Full Workbench with Trace Timeline + Findings Table (1440x900)
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(ASSETS_DIR, 'screen_1_ipc_timeline.png'), fullPage: false });

    // Thumbnail: 1280x720 crisp Perfetto/Wireshark overview
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
    results.codelabDesktopOverflow = await checkOverflow(page);

    // Interact with checklist & verify progress
    await page.click('[data-toggle-step="1"]');
    await page.click('[data-toggle-step="2"]');
    const progressText = await page.textContent('#progressLabel');
    if (!progressText.includes('2 of 7')) {
      throw new Error(`Expected codelab progress '2 of 7', got: ${progressText}`);
    }
    results.codelabChecklistOk = true;

    // Screenshot 3: `/codelab.html` showing left sidebar + Step 6 & Step 7 Before/After Diff & comparison table
    await page.evaluate(() => {
      const el = document.getElementById('step-6');
      if (el) window.scrollTo(0, el.offsetTop - 48);
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
