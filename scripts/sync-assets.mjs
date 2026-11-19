#!/usr/bin/env node
/**
 * Syncs canonical `src/{parsers,analyzer,presets}.js` into `public/engine/`
 * and writes realistic QNX 8.0 sample capture bundles into `samples/`.
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS } from '../src/presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const engineFiles = ['parsers.js', 'analyzer.js', 'presets.js'];
const publicEngineDir = path.join(ROOT, 'public', 'engine');
fs.mkdirSync(publicEngineDir, { recursive: true });

for (const file of engineFiles) {
  fs.copyFileSync(path.join(ROOT, 'src', file), path.join(publicEngineDir, file));
}

for (const [id, preset] of Object.entries(PRESETS)) {
  const sampleDir = path.join(ROOT, 'samples', id);
  fs.mkdirSync(sampleDir, { recursive: true });
  fs.writeFileSync(path.join(sampleDir, 'pidin.txt'), preset.pidin + '\n', 'utf8');
  fs.writeFileSync(path.join(sampleDir, 'slog2.log'), preset.slog2 + '\n', 'utf8');
  fs.writeFileSync(path.join(sampleDir, 'trace.csv'), preset.trace + '\n', 'utf8');
  fs.writeFileSync(path.join(sampleDir, 'pps_telemetry.pps'), preset.pps + '\n', 'utf8');
}

console.log(`Synced ${engineFiles.length} engine modules -> public/engine/ and ${Object.keys(PRESETS).length} sample bundles -> samples/`);
