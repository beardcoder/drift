import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type {
  CrawlResult,
  ComparisonReport,
  Difference,
  PageComparison,
  PageData,
} from './types.js';

function arrayDiff(
  a: string[],
  b: string[],
): { added: string[]; removed: string[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  return {
    removed: a.filter((x) => !sb.has(x)),
    added: b.filter((x) => !sa.has(x)),
  };
}

// Scale RGBA pixel data down by integer factor using simple box sampling.
// Reduces a 1440×900 screenshot to 480×300 (factor 3) → 9× fewer pixels → 9× faster pixelmatch.
function scaleDown(src: PNG, factor: number): PNG {
  const w = Math.floor(src.width / factor);
  const h = Math.floor(src.height / factor);
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * src.width + (x * factor + dx)) * 4;
          r += src.data[i]!;
          g += src.data[i + 1]!;
          b += src.data[i + 2]!;
          a += src.data[i + 3]!;
        }
      }
      const f2 = factor * factor;
      const o = (y * w + x) * 4;
      out.data[o] = r / f2;
      out.data[o + 1] = g / f2;
      out.data[o + 2] = b / f2;
      out.data[o + 3] = a / f2;
    }
  }
  return out;
}

const DIFF_MAX_WIDTH = 800;

function visualDiff(
  bufA: Buffer,
  bufB: Buffer,
): { percent: number; diffPng: Buffer | undefined } {
  try {
    let imgA = PNG.sync.read(bufA);
    let imgB = PNG.sync.read(bufB);

    const factor = Math.max(1, Math.floor(imgA.width / DIFF_MAX_WIDTH));
    if (factor > 1) {
      imgA = scaleDown(imgA, factor);
      imgB = scaleDown(imgB, factor);
    }

    const width = Math.min(imgA.width, imgB.width);
    const height = Math.min(imgA.height, imgB.height);

    const crop = (img: PNG): Buffer => {
      const out = new PNG({ width, height });
      PNG.bitblt(img, out, 0, 0, width, height, 0, 0);
      return out.data as unknown as Buffer;
    };

    const diffData = new Uint8Array(width * height * 4);
    const diffPixels = pixelmatch(crop(imgA), crop(imgB), diffData, width, height, {
      threshold: 0.1,
      includeAA: false,
      diffColor: [255, 51, 51],
      alpha: 0.15,
    });

    const diffPngObj = new PNG({ width, height });
    (diffPngObj.data as unknown as Uint8Array).set(diffData);
    const diffPng = PNG.sync.write(diffPngObj) as unknown as Buffer;

    return { percent: (diffPixels / (width * height)) * 100, diffPng };
  } catch {
    return { percent: -1, diffPng: undefined };
  }
}

function diffPages(pageA: PageData, pageB: PageData): Difference[] {
  const diffs: Difference[] = [];

  // HTTP status
  if (pageA.status !== pageB.status) {
    diffs.push({
      field: 'status',
      severity: 'critical',
      description: 'HTTP status changed',
      before: String(pageA.status),
      after: String(pageB.status),
    });
  } else if (pageB.status >= 400) {
    diffs.push({
      field: 'status',
      severity: 'critical',
      description: `Page responded with ${pageB.status}`,
      before: String(pageA.status),
      after: String(pageB.status),
    });
  }

  // New JS console errors
  const newErrors = pageB.consoleErrors.filter(
    (e) => !pageA.consoleErrors.includes(e),
  );
  if (newErrors.length > 0) {
    diffs.push({
      field: 'console_errors',
      severity: 'critical',
      description: `${newErrors.length} new JavaScript error${newErrors.length > 1 ? 's' : ''}`,
      before: `${pageA.consoleErrors.length} error${pageA.consoleErrors.length !== 1 ? 's' : ''}`,
      after: newErrors.slice(0, 3).join('\n') +
        (newErrors.length > 3 ? `\n… +${newErrors.length - 3} more` : ''),
    });
  }

  // Failed network requests (scripts, stylesheets, fetch, xhr)
  const newFailed = pageB.failedRequests.filter(
    (r) => !pageA.failedRequests.some((a) => a.url === r.url),
  );
  const criticalFailed = newFailed.filter((r) =>
    ['script', 'stylesheet', 'fetch', 'xhr'].includes(r.resourceType),
  );
  if (criticalFailed.length > 0) {
    diffs.push({
      field: 'failed_assets',
      severity: 'critical',
      description: `${criticalFailed.length} new failed resource${criticalFailed.length > 1 ? 's' : ''}`,
      before: '',
      after: criticalFailed
        .slice(0, 3)
        .map((r) => `[${r.status}] ${r.resourceType}: ${new URL(r.url).pathname}`)
        .join('\n') +
        (criticalFailed.length > 3 ? `\n… +${criticalFailed.length - 3} more` : ''),
    });
  }
  const otherFailed = newFailed.filter(
    (r) => !['script', 'stylesheet', 'fetch', 'xhr'].includes(r.resourceType),
  );
  if (otherFailed.length > 0) {
    diffs.push({
      field: 'failed_resources',
      severity: 'warning',
      description: `${otherFailed.length} new failed resource${otherFailed.length > 1 ? 's' : ''} (${otherFailed.map((r) => r.resourceType).join(', ')})`,
      before: '',
      after: otherFailed
        .slice(0, 3)
        .map((r) => `[${r.status}] ${new URL(r.url).pathname}`)
        .join('\n'),
    });
  }

  // Title
  if (pageA.title !== pageB.title) {
    diffs.push({
      field: 'title',
      severity: 'warning',
      description: 'Page title changed',
      before: pageA.title,
      after: pageB.title,
    });
  }

  // Meta description
  if (
    pageA.metaDescription !== pageB.metaDescription &&
    (pageA.metaDescription || pageB.metaDescription)
  ) {
    diffs.push({
      field: 'meta_description',
      severity: 'info',
      description: 'Meta description changed',
      before: pageA.metaDescription,
      after: pageB.metaDescription,
    });
  }

  // H1
  const h1Diff = arrayDiff(pageA.headings.h1, pageB.headings.h1);
  if (h1Diff.removed.length > 0 || h1Diff.added.length > 0) {
    diffs.push({
      field: 'h1',
      severity: 'warning',
      description: 'H1 headings changed',
      before: pageA.headings.h1.join(' | ') || '(none)',
      after: pageB.headings.h1.join(' | ') || '(none)',
    });
  }

  // Word count (>20% change = info, >50% = warning)
  if (pageA.wordCount > 0 || pageB.wordCount > 0) {
    const base = Math.max(pageA.wordCount, 1);
    const delta = Math.abs(pageA.wordCount - pageB.wordCount);
    const pct = (delta / base) * 100;
    if (pct >= 20) {
      diffs.push({
        field: 'word_count',
        severity: pct >= 50 ? 'warning' : 'info',
        description: `Word count changed by ${pct.toFixed(0)}%`,
        before: `${pageA.wordCount} word${pageA.wordCount !== 1 ? 's' : ''}`,
        after: `${pageB.wordCount} word${pageB.wordCount !== 1 ? 's' : ''}`,
      });
    }
  }

  // Internal links
  const linkDiff = arrayDiff(pageA.internalLinks, pageB.internalLinks);
  if (linkDiff.removed.length > 0) {
    diffs.push({
      field: 'links_removed',
      severity: 'warning',
      description: `${linkDiff.removed.length} internal link${linkDiff.removed.length > 1 ? 's' : ''} removed`,
      before: linkDiff.removed.slice(0, 5).join(', ') +
        (linkDiff.removed.length > 5 ? ` … +${linkDiff.removed.length - 5}` : ''),
      after: '',
    });
  }
  if (linkDiff.added.length > 0) {
    diffs.push({
      field: 'links_added',
      severity: 'info',
      description: `${linkDiff.added.length} internal link${linkDiff.added.length > 1 ? 's' : ''} added`,
      before: '',
      after: linkDiff.added.slice(0, 5).join(', ') +
        (linkDiff.added.length > 5 ? ` … +${linkDiff.added.length - 5}` : ''),
    });
  }

  return diffs;
}

