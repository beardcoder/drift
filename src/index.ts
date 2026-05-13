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
    'Vergleicht zwei Websites auf Fehler und Abweichungen — ideal für Refactorings und Build-Tool-Migrationen',
  )
  .version('1.0.0')
  .argument('<url-a>', 'Basis-URL der originalen Seite (z. B. webpack-Dev-Server)')
  .argument('<url-b>', 'Basis-URL der neuen Seite (z. B. Vite-Dev-Server)')
  .option('-d, --depth <n>', 'Crawl-Tiefe (0 = nur Startseite)', '2')
  .option('-m, --max-pages <n>', 'Max. Seiten pro Site', '200')
  .option('-c, --concurrency <n>', 'Parallele Browser-Tabs', '3')
  .option('-s, --screenshot', 'Screenshots erstellen und visuell vergleichen', false)
  .option(
    '-t, --diff-threshold <pct>',
    'Visuelle Diff-Toleranz in Prozent (nur mit --screenshot)',
    '5',
  )
  .option(
    '-i, --ignore <patterns...>',
    'Pfad-Muster ignorieren (RegExp, z. B. "^/admin" "\\?page=")',
    [],
  )
  .option('-o, --output <format>', 'Ausgabeformat: console | json', 'console')
  .option('-f, --out-file <path>', 'Ergebnis in Datei speichern (JSON)')
  .option('-r, --report <path>', 'HTML-Bericht speichern (z. B. report.html)')
  .option('--viewport <wxh>', 'Browser-Viewport in Pixeln', '1440x900')
  .addHelpText(
    'after',
    `
${chalk.bold('Beispiele:')}
  # Webpack vs. Vite, Tiefe 3
  drift http://localhost:8080 http://localhost:5173 --depth 3

  # Mit Screenshots und visuellem Diff
  drift https://old.example.com https://new.example.com -s -t 3

  # Nur Startseite, JSON-Ausgabe
  drift http://localhost:8080 http://localhost:5173 -d 0 -o json

  # Admin-Bereich ignorieren, max. 100 Seiten
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
      `  Tiefe: ${options.depth}  Max: ${options.maxPages} Seiten  Parallelität: ${options.concurrency}\n`,
    ),
  );

  const spinnerA = ora({ text: `Crawle Site A … (Tiefe 0)`, color: 'cyan' }).start();
  const resultA = await crawlSite(urlA, options, ({ done, total, depth, url }) => {
    const shortUrl = url.length > 55 ? '…' + url.slice(-54) : url;
    spinnerA.text = `Site A  [Tiefe ${depth}]  ${done}/${total} Seiten — ${shortUrl}`;
  });
  spinnerA.succeed(
    `Site A gecrawlt: ${resultA.pages.size} Seiten` +
      (resultA.pages.size >= options.maxPages ? chalk.yellow(` (Limit erreicht)`) : '') +
      (resultA.failedUrls.length ? chalk.red(` · ${resultA.failedUrls.length} Fehler`) : ''),
  );

  const spinnerB = ora({ text: `Crawle Site B … (Tiefe 0)`, color: 'green' }).start();
  const resultB = await crawlSite(urlB, options, ({ done, total, depth, url }) => {
    const shortUrl = url.length > 55 ? '…' + url.slice(-54) : url;
    spinnerB.text = `Site B  [Tiefe ${depth}]  ${done}/${total} Seiten — ${shortUrl}`;
  });
  spinnerB.succeed(
    `Site B gecrawlt: ${resultB.pages.size} Seiten` +
      (resultB.pages.size >= options.maxPages ? chalk.yellow(` (Limit erreicht)`) : '') +
      (resultB.failedUrls.length ? chalk.red(` · ${resultB.failedUrls.length} Fehler`) : ''),
  );

  const spinnerCmp = ora({ text: 'Vergleiche Seiten …', color: 'yellow' }).start();
  const report = await compareSites(resultA, resultB, options.screenshot, options.diffThreshold);
  spinnerCmp.succeed('Vergleich abgeschlossen');

  // HTML report
  if (options.report) {
    const html = generateHtmlReport(report);
    writeFileSync(options.report, html, 'utf-8');
    console.log(chalk.green(`\nHTML-Bericht gespeichert: ${options.report}`));
  }

  // JSON output
  if (options.output === 'json' || options.outFile) {
    const json = printJsonReport(report);
    if (options.outFile) {
      writeFileSync(options.outFile, json, 'utf-8');
      console.log(chalk.green(`JSON gespeichert: ${options.outFile}`));
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

main();
