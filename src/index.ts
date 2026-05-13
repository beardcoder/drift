#!/usr/bin/env bun
import { Command } from 'commander';
import chalk from 'chalk';
import { writeFileSync } from 'node:fs';
import { crawlSite } from './crawler.js';
import { compareSites } from './comparator.js';
import { printConsoleReport, printJsonReport } from './reporter.js';
import { generateHtmlReport } from './html-reporter.js';
import { LiveStatus } from './progress.js';
import type { CLIOptions } from './types.js';

const VERSION = '1.1.0';
const DEFAULT_USER_AGENT = `drift/${VERSION}`;

const program = new Command();

program
  .name('drift')
  .description(
    'Crawl two websites and detect regressions — built for build-tool migrations and refactors',
  )
  .version(VERSION)
  .argument('<url-a>', 'Base URL of the original site (e.g. webpack dev server)')
  .argument('<url-b>', 'Base URL of the new site (e.g. Vite dev server)')
  .option('-d, --depth <n>', 'Crawl depth (0 = homepage only)', '2')
  .option('-m, --max-pages <n>', 'Maximum pages per site', '200')
  .option('--timeout-ms <ms>', 'Navigation timeout per page in milliseconds', '15000')
  .option('--user-agent <ua>', 'User-Agent header for browser navigations', DEFAULT_USER_AGENT)
  .option('-s, --screenshot', 'Take full-page screenshots and compare visually', false)
  .option(
    '-t, --diff-threshold <pct>',
    'Visual diff tolerance in percent (requires --screenshot)',
    '5',
  )
  .option(
    '-i, --ignore <patterns...>',
    'Path patterns to ignore (RegExp, e.g. "^/admin" "\\?page=")',
    [],
  )
  .option('-o, --output <format>', 'Output format: console | json', 'console')
  .option('-f, --out-file <path>', 'Save JSON result to file')
  .option('-r, --report <path>', 'Save HTML report to file (e.g. report.html)')
  .option('--viewport <wxh>', 'Browser viewport in pixels', '1440x900')
  .addHelpText(
    'after',
    `
${chalk.bold('Examples:')}
  # webpack vs. Vite, crawl 3 levels deep
  drift http://localhost:8080 http://localhost:5173 --depth 3

  # With screenshots and visual diff
  drift https://old.example.com https://new.example.com -s -t 3

  # Homepage only, JSON output
  drift http://localhost:8080 http://localhost:5173 -d 0 -o json

  # Ignore admin area, cap at 100 pages
  drift http://a.local http://b.local -i "^/admin" -m 100
`,
  );

program.parse();

const [urlA, urlB] = program.args as [string, string];
const rawOpts = program.opts<{
  depth: string;
  maxPages: string;
  timeoutMs: string;
  userAgent: string;
  screenshot: boolean;
  diffThreshold: string;
  ignore: string[];
  output: string;
  outFile?: string;
  report?: string;
  viewport: string;
}>();

const [vpW, vpH] = rawOpts.viewport.split('x').map(Number);
const options: CLIOptions = {
  depth: Math.max(0, parseInt(rawOpts.depth, 10)),
  maxPages: Math.max(1, parseInt(rawOpts.maxPages, 10)),
  timeoutMs: Math.max(1000, parseInt(rawOpts.timeoutMs, 10)),
  userAgent: rawOpts.userAgent,
  screenshot: rawOpts.screenshot,
  diffThreshold: parseFloat(rawOpts.diffThreshold),
  ignore: rawOpts.ignore,
  output: (rawOpts.output === 'json' ? 'json' : 'console') as CLIOptions['output'],
  outFile: rawOpts.outFile,
  report: rawOpts.report,
  viewport: { width: vpW ?? 1440, height: vpH ?? 900 },
};

async function main(): Promise<void> {
  printHeader();

  const status = new LiveStatus();
  status.start();

  const startedAt = Date.now();
  const [resultA, resultB] = await Promise.all([
    crawlSite('A', urlA, options, (progress) => status.update(progress)).then((result) => {
      status.finishSite('A', result.pages.size, result.failedUrls.length);
      return result;
    }),
    crawlSite('B', urlB, options, (progress) => status.update(progress)).then((result) => {
      status.finishSite('B', result.pages.size, result.failedUrls.length);
      return result;
    }),
  ]);
  status.stop();

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(chalk.dim(`\n  crawled in ${elapsed}s · comparing pages…`));

  const report = await compareSites(resultA, resultB, options.screenshot, options.diffThreshold);

  if (options.report) {
    const html = generateHtmlReport(report);
    writeFileSync(options.report, html, 'utf-8');
    console.log(chalk.green(`\nHTML report saved: ${options.report}`));
  }

  if (options.output === 'json' || options.outFile) {
    const json = printJsonReport(report);
    if (options.outFile) {
      writeFileSync(options.outFile, json, 'utf-8');
      console.log(chalk.green(`JSON saved: ${options.outFile}`));
    }
    if (options.output === 'json') {
      console.log(json);
      process.exit(hasCritical(report) ? 1 : 0);
    }
  }

  printConsoleReport(report);
  process.exit(hasCritical(report) ? 1 : 0);
}

function printHeader(): void {
  const meta = [
    `depth ${options.depth}`,
    `max ${options.maxPages}`,
    `${options.timeoutMs}ms timeout`,
    options.screenshot ? 'screenshots' : null,
  ]
    .filter(Boolean)
    .join(chalk.dim(' · '));

  console.log();
  console.log(chalk.bold('  drift') + chalk.dim(`  v${VERSION}`));
  console.log(`  ${chalk.cyan.bold('[A]')} ${chalk.dim('→')} ${urlA}`);
  console.log(`  ${chalk.green.bold('[B]')} ${chalk.dim('→')} ${urlB}`);
  console.log(`  ${chalk.dim(meta)}`);
  console.log();
}

function hasCritical(report: Awaited<ReturnType<typeof compareSites>>): boolean {
  return report.comparisons.some(
    (comp) =>
      comp.status === 'only_in_a' ||
      comp.differences.some((diff) => diff.severity === 'critical'),
  );
}

main().catch((error) => {
  console.error(chalk.red('\nFatal error:'), error);
  process.exit(2);
});
