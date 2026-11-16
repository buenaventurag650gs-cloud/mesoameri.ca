// Costa Rica vía SICOP — API pública REAL (descubierta inspeccionando el portal).
//
// Endpoint:  POST https://prod-api.sicop.go.cr/bid/api/v1/public/epCartel/searchEpCartelsSp
// Sin autenticación (ruta /public/). Devuelve una página estilo Spring:
//   { content: [...], totalElements, totalPages, numberOfElements, ... }
//
// Para el digest diario pedimos los concursos PUBLICADOS en las últimas 48h
// que siguen EN RECEPCIÓN DE OFERTAS (biddocRcvYn = "Y" ≈ vigentes).
// SICOP es el sistema central obligatorio de CR, así que esto cubre a casi
// todas las instituciones (municipalidades, MIDEPLAN, IFAM, ICT, INDER, etc.).

import { makeLicitacion, type Licitacion, type Status } from "../schema";
import { sleep, type FetcherEnv } from "./base";

const API_URL =
  "https://prod-api.sicop.go.cr/bid/api/v1/public/epCartel/searchEpCartelsSp";

const PAGE_SIZE = 30; // confirmado OK; >50 puede dar 422
const MAX_PAGES = 25; // tope de seguridad
const LOOKBACK_DAYS = 2; // publicados en las últimas ~48h
const PAGE_DELAY_MS = 500; // espaciar requests: evita el rate-limit (422)
const REQ_TIMEOUT_MS = 25_000;

// La página pública de consulta de concursos (no hay deep-link por cartel:
// el detalle lo arma el front con el nº de procedimiento).
const PUBLIC_SEARCH_URL =
  "https://www.sicop.go.cr/app/module/bid/public/tenders";

interface SpCartel {
  instCartelNo?: string; // "2026LD-000057-0001800002" (nº de procedimiento, legible)
  cartelNo?: string; // "20261102136" (id interno estable → source_id)
  cartelSeq?: string; // "00"
  cartelNm?: string; // título / descripción corta
  cartelInstNm?: string; // institución
  cartelInstCd?: string; // cédula jurídica de la institución
  regDt?: string | null; // "dd/mm/yyyy hh:mm" — fecha de publicación
  biddocStartDt?: string | null; // inicio recepción de ofertas
  biddocEndDt?: string | null; // fin recepción de ofertas (cierre) — puede ser null
  openbidDt?: string | null; // fecha/hora de apertura
  proceType?: string; // LD, LY, PX, ...
  cartelStat?: string; // "En recepción de ofertas"
  cartelStatStr?: string;
}

interface SpPage {
  content?: SpCartel[];
  totalPages?: number;
  totalElements?: number;
  numberOfElements?: number;
}

export async function fetchSicopCr(env: FetcherEnv): Promise<Licitacion[]> {
  const today = new Date();
  const from = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const openTo = new Date(Date.now() + 365 * 86_400_000);

  const out: Licitacion[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = {
      pageNumber: page,
      pageSize: PAGE_SIZE,
      tableSorter: { sorter: "regDt", order: "desc" },
      tableFilters: [],
      formFilters: [
        { field: "openbidDtFrom", value: crDate(from) },
        { field: "openbidDtTo", value: crDate(openTo) },
        { field: "proceType", value: "Todos" },
        { field: "biddocRcvYn", value: "Y" }, // en recepción de ofertas
        { field: "regDtFrom", value: crDate(from) }, // publicados desde
        { field: "regDtTo", value: crDate(today) },
      ],
    };

    let data: SpPage;
    try {
      data = await postJson(API_URL, body, env);
    } catch (e) {
      console.warn(`sicop_cr page ${page}: ${(e as Error).message}`);
      break;
    }

    const items = data.content ?? [];
    if (items.length === 0) break;

    for (const c of items) {
      const lic = cartelToLicitacion(c);
      if (lic && lic.source_id && !seen.has(lic.source_id)) {
        seen.add(lic.source_id);
        out.push(lic);
      }
    }

    const totalPages = data.totalPages ?? 1;
    if (page + 1 >= totalPages) break;
    await sleep(PAGE_DELAY_MS);
  }

  return out;
}

function cartelToLicitacion(c: SpCartel): Licitacion | null {
  if (!c.cartelNo) return null;
  return makeLicitacion({
    source: "sicop_cr",
    source_id: c.cartelNo,
    country: "CR",
    entity: (c.cartelInstNm ?? "").trim(),
    title: (c.cartelNm ?? "").trim(),
    // La lista no trae descripción larga; el nº de procedimiento ayuda a ubicarlo.
    summary: c.instCartelNo ? `Procedimiento ${c.instCartelNo}` : "",
    status: mapStatus(c.cartelStat ?? c.cartelStatStr),
    publish_date: crDateToIsoDate(c.regDt),
    close_date: crDateToIsoDateTime(c.biddocEndDt ?? c.openbidDt),
    source_url: PUBLIC_SEARCH_URL,
    raw: c,
  });
}

function mapStatus(s?: string | null): Status {
  const t = (s ?? "").toLowerCase();
  if (t.includes("recepción") || t.includes("recepcion")) return "vigente";
  if (t.includes("adjudic")) return "adjudicada";
  if (t.includes("desiert")) return "desierta";
  if (t.includes("suspend")) return "suspendida";
  if (t.includes("cancel") || t.includes("anulad")) return "cancelada";
  if (t.includes("finaliz") || t.includes("cerrad")) return "cerrada";
  // Filtramos con biddocRcvYn=Y, así que por defecto están vigentes.
  return "vigente";
}

// ---- POST JSON con timeout ----
async function postJson<T>(url: string, body: unknown, env: FetcherEnv): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": env.USER_AGENT,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Fechas ----
// SICOP usa hora local de Costa Rica (UTC-6). Entrada "dd/mm/yyyy[ hh:mm[:ss]]".

function crDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

function splitCrDateTime(
  s: string | null | undefined
): { y: number; mo: number; d: number; h: number; mi: number; se: number } | null {
  if (!s) return null;
  const m = s
    .trim()
    .match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  return {
    d: +m[1],
    mo: +m[2],
    y: +m[3],
    h: m[4] ? +m[4] : 0,
    mi: m[5] ? +m[5] : 0,
    se: m[6] ? +m[6] : 0,
  };
}

function crDateToIsoDate(s: string | null | undefined): string | null {
  const p = splitCrDateTime(s);
  if (!p) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

function crDateToIsoDateTime(s: string | null | undefined): string | null {
  const p = splitCrDateTime(s);
  if (!p) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  // Hora local CR (UTC-06:00).
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.se)}-06:00`;
}
