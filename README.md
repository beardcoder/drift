# drift

[![CI](https://github.com/beardcoder/drift/actions/workflows/ci.yml/badge.svg)](https://github.com/beardcoder/drift/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/beardcoder/drift)](https://github.com/beardcoder/drift/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Crawl two websites and compare them for regressions — built for **build-tool migrations** (webpack → vite), refactors, and deployments where you need confidence nothing broke.

Both sites are crawled with a headless Chromium browser. Each matching page is compared for:

- **JavaScript console errors** (new errors = critical)
- **Failed network requests** — broken scripts, stylesheets, missing assets
- **HTTP status changes** — 200 → 404, redirects added/removed
- **Page title and H1 headings**
- **Internal link changes** — links removed are flagged as warnings
- **Word count drift** — > 20 % change triggers an info notice
- **Visual diff** — full-page screenshots compared with pixelmatch *(optional, `--screenshot`)*

Results are printed to the terminal and optionally written as a **self-contained HTML report** with an interactive A↔B slider and a pixel-diff view.

---

## Installation

### Download binary (no Bun required)

Grab the latest binary for your platform from the [releases page](https://github.com/beardcoder/drift/releases/latest):

```bash
# macOS (Apple Silicon)
curl -L https://github.com/beardcoder/drift/releases/latest/download/drift-macos-arm64 -o drift
chmod +x drift && sudo mv drift /usr/local/bin/

# macOS (Intel)
curl -L https://github.com/beardcoder/drift/releases/latest/download/drift-macos-x64 -o drift
chmod +x drift && sudo mv drift /usr/local/bin/

# Linux x64
curl -L https://github.com/beardcoder/drift/releases/latest/download/drift-linux-x64 -o drift
chmod +x drift && sudo mv drift /usr/local/bin/
```

**Chromium is required separately** (one-time setup):

```bash
npx playwright install chromium
```

### From source (requires [Bun](https://bun.sh))

```bash
git clone https://github.com/beardcoder/drift
cd drift
bun install
```

Run without building:
```bash
bun run src/index.ts <url-a> <url-b>
```

Build the binary:
```bash
bun run build
```

---

## Usage

```
drift <url-a> <url-b> [options]
```

### Examples

```bash
# webpack dev-server vs. vite dev-server, crawl 3 levels deep
drift http://localhost:8080 http://localhost:5173 --depth 3

# Production comparison with HTML report
drift https://old.example.com https://new.example.com -d 2 -r report.html

# Visual comparison with screenshots (full-page)
drift http://localhost:8080 http://localhost:5173 -s -r report.html

# Only check the homepage
drift http://localhost:8080 http://localhost:5173 -d 0

# Ignore admin area and paginated URLs, cap at 100 pages
drift http://a.local http://b.local -i "^/admin" "\?page=" -m 100
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `-d, --depth <n>` | `2` | Crawl depth (0 = homepage only) |
| `-m, --max-pages <n>` | `200` | Maximum pages per site |
| `-c, --concurrency <n>` | `3` | Parallel browser tabs (1–10) |
| `-s, --screenshot` | off | Take full-page screenshots and compare visually |
| `-t, --diff-threshold <pct>` | `5` | Visual diff tolerance in % (with `--screenshot`) |
| `-i, --ignore <patterns...>` | — | Paths to ignore (RegExp, repeatable) |
| `-r, --report <path>` | — | Save HTML report to file |
| `-o, --output <format>` | `console` | Output format: `console` or `json` |
| `-f, --out-file <path>` | — | Save JSON result to file |
| `--viewport <WxH>` | `1440x900` | Browser viewport size |

---

## HTML Report

Pass `-r report.html` to generate a self-contained report (no external dependencies):

- **Summary bar** with clickable severity filters
- **Per-page cards** showing all differences with before/after values
- **A ↔ B slider** — drag to reveal the old vs. new screenshot side by side
- **Diff view** — pixelmatch output with changed pixels highlighted in red
- **Identical pages** listed in a collapsible section at the bottom

```bash
drift http://localhost:8080 http://localhost:5173 -d 3 -s -r report.html
open report.html
```

---

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | No critical issues found |
| `1` | One or more critical issues (console errors, missing pages, broken assets, status changes) |

Useful for CI pipelines — the build fails when regressions are detected.

---

## CI integration

```yaml
# .github/workflows/regression.yml
- name: Run regression check
  run: |
    npx playwright install chromium --with-deps
    drift ${{ env.OLD_URL }} ${{ env.NEW_URL }} \
      --depth 3 \
      --report regression-report.html

- name: Upload report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: regression-report
    path: regression-report.html
```

---

## How it works

1. **Tab pool** — `--concurrency` browser tabs are opened once and reused across all pages (no cold-start overhead per URL).
2. **Fast crawl** — images, fonts, and media are blocked when screenshots are not requested; `domcontentloaded` is used as the wait condition.
3. **True BFS** — the crawler processes all pages at depth *N* before moving to depth *N+1*, so `--depth` means exactly what it says.
4. **Redirect-aware** — the final URL after redirects is used for page identity, preventing duplicate crawls.

---

## Building from source

```bash
bun run build              # macOS (current arch)
bun run build:linux-x64    # Linux x64 (cross-compile)
bun run build:linux-arm64  # Linux ARM64 (cross-compile)
bun run build:win          # Windows x64 (cross-compile)
bun run build:all          # all except Windows
```

---

## License

[MIT](LICENSE)
