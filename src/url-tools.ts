export function normalizePath(input: string): string {
  if (!input) return '/';
  const queryIdx = input.indexOf('?');
  const fragmentIdx = input.indexOf('#');
  let end = input.length;
  if (queryIdx >= 0) end = Math.min(end, queryIdx);
  if (fragmentIdx >= 0) end = Math.min(end, fragmentIdx);

  let path = input.slice(0, end) || '/';
  if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

export function pathFromHref(href: string): string {
  try {
    return normalizePath(new URL(href).pathname);
  } catch {
    return '/';
  }
}

export function baseUrlFromInput(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`URL scheme must be http or https: ${input}`);
  }
  url.search = '';
  url.hash = '';
  return url;
}

export function classifyLink(
  href: string,
  baseOrigin: string,
): { kind: 'internal'; path: string } | { kind: 'external'; url: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin === baseOrigin) {
    return { kind: 'internal', path: normalizePath(url.pathname) };
  }
  url.hash = '';
  return { kind: 'external', url: url.toString() };
}

export function joinPath(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').href;
}
