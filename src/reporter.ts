import chalk from 'chalk';
import Table from 'cli-table3';
import type { ComparisonReport, PageComparison, Severity } from './types.js';

const SEVERITY_COLOR: Record<Severity, chalk.Chalk> = {
  critical: chalk.red.bold,
  warning: chalk.yellow,
  info: chalk.cyan,
};

const SEVERITY_ICON: Record<Severity, string> = {
  critical: '✖',
  warning: '⚠',
  info: '·',
};

function truncate(str: string, max = 80): string {
  if (!str) return '';
  const firstLine = str.split('\n')[0]!;
  return firstLine.length > max ? firstLine.slice(0, max - 1) + '…' : firstLine;
}

function printPageComparison(comp: PageComparison, index: number): void {
  const statusLabel =
    comp.status === 'only_in_a'
      ? chalk.red('← nur A')
      : comp.status === 'only_in_b'
        ? chalk.green('→ nur B')
        : comp.status === 'identical'
          ? chalk.green('✔ identisch')
          : chalk.yellow('≠ geändert');

  const header = `${chalk.bold(comp.path)}  ${statusLabel}`;
  if (index > 0) process.stdout.write('\n');
  console.log(chalk.dim('─'.repeat(80)));
  console.log(header);

  if (comp.differences.length === 0) return;

  for (const diff of comp.differences) {
    const color = SEVERITY_COLOR[diff.severity];
    const icon = SEVERITY_ICON[diff.severity];
    console.log(`  ${color(icon)} ${color(diff.field.padEnd(20))}  ${diff.description}`);

    if (diff.before !== undefined && diff.before !== '') {
      console.log(`    ${chalk.dim('vorher:')} ${chalk.strikethrough(chalk.dim(truncate(diff.before)))}`);
    }
    if (diff.after !== undefined && diff.after !== '') {
      // Multi-line "after" (e.g. console errors)
      const lines = diff.after.split('\n');
      for (const [i, line] of lines.entries()) {
        console.log(
          `    ${i === 0 ? chalk.dim('nachher:') : '         '} ${chalk.white(truncate(line))}`,
        );
      }
    }
  }
}

export function printConsoleReport(report: ComparisonReport): void {
  console.log('\n' + chalk.bold.underline('COMPARE-WEB — Ergebnis'));
  console.log(
    `  Site A: ${chalk.cyan(report.siteA)}\n  Site B: ${chalk.cyan(report.siteB)}`,
  );
  console.log(
    `  Seiten gecrawlt: A=${chalk.bold(report.totalPages.a)}  B=${chalk.bold(report.totalPages.b)}`,
  );
  console.log(`  Zeitstempel: ${report.timestamp.toLocaleString('de-DE')}\n`);

  // Counts
  const counts = {
    critical: 0,
    warning: 0,
    info: 0,
    identical: 0,
    missingB: 0,
    newB: 0,
  };

  for (const c of report.comparisons) {
    if (c.status === 'identical') {
      counts.identical++;
    } else if (c.status === 'only_in_a') {
      counts.missingB++;
      counts.critical++;
    } else if (c.status === 'only_in_b') {
      counts.newB++;
    } else {
      for (const d of c.differences) counts[d.severity]++;
    }
  }

  // Summary table
  const summaryTable = new Table({
    head: [
      chalk.red.bold('Kritisch'),
      chalk.yellow.bold('Warnung'),
      chalk.cyan.bold('Info'),
      chalk.green.bold('Identisch'),
      chalk.red('Fehlt in B'),
      chalk.blue('Neu in B'),
    ],
    style: { head: [], border: ['dim'] },
  });
  summaryTable.push([
    chalk.red.bold(counts.critical),
    chalk.yellow.bold(counts.warning),
    chalk.cyan(counts.info),
    chalk.green(counts.identical),
    chalk.red(counts.missingB),
    chalk.blue(counts.newB),
  ]);
  console.log(summaryTable.toString());

  // Crawl errors
  const totalCrawlFailed = report.failedUrls.a.length + report.failedUrls.b.length;
  if (totalCrawlFailed > 0) {
    console.log(chalk.red(`\n⚠ Crawl-Fehler: ${totalCrawlFailed} URLs konnten nicht geladen werden`));
    for (const f of report.failedUrls.a) {
      console.log(chalk.dim(`  A: ${f.url}  →  ${f.reason.split('\n')[0]}`));
    }
    for (const f of report.failedUrls.b) {
      console.log(chalk.dim(`  B: ${f.url}  →  ${f.reason.split('\n')[0]}`));
    }
  }

  // Skip identical pages unless there's nothing else to show
  const significant = report.comparisons.filter((c) => c.status !== 'identical');

  if (significant.length === 0) {
    console.log(chalk.green.bold('\n✔ Alle Seiten identisch — keine Abweichungen gefunden.'));
    return;
  }

  console.log(`\n${chalk.bold(`Detaillierte Unterschiede (${significant.length} Seiten):`)}`);

  for (const [i, comp] of significant.entries()) {
    printPageComparison(comp, i);
  }

  console.log('\n' + chalk.dim('─'.repeat(80)));

  // Exit message
  if (counts.critical > 0) {
    console.log(chalk.red.bold(`\n✖ ${counts.critical} kritische Probleme gefunden.`));
  } else if (counts.warning > 0) {
    console.log(chalk.yellow.bold(`\n⚠ Keine kritischen Fehler, aber ${counts.warning} Warnungen.`));
  } else {
    console.log(chalk.green.bold('\n✔ Keine kritischen Fehler oder Warnungen.'));
  }
}

export function printJsonReport(report: ComparisonReport): string {
  const output = {
    ...report,
    timestamp: report.timestamp.toISOString(),
    // Omit screenshot buffers from JSON
    comparisons: report.comparisons.map((c) => ({
      path: c.path,
      status: c.status,
      urlA: c.urlA,
      urlB: c.urlB,
      visualDiffPercent: c.visualDiffPercent,
      differences: c.differences,
    })),
  };
  return JSON.stringify(output, null, 2);
}
