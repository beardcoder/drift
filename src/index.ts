#!/usr/bin/env bun
import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { writeFileSync } from 'node:fs';
import { crawlSite } from './crawler.js';
import { compareSites } from './comparator.js';
import { printConsoleReport, printJsonReport } from './reporter.js';
import { generateHtmlReport } from './html-reporter.js';
import type { CLIOptions } from './types.js';

const program = new Command();

program
  .name('drift')
  .description(
    'Crawl two websites and detect regressions — built for build-tool migrations and refactors',
  )
  .version('1.0.0')
  .argument('<url-a>', 'Base URL of the original site (e.g. webpack dev server)')
  .argument('<url-b>', 'Base URL of the new site (e.g. Vite dev server)')
  .option('-d, --depth <n>', 'Crawl depth (0 = homepage only)', '2')
  .option('-m, --max-pages <n>', 'Maximum pages per site', '200')
  .option('-c, --concurrency <n>', 'Parallel browser tabs', '3')
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
const opts = program.opts<{
  depth: string;
  maxPages: string;
  concurrency: string;
  screenshot: boolean;
  diffThreshold: string;
  ignore: string[];
  output: string;
  outFile?: string;
  report?: string;
  viewport: string;
}>();

const [vpW, vpH] = opts.viewport.split('x').map(Number);
const options: CLIOptions = {
  depth: Math.max(0, parseInt(opts.depth, 10)),
  maxPages: Math.max(1, parseInt(opts.maxPages, 10)),
  concurrency: Math.max(1, Math.min(10, parseInt(opts.concurrency, 10))),
  screenshot: opts.screenshot,
  diffThreshold: parseFloat(opts.diffThreshold),
  ignore: opts.ignore,
  output: opts.output as CLIOptions['output'],
  outFile: opts.outFile,
  report: opts.report,
  viewport: { width: vpW ?? 1440, height: vpH ?? 900 },
};

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(chalk.bold('\n  drift') + chalk.dim('  v1.0.0'));
  console.log(chalk.dim(`  A: ${urlA}`));
  console.log(chalk.dim(`  B: ${urlB}`));
  console.log(
    chalk.dim(
      `  Depth: ${options.depth}  Max: ${options.maxPages} pages  Concurrency: ${options.concurrency}\n`,
    ),
  );

  const spinnerA = ora({ text: `Crawling site A … (depth 0)`, color: 'cyan' }).start();
  const resultA = await crawlSite(urlA, options, ({ done, total, depth, url }) => {
    const shortUrl = url.length > 55 ? '…' + url.slice(-54) : url;
    spinnerA.text = `Site A  [depth ${depth}]  ${done}/${total} pages — ${shortUrl}`;
  });
  spinnerA.succeed(
    `Site A crawled: ${resultA.pages.size} pages` +
      (resultA.pages.size >= options.maxPages ? chalk.yellow(` (limit reached)`) : '') +
      (resultA.failedUrls.length ? chalk.red(` · ${resultA.failedUrls.length} errors`) : ''),
  );

  const spinnerB = ora({ text: `Crawling site B … (depth 0)`, color: 'green' }).start();
  const resultB = await crawlSite(urlB, options, ({ done, total, depth, url }) => {
    const shortUrl = url.length > 55 ? '…' + url.slice(-54) : url;
    spinnerB.text = `Site B  [depth ${depth}]  ${done}/${total} pages — ${shortUrl}`;
  });
  spinnerB.succeed(
    `Site B crawled: ${resultB.pages.size} pages` +
      (resultB.pages.size >= options.maxPages ? chalk.yellow(` (limit reached)`) : '') +
      (resultB.failedUrls.length ? chalk.red(` · ${resultB.failedUrls.length} errors`) : ''),
  );

  const spinnerCmp = ora({ text: 'Comparing pages …', color: 'yellow' }).start();
  const report = await compareSites(resultA, resultB, options.screenshot, options.diffThreshold);
  spinnerCmp.succeed('Comparison complete');

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
      return;
    }
  }

  printConsoleReport(report);

  const hasCritical = report.comparisons.some(
    (c) =>
      c.status === 'only_in_a' ||
      c.differences.some((d) => d.severity === 'critical'),
  );
  process.exit(hasCritical ? 1 : 0);
}

main().catch((err) => {
  console.error(chalk.red('\nFatal error:'), err);
  process.exit(2);
});