export async function compareSites(
  resultA: CrawlResult,
  resultB: CrawlResult,
  withScreenshots: boolean,
  diffThresholdPercent: number,
): Promise<ComparisonReport> {
  const allPaths = new Set([
    ...resultA.pages.keys(),
    ...resultB.pages.keys(),
  ]);

  const comparisons: PageComparison[] = [];

  for (const path of allPaths) {
    const pageA = resultA.pages.get(path);
    const pageB = resultB.pages.get(path);

    if (!pageA) {
      comparisons.push({
        path,
        status: 'only_in_b',
        urlB: pageB!.url,
        differences: [
          {
            field: 'existence',
            severity: 'critical',
            description: 'Page only exists in site B (new)',
          },
        ],
      });
      continue;
    }

    if (!pageB) {
      comparisons.push({
        path,
        status: 'only_in_a',
        urlA: pageA.url,
        differences: [
          {
            field: 'existence',
            severity: 'critical',
            description: 'Page missing in site B (removed or 404)',
          },
        ],
      });
      continue;
    }

    const differences = diffPages(pageA, pageB);

    let visualDiffPercent: number | undefined;
    let screenshots: import('./types.js').PageScreenshots | undefined;

    if (withScreenshots && pageA.screenshot && pageB.screenshot) {
      const { percent, diffPng } = visualDiff(pageA.screenshot, pageB.screenshot);
      if (percent >= 0) {
        visualDiffPercent = percent;
        screenshots = { a: pageA.screenshot, b: pageB.screenshot, diff: diffPng };
        if (percent > diffThresholdPercent) {
          differences.push({
            field: 'visual',
            severity: percent > diffThresholdPercent * 2 ? 'warning' : 'info',
            description: `Visually ${percent.toFixed(1)}% different (threshold: ${diffThresholdPercent}%)`,
            before: '(screenshot A)',
            after: '(screenshot B)',
          });
        }
      }
    }

    comparisons.push({
      path,
      status: differences.length === 0 ? 'identical' : 'changed',
      urlA: pageA.url,
      urlB: pageB.url,
      differences,
      visualDiffPercent,
      screenshots,
    });
  }

  // Sort: pages with most severe issues first
  const severityWeight = (c: PageComparison) => {
    if (c.status === 'only_in_a' || c.status === 'only_in_b') return 0;
    if (c.differences.some((d) => d.severity === 'critical')) return 1;
    if (c.differences.some((d) => d.severity === 'warning')) return 2;
    if (c.differences.length > 0) return 3;
    return 4;
  };
  comparisons.sort((a, b) => severityWeight(a) - severityWeight(b));

  return {
    siteA: resultA.baseUrl,
    siteB: resultB.baseUrl,
    timestamp: new Date(),
    totalPages: { a: resultA.pages.size, b: resultB.pages.size },
    failedUrls: { a: resultA.failedUrls, b: resultB.failedUrls },
    comparisons,
  };
}
