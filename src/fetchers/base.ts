// Helpers compartidos por los fetchers.

export interface FetcherEnv {
  USER_AGENT: string;
}

export const DEFAULT_TIMEOUT_MS = 25_000;

// Pequeño helper con User-Agent y timeout usando AbortController
export async function httpGet(url: string, env: FetcherEnv, init: RequestInit = {}): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      ...init,
      signal: ac.signal,
      headers: {
        "User-Agent": env.USER_AGENT,
        Accept: "application/json, text/html;q=0.9",
        ...(init.headers ?? {}),
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return r;
  } finally {
    clearTimeout(timer);
  }
}

export async function httpJson<T>(url: string, env: FetcherEnv, init: RequestInit = {}): Promise<T> {
  const r = await httpGet(url, env, init);
  return (await r.json()) as T;
}

// Workers no tienen setTimeout "bloqueante" como Python — pero en un fetcher
// que itera varias páginas puede servir espaciar requests.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parseo seguro de fechas. Devuelve ISO (date-only o datetime) o null.
export function parseIsoDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function parseIsoDateTime(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}
