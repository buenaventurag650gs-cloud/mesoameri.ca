// Costa Rica vía SICOP — API pública REAL (descubierta inspeccionando el portal).
//
// Endpoint:  POST https://prod-api.sicop.go.cr/bid/api/v1/public/epCartel/searchEpCartelsSp
// Sin autenticación (ruta /public/). Devuelve una página estilo Spring:
//   { content: [...], totalElements, totalPages, numberOfElements, ... }
//
// Estrategia "lista completa": en vez de solo lo publicado en 48h, buscamos
// TODOS los concursos abiertos (en recepción de ofertas) cuya descripción
// coincide con nuestros temas. El filtro `cartelNm` acepta coincidencias
// parciales e insensibles a mayúsculas, así que un término como "construc"
// capta construcción, reconstrucción, constructivas, etc. Unimos los
// resultados de todos los términos y deduplicamos por cartelNo.
// SICOP es el sistema central obligatorio de CR, así que esto cubre a casi
// todas las instituciones (municipalidades, MIDEPLAN, IFAM, ICT, INDER, etc.).

import { makeLicitacion, type Licitacion, type Status } from "../schema";
import { sleep, type FetcherEnv } from "./base";

const API_URL =
  "https://prod-api.sicop.go.cr/bid/api/v1/public/epCartel/searchEpCartelsSp";

// Detalle por cartel: presupuesto, tipo legible, clasificación, apertura, etc.
const DETAIL_URL =
  "https://prod-api.sicop.go.cr/bid/api/v1/public/epCartel/findPublishedById";

const MAX_ENRICH = 40; // tope de enriquecimientos NUEVOS por corrida
const ENRICH_DELAY_MS = 300;

const PAGE_SIZE = 30; // máximo que acepta la API (>30 da 422)
const WINDOW_DAYS = 60; // ventana de publicación para el universo de "abiertos"
const TERM_DELAY_MS = 250; // espaciar búsquedas: evita rate-limit (422)
const REQ_TIMEOUT_MS = 25_000;

// Términos de búsqueda (substrings) que cubren las categorías de interés.
// Alta cobertura; el clasificador luego descarta falsos positivos
// (p.ej. "urban" que pegue en un evento cultural).
const SEARCH_TERMS: string[] = [
  // urbanismo
  "plan regulador", "ordenamiento territorial", "catastro", "urban",
  "espacio public", "patrimonio arquitect", "parque",
  // ambiental
  "ambient", "hidrolog", "cuenca", "biodivers",
  // residuos
  "residu", "valorizab", "reciclaj",
  // agua y saneamiento
  "agua", "alcantarill", "acueducto", "saneamiento", "pluvial", "riego",
  // obra pública
  "construc", "remodelac", "vial", "carretera", "pavimen", "edificio",
  "aeropuerto", "puente",
];

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

export async function fetchSicopCr(_env: FetcherEnv): Promise<Licitacion[]> {
  const today = new Date();
  const from = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  // Ventana de apertura amplia pero dentro del límite de rango de la API.
  const openTo = new Date(Date.now() + 170 * 86_400_000);
  const dateFilters = [
    { field: "openbidDtFrom", value: crDate(from) },
    { field: "openbidDtTo", value: crDate(openTo) },
    { field: "proceType", value: "Todos" },
    { field: "biddocRcvYn", value: "Y" }, // en recepción de ofertas (abiertos)
    { field: "regDtFrom", value: crDate(from) },
    { field: "regDtTo", value: crDate(today) },
  ];

  const byId = new Map<string, Licitacion>();
  let okCount = 0;
  let lastError: string | null = null;

  for (const term of SEARCH_TERMS) {
    const body = {
      pageNumber: 0,
      pageSize: PAGE_SIZE,
      tableSorter: { sorter: "regDt", order: "desc" },
      tableFilters: [],
      formFilters: [...dateFilters, { field: "cartelNm", value: term }],
    };

    try {
      const data = await postJson<SpPage>(API_URL, body);
      okCount++;
      for (const c of data.content ?? []) {
        const lic = cartelToLicitacion(c);
        if (lic && lic.source_id && !byId.has(lic.source_id)) {
          byId.set(lic.source_id, lic);
        }
      }
    } catch (e) {
      lastError = (e as Error).message;
      console.warn(`sicop_cr term "${term}": ${lastError}`);
    }
    await sleep(TERM_DELAY_MS);
  }

  // Si NINGUNA búsqueda funcionó, es un fallo real (API caída / nos rechaza):
  // lo propagamos para que se vea en runs.json en vez de un 0 silencioso.
  if (okCount === 0 && lastError) {
    throw new Error(`sicop_cr: todas las búsquedas fallaron — ${lastError}`);
  }

  return [...byId.values()];
}

