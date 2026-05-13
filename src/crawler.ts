import {
  chromium,
  type Browser,
  type Page,
  type ConsoleMessage,
  type Response,
} from 'playwright';
import type { PageData, CrawlResult, CLIOptions, FailedRequest } from './types.js';

function normalizePath(href: string, baseUrl: string): string | null {
  try {
    const url = new URL(href, baseUrl);
    const base = new URL(baseUrl);
    if (url.hostname !== base.hostname) return null;
    let path = url.pathname;
    if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1);
    return path;
  } catch {
    return null;
  }
}

// ── Tab pool ──────────────────────────────────────────────────────────────────
// Pre-creates N persistent browser tabs and hands them out via acquire/release.
// Eliminates the browser.newPage() + page.close() overhead on every URL.

class TabPool {
  private idle: Page[] = [];
  private waiters: ((tab: Page) => void)[] = [];

  static async create(
    browser: Browser,
    size: number,
    viewport: { width: number; height: number },
  ): Promise<TabPool> {
    const pool = new TabPool();
    for (let i = 0; i < size; i++) {
      const tab = await browser.newPage();
      await tab.setViewportSize(viewport);
      pool.idle.push(tab);
    }
    return pool;
  }

  acquire(): Promise<Page> {
    if (this.idle.length > 0) return Promise.resolve(this.idle.pop()!);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(tab: Page): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(tab);
    } else {
      this.idle.push(tab);
    }
  }

  async closeAll(): Promise<void> {
    // Resolve any pending waiters with a dummy page so their promises settle
    const dummy = this.idle[0];
    while (this.waiters.length > 0 && dummy) this.waiters.shift()!(dummy);
    await Promise.all(this.idle.map((t) => t.close().catch(() => {})));
    this.idle = [];
  }
}

// ── Page scraper ──────────────────────────────────────────────────────────────

async function scrapePage(
  tab: Page,
  url: string,
  baseUrl: string,
  depth: number,
  takeScreenshot: boolean,
): Promise<PageData> {
  // Clear route handlers from the previous URL on this tab
  await tab.unrouteAll({ behavior: 'ignoreErrors' });

  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const failedRequests: FailedRequest[] = [];

  // Store handler references so we can remove them cleanly after navigation
  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
    if (msg.type() === 'warning') consoleWarnings.push(msg.text());
  };
  const onResponse = (res: Response) => {
    const status = res.status();
    const resourceType = res.request().resourceType();
    if (status >= 400 && resourceType !== 'document') {
      failedRequests.push({ url: res.url(), status, resourceType });
    }
  };

  tab.on('console', onConsole);
  tab.on('response', onResponse);

  try {
    if (!takeScreenshot) {
      await tab.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (type === 'image' || type === 'media' || type === 'font') {
          void route.abort();
        } else {
          void route.continue();
        }
      });
    }

    const startTime = Date.now();
    const response = await tab.goto(url, {
      waitUntil: takeScreenshot ? 'load' : 'domcontentloaded',
      timeout: takeScreenshot ? 30_000 : 15_000,
    });
    const loadTimeMs = Date.now() - startTime;
    const httpStatus = response?.status() ?? 0;

    const finalUrl = tab.url();
    const finalPath = normalizePath(finalUrl, baseUrl) ?? new URL(finalUrl).pathname;

    const extracted = await tab.evaluate(() => {
      const textOf = (sel: string) =>
        Array.from(document.querySelectorAll(sel))
          .map((el) => el.textContent?.trim() ?? '')
          .filter(Boolean);

      const bodyClone = document.body.cloneNode(true) as HTMLElement;
      for (const tag of ['script', 'style', 'nav', 'footer', 'header', 'aside']) {
        bodyClone.querySelectorAll(tag).forEach((el) => el.remove());
      }
      const bodyText = bodyClone.textContent?.replace(/\s+/g, ' ').trim() ?? '';

      return {
        title: document.title ?? '',
        metaDescription:
          (document.querySelector('meta[name="description"]') as HTMLMetaElement)?.content ?? '',
        h1: textOf('h1'),
        h2: textOf('h2'),
        h3: textOf('h3'),
        wordCount: bodyText.split(/\s+/).filter(Boolean).length,
        links: Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
          .map((a) => a.href)
          .filter(
            (h) =>
              h &&
              !h.startsWith('javascript:') &&
              !h.startsWith('mailto:') &&
              !h.startsWith('tel:'),
          ),
      };
    });

    const internalLinks: string[] = [];
    const externalLinks: string[] = [];
    for (const link of extracted.links) {
      const path = normalizePath(link, baseUrl);
      if (path !== null) {
        internalLinks.push(path);
      } else {
        try {
          externalLinks.push(new URL(link).href);
        } catch { /* ignore malformed */ }
      }
    }

    let screenshot: Buffer | undefined;
    if (takeScreenshot) {
      try {
        screenshot = (await tab.screenshot({ fullPage: true, timeout: 30_000 })) as Buffer;
      } catch {
        // screenshot timed out or failed — continue without it
      }
    }

    return {
      url: finalUrl,
      path: finalPath,
      status: httpStatus,
      title: extracted.title,
      metaDescription: extracted.metaDescription,
      headings: { h1: extracted.h1, h2: extracted.h2, h3: extracted.h3 },
      wordCount: extracted.wordCount,
      internalLinks: [...new Set(internalLinks)],
      externalLinks: [...new Set(externalLinks)],
      consoleErrors,
      consoleWarnings,
      failedRequests,
      loadTimeMs,
      screenshot,
      depth,
    };
  } finally {
    tab.off('console', onConsole);
    tab.off('response', onResponse);
  }
}

