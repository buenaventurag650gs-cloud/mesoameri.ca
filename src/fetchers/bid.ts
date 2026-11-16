// BID / IDB — avisos de adquisición de proyectos financiados por el Banco.
//
// Fuente: portal de datos abiertos del BID (CKAN con datastore activo).
//   https://data.iadb.org/api/3/action/datastore_search?resource_id=...
// El dataset "Procurement Notices" se actualiza a diario e incluye avisos
// específicos, generales y expresiones de interés (consultorías) con su
// fecha límite y el enlace al documento del aviso.
//
// Una sola integración cubre toda la región, así que al sumar países solo
// hay que agregarlos a COUNTRY_MAP.

import { makeLicitacion, type Licitacion } from "../schema";
import { sleep, type FetcherEnv } from "./base";

const API =
  "https://data.iadb.org/api/3/action/datastore_search";
const RESOURCE_ID = "856aabfd-2c6a-48fb-a8b8-19f3ff443618";

const PAGE = 100; // avisos por país (ordenados por fecha límite descendente)
const DELAY_MS = 250;
const TIMEOUT_MS = 20_000;

// Nombre del país en el dataset → nuestro código ISO.
const COUNTRY_MAP: Record<string, string> = {
  "COSTA RICA": "CR",
  "EL SALVADOR": "SV",
  GUATEMALA: "GT",
  HONDURAS: "HN",
  NICARAGUA: "NI",
  PANAMA: "PA",
  BELIZE: "BZ",
  "DOMINICAN REPUBLIC": "DO",
  MEXICO: "MX",
};

// Los títulos del BID a veces no traen las palabras clave que buscamos, pero
// el sector sí dice de qué va. Lo traducimos para que el clasificador lo vea.
const SECTOR_HINT: Record<string, string> = {
  "WATER AND SANITATION": "agua potable saneamiento alcantarillado",
  "URBAN DEVELOPMENT AND HOUSING": "desarrollo urbano vivienda",
  "ENVIRONMENT AND NATURAL DISASTERS": "ambiental gestion ambiental",
  "TRANSPORT": "vial carretera infraestructura",
  "SOCIAL INVESTMENT": "obra publica",
  "TOURISM": "espacio publico",
  "AGRICULTURE AND RURAL DEVELOPMENT": "riego cuenca",
};

interface Notice {
  noticeid?: string;
  type?: string; // SPECIFIC | GENERAL | EOI | AWARD
  countryname?: string;
  projectnumber?: string;
  projectname?: string;
  noticetitle?: string;
  documenturl?: string;
  proyecturl?: string;
  publicationdate?: string;
  deadline?: string;
  sectorenglnm?: string;
}

interface DsResponse {
  success?: boolean;
  result?: { records?: Notice[]; total?: number };
}

export async function fetchBid(_env: FetcherEnv): Promise<Licitacion[]> {
  const hoy = new Date().toISOString().slice(0, 10);
  const out: Licitacion[] = [];
  const seen = new Set<string>();
  let okCount = 0;
  let lastError: string | null = null;

  for (const [nombrePais, iso] of Object.entries(COUNTRY_MAP)) {
    const filters = encodeURIComponent(JSON.stringify({ countryname: nombrePais }));
    const url =
      `${API}?resource_id=${RESOURCE_ID}&filters=${filters}` +
      `&limit=${PAGE}&sort=${encodeURIComponent("deadline desc")}`;

    try {
      const data = await getJson<DsResponse>(url);
      okCount++;
      for (const n of data.result?.records ?? []) {
        // Solo avisos abiertos: con fecha límite de hoy en adelante.
        const dl = (n.deadline ?? "").slice(0, 10);
        if (!dl || dl < hoy) continue;
        // Las adjudicaciones no son oportunidades.
        if ((n.type ?? "").toUpperCase() === "AWARD") continue;

        const lic = toLicitacion(n, iso);
        if (lic && lic.source_id && !seen.has(lic.source_id)) {
          seen.add(lic.source_id);
          out.push(lic);
        }
      }
    } catch (e) {
      lastError = (e as Error).message;
      console.warn(`bid ${nombrePais}: ${lastError}`);
    }
    await sleep(DELAY_MS);
  }

  if (okCount === 0 && lastError) {
    throw new Error(`bid: todas las consultas fallaron — ${lastError}`);
  }
  return out;
}

function toLicitacion(n: Notice, iso: string): Licitacion | null {
  const id = (n.noticeid ?? "").trim();
  if (!id) return null;

  const sector = (n.sectorenglnm ?? "").trim().toUpperCase();
  const hint = SECTOR_HINT[sector] ?? "";
  const tipo =
    (n.type ?? "").toUpperCase() === "EOI"
      ? "Expresión de interés"
      : (n.type ?? "").toUpperCase() === "GENERAL"
      ? "Aviso general"
      : "Aviso específico";

  // El resumen lleva el sector traducido para que el clasificador lo capte.
  const resumen = [
    tipo,
    n.projectname ? `Proyecto: ${n.projectname}` : "",
    sector ? `Sector: ${sector}` : "",
    hint,
  ]
    .filter(Boolean)
    .join(" · ");

  return makeLicitacion({
    source: "bid",
    source_id: id,
    country: iso,
    entity: n.projectname ? `BID — ${n.projectname}` : "BID",
    title: (n.noticetitle ?? "").trim(),
    summary: resumen,
    status: "vigente",
    publish_date: (n.publicationdate ?? "").slice(0, 10) || null,
    close_date: n.deadline ? `${n.deadline.slice(0, 10)}T23:59:00-06:00` : null,
    source_url: n.documenturl || n.proyecturl || "https://projectprocurement.iadb.org/es/procurement-notices",
    raw: n,
  });
}

async function getJson<T>(url: string): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