// Datos enriquecidos que guardamos dentro de `raw._enriched`.
export interface SicopEnriched {
  montoCRC: number | null;
  montoUSD: number | null;
  tipoProceso: string; // "Licitación Reducida"
  modalidad: string; // "Según demanda"
  clasificacion: string; // "Bienes" | "Servicios" | "Obras"
  apertura: string | null; // ISO
  duracionContrato: string; // "12 Meses"
  contacto: string;
  numLineas: number | null;
}

// Enriquece SOLO los concursos relevantes (ya filtrados) con una llamada de
// detalle cada uno. Muta cada Licitacion: mete el detalle en `raw._enriched`
// y completa close_date si venía nulo.
export async function enrichSicopCr(lics: Licitacion[]): Promise<void> {
  let n = 0;
  for (const lic of lics) {
    if (n >= MAX_ENRICH) break;
    const cartelNo = lic.source_id;
    const rawRec = (lic.raw ?? {}) as SpCartel;
    const cartelSeq = rawRec.cartelSeq ?? "00";
    if (!cartelNo) continue;

    try {
      const h = await postJson<Record<string, unknown>>(DETAIL_URL, {
        cartelNo,
        cartelSeq,
      });

      const enriched: SicopEnriched = {
        montoCRC: numOrNull(h.cartelBudget),
        montoUSD: numOrNull(h.cartelBudgetUsd),
        tipoProceso: titleCase(strOrEmpty(h.proceTypeNm)),
        modalidad: strOrEmpty(h.proceTypeDetailNm),
        clasificacion: titleCase(strOrEmpty(h.ppsTypeNm)),
        apertura: isoFromHeader(h.openbidDt),
        duracionContrato:
          h.contractDur != null && h.contractDur !== ""
            ? `${h.contractDur} ${strOrEmpty(h.contractDurUnitNm)}`.trim()
            : "",
        contacto: strOrEmpty(h.executorNm),
        numLineas: numOrNull(h.cartelProdCnt),
      };

      lic.raw = { ...rawRec, _enriched: enriched };

      // La cabecera trae fechas limpias; completamos cierre si faltaba.
      if (!lic.close_date) {
        const iso = isoFromHeader(h.biddocEndDt);
        if (iso) lic.close_date = iso;
      }
      n++;
    } catch (e) {
      console.warn(`sicop_cr enrich ${cartelNo}: ${(e as Error).message}`);
      // Sin enriquecer: el concurso igual se muestra con los datos del listado.
    }
    await sleep(ENRICH_DELAY_MS);
  }
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
async function postJson<T>(url: string, body: unknown): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // Cabeceras de navegador: el portal llama su API con estas, y algunas
        // APIs públicas rechazan requests "sin navegador". Mimetizamos.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Origin: "https://www.sicop.go.cr",
        Referer: "https://www.sicop.go.cr/app/module/bid/public/tenders",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const snippet = (await r.text().catch(() => "")).slice(0, 180);
      throw new Error(`HTTP ${r.status}${snippet ? ` — ${snippet}` : ""}`);
    }
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

// La cabecera (findPublishedById) ya devuelve ISO sin zona, p.ej.
// "2026-11-19T11:00:00" (hora local CR). Le añadimos el offset -06:00.
function isoFromHeader(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const se = m[6] ?? "00";
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${se}-06:00`;
}

// ---- Helpers de parseo tolerante ----
function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrEmpty(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// SICOP manda muchos textos EN MAYÚSCULAS ("LICITACIÓN REDUCIDA", "BIENES").
// Los pasamos a Capitalización por palabra para que la UI se vea prolija.
function titleCase(s: string): string {
  if (!s) return "";
  // Si no está todo en mayúsculas, lo dejamos como viene.
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .replace(/(^|[\s(/-])([a-záéíóúñ])/g, (_, p, c) => p + c.toUpperCase());
}
