import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Request,
  type Response,
} from 'playwright';
import type { CLIOptions, CrawlProgress, CrawlResult, FailedRequest, PageData } from './types.js';
import { baseUrlFromInput, classifyLink, joinPath, normalizePath, pathFromHref } from './url-tools.js';

const POST_NAV_IDLE_MS = 250;
const SCREENSHOT_TIMEOUT_MS = 30_000;
const HEAVY_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

interface Collectors {
  consoleErrors: string[];
  consoleWarnings: string[];
  failedRequests: FailedRequest[];
}

export type CrawlSiteOptions = Pick<
  CLIOptions,
  'depth' | 'maxPages' | 'timeoutMs' | 'userAgent' | 'screenshot' | 'ignore' | 'viewport'
>;

export async function crawlSite(
  label: 'A' | 'B',
  inputUrl: string,
  options: CrawlSiteOptions,
  onProgress?: (progress: CrawlProgress) => void,
): Promise<CrawlResult> {
  const baseUrl = baseUrlFromInput(inputUrl);
  const baseOrigin = baseUrl.origin;
  const baseHref = baseUrl.toString().replace(/\/$/, '');

  const browser = await chromium.launch({
    headless: true,
    args: ['--hide-scrollbars'],
  });

  try {
    const context = await browser.newContext({
      viewport: options.viewport,
      userAgent: options.userAgent,
    });
    context.setDefaultNavigationTimeout(options.timeoutMs);
    context.setDefaultTimeout(options.timeoutMs);

    if (!options.screenshot) {
      await context.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (HEAVY_RESOURCE_TYPES.has(type)) {
          void route.abort('blockedbyclient');
        } else {
          void route.continue();
        }
      });
    }

    const page = await context.newPage();
    const collectors: Collectors = {
      consoleErrors: [],
      consoleWarnings: [],
      failedRequests: [],
    };
    attachCollectors(page, collectors);

    const pages = new Map<string, PageData>();
    const failedUrls: { url: string; reason: string }[] = [];
    const ignorePatterns = options.ignore.map((pattern) => new RegExp(pattern));
    const shouldIgnore = (path: string) => ignorePatterns.some((re) => re.test(path));

    const visited = new Set<string>();
    const queued = new Set<string>();
    const queue: { url: string; depth: number }[] = [];

    const startPath = normalizePath(baseUrl.pathname);
    queue.push({ url: baseHref, depth: 0 });
    queued.add(startPath);

    while (queue.length > 0 && pages.size < options.maxPages) {
      const current = queue.shift()!;
      const dedupeKey = pathFromHref(current.url);
      if (visited.has(dedupeKey)) continue;
      visited.add(dedupeKey);

      resetCollectors(collectors);
      onProgress?.({ site: label, done: pages.size, depth: current.depth, url: current.url });

      try {
        const data = await scrapePage(
          page,
          current.url,
          baseOrigin,
          current.depth,
          options.screenshot,
          options.timeoutMs,
          collectors,
        );

        pages.set(data.path, data);
        visited.add(data.path);
        queued.add(data.path);

        if (current.depth < options.depth) {
          for (const linkPath of data.internalLinks) {
            if (queued.has(linkPath) || shouldIgnore(linkPath)) continue;
            queued.add(linkPath);
            queue.push({ url: joinPath(baseHref, linkPath), depth: current.depth + 1 });
          }
        }
      } catch (error) {
        failedUrls.push({ url: current.url, reason: errorMessage(error) });
      }
    }

    await context.close();
    return { baseUrl: baseHref, pages, failedUrls };
  } finally {
    await closeBrowserSafely(browser);
  }
}

function attachCollectors(page: Page, collectors: Collectors): void {
  page.on('console', (msg: ConsoleMessage) => {
    const type = msg.type();
    if (type === 'error') pushUnique(collectors.consoleErrors, msg.text());
    else if (type === 'warning') pushUnique(collectors.consoleWarnings, msg.text());
  });

  page.on('pageerror', (error) => {
    pushUnique(collectors.consoleErrors, error.message);
  });

  page.on('requestfailed', (request: Request) => {
    const failure = request.failure();
    // Skip our own intentional blocks from the route handler.
    if (failure?.errorText?.includes('BLOCKED_BY_CLIENT')) return;
    collectors.failedRequests.push({
      url: request.url(),
      status: 0,
      resourceType: request.resourceType(),
    });
  });

  page.on('response', (response: Response) => {
    const status = response.status();
    const type = response.request().resourceType();
    if (status >= 400 && type !== 'document') {
      collectors.failedRequests.push({ url: response.url(), status, resourceType: type });
    }
  });
}

