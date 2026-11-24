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
import { classify } from "./classifier";
import { CAT_LABEL, groupCat, renderDigest } from "./digest";
import { renderDigestEmail, sendBatch, sendEmail } from "./email";
import { FETCHERS } from "./fetchers";
import { enrichSicopCr } from "./fetchers/sicop_cr";
import { COUNTRIES, dedupeKey, type Licitacion } from "./schema";
import { Storage } from "./storage";
import {
  confirmEmailHtml,
  genToken,
  normalizeEmail,
  statusPage,
  unsubscribeUrl,
  validEmail,
} from "./subscribe";

export interface Env {
  DB: D1Database;
  USER_AGENT: string;
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

    // --- Descarga CSV (para pasar a Excel/Sheets) ---
    if (url.pathname === "/api/vigentes.csv") {
      const country = url.searchParams.get("country") ?? undefined;
      const lics = await storage.vigentes(country);
      const csv = toCsv(lics);
      const fname = `mesoamerica-${country ? country + "-" : ""}${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;
      return new Response("﻿" + csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${fname}"`,
        },
      });
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
      const autoPrint = url.searchParams.get("pdf") === "1";
      const html = await renderCartelDetail(no, seq, autoPrint);
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

    // --- Suscripción al correo (doble opt-in) ---
    const htmlPage = (body: string) =>
      new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    const base = (env.PUBLIC_URL || url.origin).replace(/\/$/, "");

    if (url.pathname === "/subscribe" && request.method === "POST") {
      const form = await request.formData().catch(() => null);
      const email = normalizeEmail(String(form?.get("email") ?? ""));
      if (!validEmail(email)) {
        return htmlPage(
          statusPage({
            title: "Correo inválido",
            heading: "Revisá el correo",
            message: "Ese correo no parece válido. Volvé e intentá de nuevo.",
            base,
            tone: "error",
          })
        );
      }
      if (!env.RESEND_API_KEY) {
        return htmlPage(
          statusPage({
            title: "No disponible",
            heading: "Suscripción no disponible",
            message: "El envío de correos aún no está configurado. Probá más tarde.",
            base,
            tone: "error",
          })
        );
      }
      // Temas elegidos (checkboxes "topics"); solo se guardan los que son
      // categorías válidas. Vacío = recibe todas las categorías.
      const chosenTopics = (form?.getAll("topics") ?? [])
        .map((t) => String(t))
        .filter((t) => t in CAT_LABEL);
      const topics = chosenTopics.join(",");

      const token = genToken();
      const result = await storage.addSubscriber(email, token, "CR", topics);
      if (result === "already") {
        return htmlPage(
          statusPage({
            title: "Ya suscrito",
            heading: "Ya estás suscrito",
            message: `${email} ya recibe el resumen de licitaciones. No hace falta hacer nada más.`,
            base,
            tone: "info",
          })
        );
      }
      await sendEmail(
        { ...env, DIGEST_EMAIL_TO: email },
        "Confirmá tu suscripción — Mesoamérica",
        confirmEmailHtml(base, email, token)
      );
      const topicsNote = chosenTopics.length
        ? ` Vas a recibir solo: ${chosenTopics.map((t) => CAT_LABEL[t]).join(", ")}.`
        : " Vas a recibir todas las categorías.";
      return htmlPage(
        statusPage({
          title: "Casi listo",
          heading: "Revisá tu correo",
          message: `Te enviamos un correo a ${email} para confirmar la suscripción. Hacé clic en el enlace y empezás a recibir las nuevas licitaciones.${topicsNote}`,
          base,
          tone: "ok",
        })
      );
    }

    if (url.pathname === "/confirm" && request.method === "GET") {
      const email = normalizeEmail(url.searchParams.get("e") ?? "");
      const token = url.searchParams.get("t") ?? "";
      const ok = await storage.confirmSubscriber(email, token);
      return htmlPage(
        statusPage({
          title: ok ? "Suscripción confirmada" : "Enlace inválido",
          heading: ok ? "¡Suscripción confirmada!" : "Enlace inválido o vencido",
          message: ok
            ? `Listo. Vas a recibir en ${email} el resumen de nuevas licitaciones de Costa Rica.`
            : "No pudimos confirmar la suscripción. Probá suscribirte de nuevo.",
          base,
          tone: ok ? "ok" : "error",
        })
      );
    }

    if (url.pathname === "/unsubscribe" && request.method === "GET") {
      const email = normalizeEmail(url.searchParams.get("e") ?? "");
      const token = url.searchParams.get("t") ?? "";
      const ok = await storage.unsubscribe(email, token);
      return htmlPage(
        statusPage({
          title: ok ? "Baja confirmada" : "Enlace inválido",
          heading: ok ? "Te diste de baja" : "Enlace inválido",
          message: ok
            ? `${email} ya no recibirá más correos. Podés volver a suscribirte cuando quieras.`
            : "No pudimos procesar la baja. Probá con el enlace más reciente.",
          base,
          tone: ok ? "ok" : "error",
        })
      );
    }

    // --- HTML digest (ruta por defecto) ---
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const country = url.searchParams.get("country") ?? undefined;
      const lics = await storage.vigentes(country);

      // Nuevas (últimas 24h) — se destacan con pill amarilla.
      // De esta semana (últimos 7 días) — para el filtro.
      const now = Date.now();
      const dayAgo = new Date(now - 24 * 3600 * 1000).toISOString();
      const weekAgo = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
      const [newKeys, weekKeys] = await Promise.all([
        storage.seenSince(dayAgo),
        storage.seenSince(weekAgo),
      ]);

      const html = renderDigest(lics, {
        newKeys,
        weekKeys,
        showNav: true,
        title: country
          ? `mesoameri.ca — Licitaciones en ${COUNTRIES[country] ?? country}`
          : "mesoameri.ca — Licitaciones públicas de Mesoamérica",
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
  if (!env.RESEND_API_KEY) {
    return { sent: false, reason: "correo no configurado (falta RESEND_API_KEY)" };
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
  const shown = newLics.length ? newLics : lics.slice(0, 40);
  const subject = newLics.length
    ? `${newLics.length} nuevas licitaciones — Mesoamérica CR (${asOf})`
    : `Licitaciones Mesoamérica CR (${asOf})`;

  // 1) Correo al destinatario administrador (DIGEST_EMAIL_TO), si está configurado.
  let adminResult: Record<string, unknown> = { sent: false, reason: "sin DIGEST_EMAIL_TO" };
  if (env.DIGEST_EMAIL_TO) {
    const html = renderDigestEmail(shown, lics.length, base, asOf);
    adminResult = { ...(await sendEmail(env, subject, html)) };
  }

  // 2) Correo a los suscriptores confirmados, por lotes (cada uno con su
  //    enlace de baja). Un subrequest por cada 100 suscriptores.
  //    Cada suscriptor puede haber elegido temas (urbanismo/ambiental/obra
  //    pública); si eligió alguno, su correo se filtra a solo esas
  //    categorías. Sin temas elegidos (topics === "") recibe todo.
  const subs = await storage.confirmedSubscribers();
  let omitidosSinNuevas = 0;
  const batch = subs
    .map((s) => {
      const subTopics = s.topics ? s.topics.split(",").filter(Boolean) : [];
      const matches = (l: Licitacion) =>
        subTopics.length === 0 || l.categories.some((c) => subTopics.includes(groupCat(c)));

      const subLics = subTopics.length ? lics.filter(matches) : lics;
      const subNewLics = subTopics.length ? newLics.filter(matches) : newLics;
      if (subNewLics.length === 0 && !force) {
        omitidosSinNuevas++;
        return null;
      }
      const subShown = subNewLics.length ? subNewLics : subLics.slice(0, 40);
      const subSubject = subNewLics.length
        ? `${subNewLics.length} nuevas licitaciones — Mesoamérica CR (${asOf})`
        : `Licitaciones Mesoamérica CR (${asOf})`;
      return {
        to: s.email,
        subject: subSubject,
        html: renderDigestEmail(subShown, subLics.length, base, asOf, unsubscribeUrl(base, s.email, s.token)),
      };
    })
    .filter((b): b is { to: string; subject: string; html: string } => b !== null);
  const batchResult = await sendBatch(env, batch);

  return {
    admin: adminResult,
    suscriptores: { total: subs.length, enviados: batch.length, sinNuevasParaSusTemas: omitidosSinNuevas, ...batchResult },
    nuevas: newLics.length,
    vigentes: lics.length,
  };
}

// ----- pipeline (lo usan scheduled y /admin/run) -----

// Rotación de fuentes por día de la semana para no superar el límite de
// subrequests del plan gratuito de Cloudflare (~50 por invocación).
//
//  SICOP (CR)      → todos los días (~39 subrequests — 1 por término de
//                     búsqueda; cubre TODOS los temas del clasificador,
//                     no solo los de urbanismo/ambiental)
//  PanamaCompra V3 → todos los días (1 sola llamada — API con filtros reales)
//  BID             → lun, jue       (9 subrequests)
//  UNDP            → mar, vie       (9 subrequests)
//  Banco Mundial   → mié, sáb       (9 subrequests)
//  domingo         → SICOP + PanamaCompra (mantenimiento mínimo)
//
// Cada fuente multilateral corre en su propio día (nunca dos pesadas juntas),
// así el pico diario es ~49 subrequests (39 SICOP + 1 Panamá + 9 multilateral),
// justo bajo el límite. El detalle de SICOP (presupuesto, tipo, apertura…)
// ya no se enriquece aquí — lo completa el cron de cada 2 horas, que no
// compite por este mismo presupuesto.
// Si se llama desde /admin/run?all=1, corre todo sin rotación (diagnóstico).
function activeFetchers(allSources = false): typeof FETCHERS {
  if (allSources) return FETCHERS;
  const dow = new Date().getUTCDay(); // 0=dom, 1=lun … 6=sáb
  return FETCHERS.filter(({ name }) => {
    if (name === "sicop_cr")     return true;               // siempre
    if (name === "panama_dgcp")  return true;               // siempre (1 request)
    if (name === "bid")          return [1, 4].includes(dow); // lun, jue
    if (name === "undp")         return [2, 5].includes(dow); // mar, vie
    if (name === "world_bank")   return [3, 6].includes(dow); // mié, sáb
    return true; // fuentes futuras: corren siempre por defecto
  });
}

async function runPipeline(env: Env, allSources = false): Promise<Record<string, unknown>> {
  const storage = new Storage(env.DB);

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

    // Clasificar por tema (para los chips/filtros del digest y el correo
    // por tema), pero ya no se descarta nada por categoría: se guarda todo
    // lo que trae la fuente, clasificado o no.
    const classified = lics.map(classify);
    totalRelevant += classified.length;

    // Enriquecer con datos de detalle SOLO los que aún no tienen detalle
    // guardado (nuevos). Así la 1ª corrida llena el backlog y las siguientes
    // solo tocan lo nuevo, sin repetir llamadas caras.
    let enrichInfo: unknown = undefined;
    if (enrich && classified.length > 0) {
      try {
        const already = await storage.enrichedKeys(classified.map(dedupeKey));
        const pending = classified.filter((l) => !already.has(dedupeKey(l)));
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
    const counts = await storage.upsertMany(classified);
    await storage.recordRun(name, startedAt, counts, error);

    perSource[name] = {
      fetched: lics.length,
      relevant: classified.length,
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

// CSV listo para abrir en Excel/Sheets. Separador por coma, texto entre
// comillas dobles, saltos de línea y comillas internas escapados.
function toCsv(lics: Licitacion[]): string {
  const headers = [
    "Fuente", "País", "Institución", "Título", "Categorías",
    "Monto CRC", "Monto USD", "Tipo", "Clasificación",
    "Publicación", "Cierre", "Nº procedimiento", "URL",
  ];
  const q = (v: unknown): string => {
    const s = v == null ? "" : String(v);
    return '"' + s.replace(/"/g, '""').replace(/\r?\n/g, " ") + '"';
  };
  const rows = lics.map((l) => {
    const raw = l.raw as Record<string, unknown> | null;
    const e = (raw && (raw as { _enriched?: Record<string, unknown> })._enriched) ?? null;
    const procNo = raw && typeof raw.instCartelNo === "string" ? raw.instCartelNo : "";
    return [
      l.source,
      l.country,
      l.entity,
      l.title,
      l.categories.join("; "),
      (e && typeof e.montoCRC === "number") ? e.montoCRC : "",
      (e && typeof e.montoUSD === "number") ? e.montoUSD : "",
      (e && typeof e.tipoProceso === "string") ? e.tipoProceso : "",
      (e && typeof e.clasificacion === "string") ? e.clasificacion : "",
      (l.publish_date ?? "").slice(0, 10),
      (l.close_date ?? "").slice(0, 16).replace("T", " "),
      procNo,
      l.source_url,
    ].map(q).join(",");
  });
  return [headers.map(q).join(","), ...rows].join("\r\n");
}
