import chalk from 'chalk';
import type { CrawlProgress } from './types.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 80;
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE = '\x1b[2K\r';
const URL_TAIL = 36; // glyphs reserved on each render line (icon + tag + depth + count)

interface SiteState {
  depth: number;
  pages: number;
  url: string;
  startedAt: number;
  done: boolean;
  errors: number;
}

export class LiveStatus {
  private readonly states: Record<'A' | 'B', SiteState>;
  private readonly tty: boolean;
  private rendered = false;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cleanupRegistered = false;

  constructor() {
    const now = Date.now();
    this.states = { A: blank(now), B: blank(now) };
    this.tty =
      !!process.stdout.isTTY &&
      process.env.NO_COLOR !== '1' &&
      process.env.CI !== 'true';
  }

  start(): void {
    if (!this.tty) return;
    process.stdout.write(HIDE_CURSOR);
    this.registerCleanup();
    this.draw();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.draw();
    }, FRAME_INTERVAL_MS);
  }

  update(progress: CrawlProgress): void {
    const state = this.states[progress.site];
    state.depth = progress.depth;
    state.pages = progress.done;
    state.url = progress.url;
    if (!this.tty) {
      const tint = progress.site === 'A' ? chalk.cyan : chalk.green;
      console.log(`  ${tint(`[${progress.site}]`)} d${state.depth} ${state.pages}: ${shortUrl(progress.url, 70)}`);
    }
  }

  finishSite(site: 'A' | 'B', pages: number, errors: number): void {
    const state = this.states[site];
    state.done = true;
    state.pages = pages;
    state.errors = errors;
    state.url = '';
    if (!this.tty) {
      const elapsed = ((Date.now() - state.startedAt) / 1000).toFixed(1);
      const tint = site === 'A' ? chalk.cyan : chalk.green;
      const errStr = errors ? ` · ${errors} errors` : '';
      console.log(`  ${tint(`[${site}]`)} done · ${pages} pages · ${elapsed}s${errStr}`);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.tty) {
      this.draw();
      process.stdout.write(SHOW_CURSOR);
    }
  }

  private registerCleanup(): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;
    const cleanup = () => {
      if (this.timer) clearInterval(this.timer);
      process.stdout.write(SHOW_CURSOR);
    };
    process.once('SIGINT', () => { cleanup(); process.exit(130); });
    process.once('exit', cleanup);
  }

  private draw(): void {
    const lines = [this.renderSite('A'), this.renderSite('B')];
    if (this.rendered) process.stdout.write('\x1b[2A');
    for (const line of lines) process.stdout.write(CLEAR_LINE + line + '\n');
    this.rendered = true;
  }

  private renderSite(site: 'A' | 'B'): string {
    const state = this.states[site];
    const tint = site === 'A' ? chalk.cyan : chalk.green;
    const tag = tint.bold(`[${site}]`);
    const elapsed = ((Date.now() - state.startedAt) / 1000).toFixed(1);

    if (state.done) {
      const icon = state.errors ? chalk.yellow('⚠') : chalk.green('✓');
      const errStr = state.errors
        ? chalk.yellow(` · ${state.errors} error${state.errors === 1 ? '' : 's'}`)
        : '';
      return `  ${icon} ${tag}  ${chalk.bold(state.pages)} pages  ${chalk.dim(`${elapsed}s`)}${errStr}`;
    }

    const icon = chalk.cyan(SPINNER_FRAMES[this.frame]);
    const depth = chalk.dim(`d${state.depth}`);
    const pages = chalk.dim(`${String(state.pages).padStart(3)} pages`);
    const cols = process.stdout.columns ?? 80;
    const urlMax = Math.max(20, cols - URL_TAIL);
    const url = state.url ? chalk.dim(shortUrl(state.url, urlMax)) : chalk.dim('waiting…');
    return `  ${icon} ${tag} ${depth}  ${pages}  ${url}`;
  }
}

function blank(now: number): SiteState {
  return { depth: 0, pages: 0, url: '', startedAt: now, done: false, errors: 0 };
}

function shortUrl(url: string, max: number): string {
  if (url.length <= max) return url;
  return '…' + url.slice(-(max - 1));
}
