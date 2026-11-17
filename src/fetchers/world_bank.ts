// Banco Mundial — avisos de adquisición de proyectos financiados por el Banco.
//
// Fuente: API pública y sin API key del Banco Mundial.
//   https://search.worldbank.org/api/v2/procnotices?format=json&project_ctry_name=<País>
// Devuelve avisos de licitación (Invitation for Bids), expresiones de interés
// (REOI), avisos generales (GPN) y adjudicaciones (Contract Award). Nos
// quedamos solo con las oportunidades abiertas.
//
// Una sola integración cubre toda la región: para sumar países se agregan a
// COUNTRY_MAP con su nombre en inglés tal como lo usa el Banco.

import { makeLicitacion, type Licitacion } from "../schema";
import { sleep, type FetcherEnv } from "./base";

const API = "https://search.worldbank.org/api/v2/procnotices";
const DETAIL = "https://projects.worldbank.org/en/projects-operations/procurement-detail";

const ROWS = 60; // avisos por país (la API devuelve los más recientes primero)
const DELAY_MS = 250;
const TIMEOUT_MS = 20_000;

// Nombre del país en la API (inglés) → nuestro código ISO.
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

interface Notice {
  id?: string;
  notice_type?: string;
  notice_status?: string;
  noticedate?: string;
  submission_date?: string;
  submission_deadline_date?: string;
  submission_deadline_time?: string;
  project_ctry_name?: string;
  project_id?: string;
  project_name?: string;
  bid_reference_no?: string;
  bid_description?: string;
  procurement_group?: string;
  procurement_method_name?: string;
  contact_organization?: string;
  notice_text?: string;
}

interface ApiResponse {
  total?: string;
  procnotices?: Notice[];
}

export async function fetchWorldBank(_env: FetcherEnv): Promise<Licitacion[]> {
  const hoy = new Date().toISOString().slice(0, 10);
  const out: Licitacion[] = [];
  const seen = new Set<string>();
  let okCount = 0;
  let lastError: string | null = null;

  for (const [nombrePais, iso] of Object.entries(COUNTRY_MAP)) {
    const url =
      `${API}?format=json&rows=${ROWS}` +
      `&project_ctry_name=${encodeURIComponent(nombrePais)}`;

    try {
      const data = await getJson<ApiResponse>(url);
      okCount++;
      for (const n of data.procnotices ?? []) {
        // Las adjudicaciones no son oportunidades.
        if ((n.notice_type ?? "").toLowerCase().includes("award")) continue;
        // Solo avisos abiertos: si hay fecha límite, debe ser de hoy en
        // adelante. Los avisos sin fecha (GPN/anuncios tempranos) se mantienen.
        const dl = (n.submission_deadline_date ?? "").slice(0, 10);
        if (dl && dl < hoy) continue;

        // El país real lo da el aviso; si por algo no mapea, usamos el
        // país consultado como respaldo.
        const isoReal = COUNTRY_MAP[(n.project_ctry_name ?? "").toUpperCase()] ?? iso;
        const lic = toLicitacion(n, isoReal);
        if (lic && lic.source_id && !seen.has(lic.source_id)) {
          seen.add(lic.source_id);
          out.push(lic);
        }
      }
    } catch (e) {
      lastError = (e as Error).message;
      console.warn(`world_bank ${nombrePais}: ${lastError}`);
    }
    await sleep(DELAY_MS);
  }

  if (okCount === 0 && lastError) {
    throw new Error(`world_bank: todas las consultas fallaron — ${lastError}`);
  }
  return out;
}

function tipoAviso(t: string): string {
  const u = t.toLowerCase();
  if (u.includes("expression of interest")) return "Expresión de interés";
  if (u.includes("general procurement")) return "Aviso general";
  if (u.includes("invitation for bids")) return "Licitación";
  if (u.includes("request for")) return t; // RFB, RFP, RFQ…
  return t || "Aviso";
}

function toLicitacion(n: Notice, iso: string): Licitacion | null {
  const id = (n.id ?? "").trim();
  if (!id) return null;

  const tipo = tipoAviso(n.notice_type ?? "");
  const metodo = (n.procurement_method_name ?? "").trim();
  const resumen = [
    tipo,
    n.project_name ? `Proyecto: ${n.project_name}` : "",
    metodo ? `Método: ${metodo}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  // Fecha de cierre: date + hora (si viene). La API entrega la hora local del
  // proceso; la fijamos al huso de Centroamérica para el conteo de días.
  const dl = (n.submission_deadline_date ?? "").slice(0, 10);
  const hora = (n.submission_deadline_time ?? "").trim();
  const close = dl ? `${dl}T${hora || "23:59"}:00-06:00` : null;

  const entidad =
    (n.contact_organization ?? "").trim() ||
    (n.project_name ? `Banco Mundial — ${n.project_name}` : "Banco Mundial");

  // Guardamos un raw compacto (sin el HTML completo del aviso, que infla la fila).
  const raw = {
    tipo: n.notice_type,
    metodo: n.procurement_method_name,
    grupo: n.procurement_group,
    proyecto: n.project_name,
    ref: n.bid_reference_no,
    pais: n.project_ctry_name,
  };

  return makeLicitacion({
    source: "world_bank",
    source_id: id,
    country: iso,
    entity: entidad,
    title: (n.bid_description ?? "").trim(),
    summary: resumen,
    status: "vigente",
    publish_date:
      (n.submission_date ?? "").slice(0, 10) || parseLoose(n.noticedate) || null,
    close_date: close,
    source_url: `${DETAIL}/${encodeURIComponent(id)}`,
    raw,
  });
}

// "11-Nov-2026" → "2026-11-11" (o null si no parsea).
function parseLoose(s: string | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
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
