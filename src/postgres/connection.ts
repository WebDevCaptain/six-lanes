/**
 * DuckDB's `postgres` extension takes a libpq keyword string, not a URL. One helper
 * so the repo keeps a single connection string in configuration and translates at
 * the one place that needs the other spelling.
 */
export function toLibpqConnectionString(url: string): string {
  const parsed = new URL(url);
  const parts: Record<string, string> = {
    host: parsed.hostname,
    port: parsed.port || '5432',
    dbname: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    user: decodeURIComponent(parsed.username),
  };
  if (parsed.password) parts['password'] = decodeURIComponent(parsed.password);

  return Object.entries(parts)
    .map(([key, value]) => `${key}=${quoteIfNeeded(value)}`)
    .join(' ');
}

const quoteIfNeeded = (value: string): string =>
  /^[A-Za-z0-9._-]+$/.test(value) ? value : `'${value.replace(/(['\\])/g, '\\$1')}'`;