// ── Crawler ───────────────────────────────────────────────────────────────────

export interface CrawlProgress {
  done: number;
  total: number;
  depth: number;
  url: string;
}

export async function crawlSite(
  baseUrl: string,
  options: Pick<CLIOptions, 'depth' | 'concurrency' | 'screenshot' | 'ignore' | 'viewport' | 'maxPages'>,
  onProgress?: (p: CrawlProgress) => void,
): Promise<CrawlResult> {
  const normalizedBase = baseUrl.replace(/\/$/, '');

  const browser: Browser = await chromium.launch({ headless: true });
  const pool = await TabPool.create(browser, options.concurrency, options.viewport);

  const pages = new Map<string, PageData>();
  const failedUrls: { url: string; reason: string }[] = [];

  const ignorePatterns = options.ignore.map((p) => new RegExp(p));
  const shouldIgnore = (path: string) => ignorePatterns.some((re) => re.test(path));

  const visited = new Set<string>();
  const rootPath = normalizePath(normalizedBase, normalizedBase) ?? '/';
  visited.add(rootPath);

  type QueueItem = { url: string; depth: number };
  let currentLevel: QueueItem[] = [{ url: normalizedBase, depth: 0 }];
  let doneCount = 0;

  try {
    while (currentLevel.length > 0) {
      const currentDepth = currentLevel[0]!.depth;
      const nextLevel: QueueItem[] = [];

      // Dispatch the entire current BFS level concurrently.
      // The pool limits actual parallelism to `concurrency` tabs.
      await Promise.all(
        currentLevel.map(async ({ url, depth }): Promise<void> => {
          if (doneCount >= options.maxPages) return;

          const tab = await pool.acquire();
          try {
            const data = await scrapePage(tab, url, normalizedBase, depth, options.screenshot);
            pages.set(data.path, data);
            doneCount++;
            onProgress?.({
              done: doneCount,
              total: doneCount + nextLevel.length,
              depth,
              url,
            });

            if (depth < options.depth) {
              for (const linkPath of data.internalLinks) {
                if (
                  !visited.has(linkPath) &&
                  !shouldIgnore(linkPath) &&
                  doneCount + nextLevel.length < options.maxPages
                ) {
                  visited.add(linkPath);
                  nextLevel.push({
                    url: new URL(linkPath, normalizedBase).href,
                    depth: depth + 1,
                  });
                }
              }
            }
          } catch (err) {
            failedUrls.push({ url, reason: String(err) });
            doneCount++;
            onProgress?.({ done: doneCount, total: doneCount + nextLevel.length, depth, url });
          } finally {
            pool.release(tab);
          }
        }),
      );

      currentLevel = nextLevel;
    }
  } finally {
    await Promise.race([
      (async () => { await pool.closeAll(); await browser.close(); })(),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
    // Force-kill Chromium if it didn't exit within the grace period
    // browser.process may be undefined in the compiled binary
    browser.process?.()?.kill();
  }

  return { baseUrl: normalizedBase, pages, failedUrls };
}
