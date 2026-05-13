#!/usr/bin/env bun
// Prebuild patches for `bun build --compile`.
//
// Bun's bundler statically resolves require() and require.resolve() calls. For
// modules that look up files via __dirname or require.resolve("…/package.json"),
// the build-time absolute path gets baked into the binary — and then fails at
// runtime because the binary lives in /$bunfs/root/, not the original
// node_modules path.
//
// We patch two classes of issues here:
//
//   1. `chromium-bidi` — lazy-required by Playwright but its BiDi code path is
//      never reached (we use CDP). Bun's bundler still tries to follow the
//      require() calls. Stub out the entry points with empty modules.
//
//   2. `playwright-core/package.json` lookups. There are 5 places:
//      - playwright-core/lib/package.js loads it via __dirname (used for
//        packageJSON.version, packageRoot, binPath, libPath).
//      - playwright/lib/{util.js,common/index.js,transform/esmLoader.js,
//        worker/workerProcessEntry.js} call require.resolve("playwright-core/
//        package.json") purely for stack-trace filtering.
//
//      We inline the JSON content into package.js and replace the
//      require.resolve() calls with a non-matching sentinel string.
//
// All patches are idempotent: a marker comment is written so reruns are no-ops.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

const MARKER = '/* drift-prebuild-patched */';

// ── 1. chromium-bidi stubs ───────────────────────────────────────────────────

const bidiStubs: [string, string][] = [
  ['node_modules/chromium-bidi/lib/cjs/bidiMapper/BidiMapper.js', '"use strict";\nmodule.exports = {};'],
  ['node_modules/chromium-bidi/lib/cjs/cdp/CdpConnection.js', '"use strict";\nmodule.exports = {};'],
];

for (const [filePath, content] of bidiStubs) {
  if (existsSync(filePath)) continue;
  const dir = filePath.split('/').slice(0, -1).join('/');
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content);
  console.log(`  created stub: ${filePath}`);
}

// ── 2. Inline playwright-core package.json ───────────────────────────────────

const corePackageJsonPath = 'node_modules/playwright-core/package.json';
const corePackageJsPath = 'node_modules/playwright-core/lib/package.js';

if (existsSync(corePackageJsonPath) && existsSync(corePackageJsPath)) {
  const current = readFileSync(corePackageJsPath, 'utf-8');
  if (!current.startsWith(MARKER)) {
    const pkg = JSON.parse(readFileSync(corePackageJsonPath, 'utf-8'));
    const patched = `${MARKER}
"use strict";
const path = require("path");
const packageJSON = ${JSON.stringify(pkg)};
const packageRoot = path.join(__dirname, "..");
const binPath = path.join(packageRoot, "bin");
function libPath(...parts) { return path.join(packageRoot, "lib", ...parts); }
module.exports = { packageJSON, packageRoot, binPath, libPath };
`;
    writeFileSync(corePackageJsPath, patched);
    console.log(`  inlined packageJSON: ${corePackageJsPath}`);
  }
}

// ── 3. Remove require.resolve("playwright-core/package.json") in playwright/* ─

const stackFilterTargets = [
  'node_modules/playwright/lib/util.js',
  'node_modules/playwright/lib/common/index.js',
  'node_modules/playwright/lib/transform/esmLoader.js',
  'node_modules/playwright/lib/worker/workerProcessEntry.js',
];

const STACK_FILTER_NEEDLE = 'require.resolve("playwright-core/package.json")';
const STACK_FILTER_REPLACEMENT = '"\\0playwright-core-unresolved"';

for (const filePath of stackFilterTargets) {
  if (!existsSync(filePath)) continue;
  const source = readFileSync(filePath, 'utf-8');
  if (source.includes(MARKER)) continue;
  if (!source.includes(STACK_FILTER_NEEDLE)) continue;
  const patched = MARKER + '\n' + source.replaceAll(STACK_FILTER_NEEDLE, STACK_FILTER_REPLACEMENT);
  writeFileSync(filePath, patched);
  console.log(`  patched stack filter: ${filePath}`);
}
