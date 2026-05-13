export interface FailedRequest {
  url: string;
  status: number;
  resourceType: string;
}

export interface PageData {
  url: string;
  path: string;
  status: number;
  title: string;
  metaDescription: string;
  headings: { h1: string[]; h2: string[]; h3: string[] };
  wordCount: number;
  internalLinks: string[];
  externalLinks: string[];
  consoleErrors: string[];
  consoleWarnings: string[];
  failedRequests: FailedRequest[];
  loadTimeMs: number;
  screenshot?: Buffer;
  depth: number;
}

export interface CrawlResult {
  baseUrl: string;
  pages: Map<string, PageData>;
  failedUrls: { url: string; reason: string }[];
}

export type Severity = 'critical' | 'warning' | 'info';

export interface Difference {
  field: string;
  severity: Severity;
  description: string;
  before?: string;
  after?: string;
}

export type PageStatus = 'identical' | 'changed' | 'only_in_a' | 'only_in_b';

export interface PageScreenshots {
  a: Buffer;
  b: Buffer;
  diff?: Buffer;
}

export interface PageComparison {
  path: string;
  status: PageStatus;
  urlA?: string;
  urlB?: string;
  differences: Difference[];
  visualDiffPercent?: number;
  screenshots?: PageScreenshots;
}

export interface ComparisonReport {
  siteA: string;
  siteB: string;
  timestamp: Date;
  totalPages: { a: number; b: number };
  failedUrls: { a: { url: string; reason: string }[]; b: { url: string; reason: string }[] };
  comparisons: PageComparison[];
}

export interface CLIOptions {
  depth: number;
  maxPages: number;
  concurrency: number;
  screenshot: boolean;
  diffThreshold: number;
  ignore: string[];
  output: 'console' | 'json';
  outFile?: string;
  report?: string;
  viewport: { width: number; height: number };
}
