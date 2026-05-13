#!/usr/bin/env bun
// Playwright 1.60 lazy-requires chromium-bidi CJS paths that only exist
// in older package versions. The BiDi code path is never reached (we use CDP),
// but Bun's bundler resolves all require() calls statically.
// These stubs satisfy the bundler without affecting runtime behaviour.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const stubs: [string, string][] = [
  [
    'node_modules/chromium-bidi/lib/cjs/bidiMapper/BidiMapper.js',
    '"use strict";\nmodule.exports = {};',
  ],
  [
    'node_modules/chromium-bidi/lib/cjs/cdp/CdpConnection.js',
    '"use strict";\nmodule.exports = {};',
  ],
];

for (const [filePath, content] of stubs) {
  if (!existsSync(filePath)) {
    const dir = filePath.split('/').slice(0, -1).join('/');
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content);
    console.log(`  created stub: ${filePath}`);
  }
}
