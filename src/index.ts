// Worker entry — dos handlers:
//   fetch()      → sirve el digest HTML y endpoints JSON (/api/*)
//   scheduled()  → cron trigger: corre fetchers, clasifica, guarda
//
// Endpoints:
//   GET /                        → digest HTML con todas las vigentes
//   GET /?country=CR             → filtro por país
//   GET /api/vigentes.json       → vigentes como JSON
//   GET /api/runs.json           → últimas corridas (debugging)
//   POST /admin/run              → disparar fetch manual (requiere ADMIN_TOKEN)

import { renderCartelDetail } from "./cartel";
import { classify, filterRelevant } from "./classifier";
import { renderDigest } from "./digest";
import { renderDigestEmail, sendEmail } from "./email";
import { FETCHERS } from "./fetchers";
import { dedupeKey, type Licitacion } from "./schema";
import { Storage } from "./storage";

export interface Env {
  DB: D1Database;
  USER_AGENT: string;
  RELEVANT_CATEGORIES: string;
  ADMIN_TOKEN?: string;
  CONTACT_EMAIL?: string;
  // Correo (Resend)
  RESEND_API_KEY?: string;
  DIGEST_EMAIL_TO?: string;
  DIGEST_EMAIL_FROM?: string;
  PUBLIC_URL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const storage = new Storage(env.DB);

    // --- API JSON ---
    if (url.pathname === "/api/vigentes.json") {
      const country = url.searchParams.get("country") ?? undefined;
      const lics = await storage.vigentes(country);
      return jsonResponse(lics);
    }

    if (url.pathname === "/api/runs.json") {
      const { results } = await env.DB
        .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 50")
        .all();
      return jsonResponse(results);
    }

    // --- Detalle consolidado de un concurso (nuestra propia página) ---
    if (url.pathname === "/cartel") {
      const no = url.searchParams.get("no");
      const seq = url.searchParams.get("seq") ?? "00";
      if (!no) return new Response("Falta parámetro 'no'", { status: 400 });
      const html = await renderCartelDetail(no, seq);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // --- Admin: disparo manual ---
    if (url.pathname === "/admin/run" && request.method === "POST") {
      if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) {
        return new Response("Forbidden", { status: 403 });
      }
      const summary = await runPipeline(env);
      return jsonResponse(summary);
    }

    // --- Admin: enviar el correo del digest (prueba manual) ---
    if (url.pathname === "/admin/email" && request.method === "POST") {
      if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) {
        return new Response("Forbidden", { status: 403 });
      }
      // force=1 envía aunque no haya nuevas hoy (útil para probar)
      const force = url.searchParams.get("force") === "1";
      const result = await sendDailyDigest(env, force);
      return jsonResponse(result);
    }

    // --- HTML digest (ruta por defecto) ---
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const country = url.searchParams.get("country") ?? undefined;
      const lics = await storage.vigentes(country);

      // Las de las últimas 24h se consideran "nuevas" para el highlight
      const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const newKeys = await storage.seenSince(dayAgo);

      const html = renderDigest(lics, {
        newKeys,
        showNav: true,
        title: country
          ? `Licitaciones — ${country}`
          : "Licitaciones Mesoamérica",
      });
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runPipeline(env)
        .then((s) => console.log("pipeline:", s))
        .then(() => sendDailyDigest(env))
        .then((r) => console.log("email:", r))
        .catch((e) => console.error("scheduled error:", (e as Error).message))
    );
  },
};

// ----- correo del digest (lo usan scheduled y /admin/email) -----

async function sendDailyDigest(env: Env, force = false): Promise<Record<string, unknown>> {
  if (!env.RESEND_API_KEY || !env.DIGEST_EMAIL_TO) {
    return { sent: false, reason: "correo no configurado (falta RESEND_API_KEY o DIGEST_EMAIL_TO)" };
  }
  const storage = new Storage(env.DB);
  const lics = await storage.vigentes("CR");
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const newKeys = await storage.seenSince(dayAgo);
  const newLics = lics.filter((l) => newKeys.has(dedupeKey(l)));

  if (newLics.length === 0 && !force) {
    return { sent: false, reason: "sin licitaciones nuevas hoy" };
  }

  const base = (env.PUBLIC_URL || "").replace(/\/$/, "");
  const asOf = new Date().toISOString().slice(0, 10);
  const html = renderDigestEmail(newLics.length ? newLics : lics.slice(0, 40), lics.length, base, asOf);
  const subject = newLics.length
    ? `${newLics.length} nuevas licitaciones — Mesoamérica CR (${asOf})`
    : `Licitaciones Mesoamérica CR (${asOf})`;

  const result = await sendEmail(env, subject, html);
  return { ...result, nuevas: newLics.length, vigentes: lics.length };
}

// ----- pipeline (lo usan scheduled y /admin/run) -----

async function runPipeline(env: Env): Promise<Record<string, unknown>> {
  const storage = new Storage(env.DB);
  const include = new Set(
    env.RELEVANT_CATEGORIES.split(",").map((s) => s.trim()).filter(Boolean)
  );

  const perSource: Record<string, unknown> = {};
  let totalRelevant = 0;

  for (const { name, fn, enrich } of FETCHERS) {
    const startedAt = new Date().toISOString();
    let lics: Licitacion[] = [];
    let error: string | undefined;

    try {
      lics = await fn(env);
    } catch (e) {
      error = (e as Error).message;
      console.error(`fetcher ${name} failed:`, error);
    }

    // Clasificar y filtrar
    const classified = lics.map(classify);
    const relevant = filterRelevant(classified, include.size > 0 ? include : null);
    totalRelevant += relevant.length;

    // Enriquecer con datos de detalle SOLO los que aún no tienen detalle
    // guardado (nuevos). Así la 1ª corrida llena el backlog y las siguientes
    // solo tocan lo nuevo, sin repetir llamadas caras.
    let enrichInfo: unknown = undefined;
    if (enrich && relevant.length > 0) {
      try {
        const already = await storage.enrichedKeys(relevant.map(dedupeKey));
        const pending = relevant.filter((l) => !already.has(dedupeKey(l)));
        if (pending.length > 0) {
          const stats = await enrich(pending, env);
          enrichInfo = { pending: pending.length, ...(stats ?? {}) };
        } else {
          enrichInfo = { pending: 0 };
        }
      } catch (e) {
        enrichInfo = { error: (e as Error).message };
        console.error(`enrich ${name} failed:`, (e as Error).message);
      }
    }

    // Guardar
    const counts = await storage.upsertMany(relevant);
    await storage.recordRun(name, startedAt, counts, error);

    perSource[name] = {
      fetched: lics.length,
      relevant: relevant.length,
      ...counts,
      error,
      ...(enrichInfo ? { enrich: enrichInfo } : {}),
    };
  }

  return {
    ran_at: new Date().toISOString(),
    total_relevant: totalRelevant,
    sources: perSource,
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