function resetCollectors(collectors: Collectors): void {
  collectors.consoleErrors.length = 0;
  collectors.consoleWarnings.length = 0;
  collectors.failedRequests.length = 0;
}

async function scrapePage(
  page: Page,
  url: string,
  baseOrigin: string,
  depth: number,
  takeScreenshot: boolean,
  timeoutMs: number,
  collectors: Collectors,
): Promise<PageData> {
  const startedAt = Date.now();
  let httpStatus = 0;

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    httpStatus = response?.status() ?? 0;
  } catch (error) {
    return failedNavigationSnapshot(url, depth, Date.now() - startedAt, error, collectors);
  }

  await page.waitForTimeout(POST_NAV_IDLE_MS);
  const loadTimeMs = Date.now() - startedAt;

  const finalUrl = page.url();
  const finalPath = pathFromHref(finalUrl);

  const extracted = await extractPageData(page);

  const internalLinks: string[] = [];
  const externalLinks: string[] = [];
  for (const href of extracted.hrefs) {
    const link = classifyLink(href, baseOrigin);
    if (!link) continue;
    if (link.kind === 'internal') internalLinks.push(link.path);
    else externalLinks.push(link.url);
  }

  let screenshot: Buffer | undefined;
  if (takeScreenshot) {
    try {
      screenshot = (await page.screenshot({
        fullPage: true,
        timeout: SCREENSHOT_TIMEOUT_MS,
      })) as Buffer;
    } catch {
      // Drop the screenshot, keep the rest of the snapshot.
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
    internalLinks: dedupe(internalLinks),
    externalLinks: dedupe(externalLinks),
    consoleErrors: [...collectors.consoleErrors],
    consoleWarnings: [...collectors.consoleWarnings],
    failedRequests: [...collectors.failedRequests],
    loadTimeMs,
    screenshot,
    depth,
  };
}

async function extractPageData(page: Page): Promise<{
  title: string;
  metaDescription: string;
  h1: string[];
  h2: string[];
  h3: string[];
  wordCount: number;
  hrefs: string[];
}> {
  return page.evaluate(() => {
    const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

    const textOf = (selector: string): string[] =>
      Array.from(document.querySelectorAll(selector))
        .map((el) => collapse(el.textContent ?? ''))
        .filter(Boolean);

    const metaDescription =
      (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content ??
      (document.querySelector('meta[property="og:description"]') as HTMLMetaElement | null)?.content ??
      '';

    const bodyText = collapse((document.body?.innerText ?? ''));

    const hrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .map((a) => a.href)
      .filter(
        (h) =>
          !!h &&
          !h.startsWith('javascript:') &&
          !h.startsWith('mailto:') &&
          !h.startsWith('tel:'),
      );

    return {
      title: collapse(document.title ?? ''),
      metaDescription: collapse(metaDescription),
      h1: textOf('h1'),
      h2: textOf('h2'),
      h3: textOf('h3'),
      wordCount: bodyText ? bodyText.split(' ').filter(Boolean).length : 0,
      hrefs,
    };
  });
}

function failedNavigationSnapshot(
  url: string,
  depth: number,
  loadTimeMs: number,
  error: unknown,
  collectors: Collectors,
): PageData {
  return {
    url,
    path: pathFromHref(url),
    status: 0,
    title: '',
    metaDescription: '',
    headings: { h1: [], h2: [], h3: [] },
    wordCount: 0,
    internalLinks: [],
    externalLinks: [],
    consoleErrors: [...collectors.consoleErrors],
    consoleWarnings: [...collectors.consoleWarnings],
    failedRequests: [
      ...collectors.failedRequests,
      { url, status: 0, resourceType: 'document' },
    ],
    loadTimeMs,
    screenshot: undefined,
    depth,
  };
}

async function closeBrowserSafely(browser: Browser): Promise<void> {
  try {
    await browser.close();
  } catch {
    // Last resort: if Playwright reports a closed browser cleanly, this is a no-op.
    // We do NOT reach for process.kill() — the simpler per-site lifecycle should
    // not produce hung sub-processes.
  }
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
