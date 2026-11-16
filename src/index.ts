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

import { diagnoseCartel, renderCartelDetail } from "./cartel";
import { classify, filterRelevant } from "./classifier";
import { renderDigest } from "./digest";
import { renderDigestEmail, sendEmail } from "./email";
import { FETCHERS } from "./fetchers";
import { enrichSicopCr } from "./fetchers/sicop_cr";
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
      if (url.searchParams.get("debug") === "1") {
        return jsonResponse(await diagnoseCartel(no, seq));
      }
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
      const allSources = url.searchParams.get("all") === "1";
      const summary = await runPipeline(env, allSources);
      return jsonResponse(summary);
    }

    // --- Admin: completar detalle pendiente (prueba manual) ---
    if (url.pathname === "/admin/enrich" && request.method === "POST") {
      if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) {
        return new Response("Forbidden", { status: 403 });
      }
      const limit = Number(url.searchParams.get("limit") ?? "40") || 40;
      const result = await enrichBacklog(env, limit);
      return jsonResponse(result);
    }

    // --- Admin: borrar los 7 datos de muestra sembrados al inicio ---
    if (url.pathname === "/admin/cleanup-samples" && request.method === "POST") {
      if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) {
        return new Response("Forbidden", { status: 403 });
      }
      const borrados = await storage.deleteKeys(SAMPLE_KEYS);
      return jsonResponse({ borrados, claves: SAMPLE_KEYS.length });
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

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Dos crons:
    //  - diario 13:00 UTC (7am CR): buscar + clasificar + guardar + enviar correo
    //  - cada 2 horas: completar el detalle pendiente (sin búsquedas compitiendo)
    const cron = (event as { cron?: string }).cron ?? "";
    if (cron === "0 13 * * *") {
      ctx.waitUntil(
        runPipeline(env)
          .then((s) => console.log("pipeline:", s))
          .then(() => sendDailyDigest(env))
          .then((r) => console.log("email:", r))
          .catch((e) => console.error("scheduled error:", (e as Error).message))
      );
    } else {
      ctx.waitUntil(
        enrichBacklog(env)
          .then((r) => console.log("enrich backlog:", r))
          .catch((e) => console.error("enrich error:", (e as Error).message))
      );
    }
  },
};

// Los 7 registros de demo que sembramos a mano al montar la base. Sus números
// de SICOP son inventados, así que no se pueden enriquecer ni abrir.
const SAMPLE_KEYS = [
  "sicop_cr:2026LD-000096-0004200001",
  "sicop_cr:2026LD-000353-0000900001",
  "sicop_cr:2026LD-000016-0003000001",
  "sicop_cr:2026LY-000002-0021800611",
  "ungm:UNDP-SLV-00593",
  "ungm:LPI-044-2026",
  "ungm:UNDP-SLV-00587",
];

// ----- completar detalle pendiente (cron cada 2h y /admin/enrich) -----
// Corre SIN búsquedas, así todo el presupuesto de llamadas va al detalle.

async function enrichBacklog(env: Env, limit = 40): Promise<Record<string, unknown>> {
  const storage = new Storage(env.DB);
  const pending = await storage.pendingEnrichment("sicop_cr", limit);
  if (pending.length === 0) return { pendientes: 0, enriquecidos: 0, guardados: 0 };

  const stats = await enrichSicopCr(pending, limit);

  let guardados = 0;
  for (const lic of pending) {
    const raw = lic.raw as Record<string, unknown> | null;
    if (raw && raw._enriched) {
      try {
        await storage.updateRaw(dedupeKey(lic), raw, lic.close_date);
        guardados++;
      } catch (e) {
        console.warn(`updateRaw ${dedupeKey(lic)}: ${(e as Error).message}`);
      }
    }
  }

  const restantes = await storage.pendingEnrichment("sicop_cr", 1);
  return { pendientes: pending.length, ...stats, guardados, quedanPendientes: restantes.length > 0 };
}

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

// Rotación de fuentes por día de la semana para no superar el límite de
// subrequests del plan gratuito de Cloudflare (~50 por invocación).
//
//  SICOP (CR)  → todos los días   (~26 subrequests por término de búsqueda)
//  BID         → lun, mié, vie    (9 subrequests)
//  UNDP        → mar, jue, sáb    (9 subrequests)
//  domingo     → solo SICOP       (mantenimiento mínimo)
//
// Si se llama desde /admin/run?all=1, corre todo sin rotación (diagnóstico).
function activeFetchers(allSources = false): typeof FETCHERS {
  if (allSources) return FETCHERS;
  const dow = new Date().getUTCDay(); // 0=dom, 1=lun … 6=sáb
  return FETCHERS.filter(({ name }) => {
    if (name === "sicop_cr") return true;          // siempre
    if (name === "bid")  return [1, 3, 5].includes(dow); // lun, mié, vie
    if (name === "undp") return [2, 4, 6].includes(dow); // mar, jue, sáb
    return true; // fuentes futuras: corren siempre por defecto
  });
}

async function runPipeline(env: Env, allSources = false): Promise<Record<string, unknown>> {
  const storage = new Storage(env.DB);
  const include = new Set(
    env.RELEVANT_CATEGORIES.split(",").map((s) => s.trim()).filter(Boolean)
  );

  const perSource: Record<string, unknown> = {};
  let totalRelevant = 0;

  const fetchers = activeFetchers(allSources);
  for (const { name, fn, enrich } of fetchers) {
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
    fuentes_activas: fetchers.map((f) => f.name),
    total_relevant: totalRelevant,
    sources: perSource,
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
