import chalk, { type ChalkInstance } from 'chalk';
import Table from 'cli-table3';
import type { ComparisonReport, PageComparison, Severity } from './types.js';

const SEVERITY_COLOR: Record<Severity, ChalkInstance> = {
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
      ? chalk.red('← only in A')
      : comp.status === 'only_in_b'
        ? chalk.green('→ only in B')
        : comp.status === 'identical'
          ? chalk.green('✔ identical')
          : chalk.yellow('≠ changed');

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
      console.log(`    ${chalk.dim('before:')} ${chalk.strikethrough(chalk.dim(truncate(diff.before)))}`);
    }
    if (diff.after !== undefined && diff.after !== '') {
      const lines = diff.after.split('\n');
      for (const [i, line] of lines.entries()) {
        console.log(
          `    ${i === 0 ? chalk.dim('after: ') : '         '} ${chalk.white(truncate(line))}`,
        );
      }
    }
  }
}

export function printConsoleReport(report: ComparisonReport): void {
  console.log('\n' + chalk.bold.underline('DRIFT — Results'));
  console.log(
    `  Site A: ${chalk.cyan(report.siteA)}\n  Site B: ${chalk.cyan(report.siteB)}`,
  );
  console.log(
    `  Pages crawled: A=${chalk.bold(report.totalPages.a)}  B=${chalk.bold(report.totalPages.b)}`,
  );
  console.log(`  Timestamp: ${report.timestamp.toLocaleString('en-GB')}\n`);

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

  const summaryTable = new Table({
    head: [
      chalk.red.bold('Critical'),
      chalk.yellow.bold('Warning'),
      chalk.cyan.bold('Info'),
      chalk.green.bold('Identical'),
      chalk.red('Missing in B'),
      chalk.blue('New in B'),
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

  const totalCrawlFailed = report.failedUrls.a.length + report.failedUrls.b.length;
  if (totalCrawlFailed > 0) {
    console.log(chalk.red(`\n⚠ Crawl errors: ${totalCrawlFailed} URLs could not be loaded`));
    for (const f of report.failedUrls.a) {
      console.log(chalk.dim(`  A: ${f.url}  →  ${f.reason.split('\n')[0]}`));
    }
    for (const f of report.failedUrls.b) {
      console.log(chalk.dim(`  B: ${f.url}  →  ${f.reason.split('\n')[0]}`));
    }
  }

  const significant = report.comparisons.filter((c) => c.status !== 'identical');

  if (significant.length === 0) {
    console.log(chalk.green.bold('\n✔ All pages identical — no regressions found.'));
    return;
  }

  console.log(`\n${chalk.bold(`Detailed differences (${significant.length} pages):`)}`);

  for (const [i, comp] of significant.entries()) {
    printPageComparison(comp, i);
  }

  console.log('\n' + chalk.dim('─'.repeat(80)));

  if (counts.critical > 0) {
    console.log(chalk.red.bold(`\n✖ ${counts.critical} critical issue${counts.critical > 1 ? 's' : ''} found.`));
  } else if (counts.warning > 0) {
    console.log(chalk.yellow.bold(`\n⚠ No critical issues, but ${counts.warning} warning${counts.warning > 1 ? 's' : ''}.`));
  } else {
    console.log(chalk.green.bold('\n✔ No critical issues or warnings.'));
  }
}

export function printJsonReport(report: ComparisonReport): string {
  const output = {
    ...report,
    timestamp: report.timestamp.toISOString(),
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
