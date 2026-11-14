// Stubs mínimos de los tipos de Cloudflare Workers para poder
// validar el código con tsc sin instalar @cloudflare/workers-types.
// NO se usa en producción; es solo para type-check local.

declare interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

declare interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<void>;
}

declare interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

declare interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Fetch API globals (en Workers vienen builtin; en el check local los declaramos)
declare interface Request {
  url: string;
  method: string;
  headers: Headers;
}
declare interface Response {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
declare interface Headers {
  get(name: string): string | null;
}
declare interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}
declare interface AbortController {
  signal: AbortSignal;
  abort(): void;
}
declare interface AbortSignal {}

declare const fetch: (url: string, init?: RequestInit) => Promise<Response>;
declare const AbortController: { new (): AbortController };
declare const URL: { new (url: string): { pathname: string; searchParams: { get(name: string): string | null } } };
declare const setTimeout: (fn: () => void, ms: number) => number;
declare const clearTimeout: (handle: number) => void;
declare const console: {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

declare class Response {
  constructor(body?: string, init?: { status?: number; headers?: Record<string, string> });
}
