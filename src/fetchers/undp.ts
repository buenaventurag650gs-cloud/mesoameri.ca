// PNUD (UNDP) — avisos de adquisición desde los feeds RSS oficiales.
//
// Fuente: https://procurement-notices.undp.org/rss_feeds/<CODIGO>.xml
// Son RSS 1.0 (RDF), se actualizan cada hora y hay uno por país. Los códigos
// son propios del PNUD (COS = Costa Rica, ELS = El Salvador…), no ISO.
//
// El feed incluye avisos de PNUD y de otras agencias que publican ahí
// (UNCDF, UNOPS…), que es justo lo que traía el digest original.

import { makeLicitacion, type Licitacion } from "../schema";
import { sleep, type FetcherEnv } from "./base";

const BASE = "https://procurement-notices.undp.org/rss_feeds";
const DELAY_MS = 250;
const TIMEOUT_MS = 20_000;

// Código del feed → [código ISO nuestro, nombre del país]
const FEEDS: Record<string, [string, string]> = {
  COS: ["CR", "Costa Rica"],
  ELS: ["SV", "El Salvador"],
  GUA: ["GT", "Guatemala"],
  HON: ["HN", "Honduras"],
  NIC: ["NI", "Nicaragua"],
  PAN: ["PA", "Panamá"],
  BZE: ["BZ", "Belice"],
  DOM: ["DO", "República Dominicana"],
  MEX: ["MX", "México"],
};

// Siglas de agencia → nombre que mostramos.
const AGENCIAS: Record<string, string> = {
  UNDP: "PNUD",
  UNICEF: "UNICEF",
  UNOPS: "UNOPS",
  UNCDF: "UNCDF",
  UNFPA: "UNFPA",
  UNHCR: "ACNUR",
  WFP: "PMA",
  FAO: "FAO",
  WHO: "OMS",
};

export async function fetchUndp(_env: FetcherEnv): Promise<Licitacion[]> {
  const hoy = new Date().toISOString().slice(0, 10);
  const out: Licitacion[] = [];
  const seen = new Set<string>();
  let okCount = 0;
  let lastError: string | null = null;

  for (const [code, [iso, pais]] of Object.entries(FEEDS)) {
    try {
      const xml = await getText(`${BASE}/${code}.xml`);
      okCount++;
      for (const item of xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? []) {
        const lic = itemToLicitacion(item, iso, pais, hoy);
        if (lic && lic.source_id && !seen.has(lic.source_id)) {
          seen.add(lic.source_id);
          out.push(lic);
        }
      }
    } catch (e) {
      lastError = (e as Error).message;
      console.warn(`undp ${code}: ${lastError}`);
    }
    await sleep(DELAY_MS);
  }

  if (okCount === 0 && lastError) {
    throw new Error(`undp: todos los feeds fallaron — ${lastError}`);
  }
  return out;
}

function itemToLicitacion(
  item: string,
  iso: string,
  pais: string,
  hoy: string
): Licitacion | null {
  const link = tag(item, "link");
  const idMatch = link.match(/nego_id=(\d+)/);
  const id = idMatch ? idMatch[1] : "";
  if (!id) return null;

  // dc:subject viene más limpio que title (que repite la referencia y el país).
  const subject = tag(item, "dc:subject");
  const rawTitle = subject || tag(item, "title");

  // "UNDP-SLV-00593 - caracterización de los residuos sólidos - UNDP"
  const ref = (rawTitle.match(/^([A-Z]{3,6}(?:-[A-Z]{2,4})?-?[\w.]*)\s*-\s*/) || [])[1] ?? "";
  let titulo = rawTitle;
  if (ref) titulo = titulo.slice(ref.length).replace(/^\s*-\s*/, "").trim();
  // A veces la referencia viene repetida al inicio ("REF - REF - título").
  if (ref && titulo.startsWith(ref)) {
    titulo = titulo.slice(ref.length).replace(/^\s*-\s*/, "").trim();
  }
  // Quitar el sufijo de agencia y el país si quedaron pegados.
  titulo = titulo
    .replace(/\s*-\s*(UNDP|UNICEF|UNOPS|UNCDF|UNFPA|UNHCR|WFP|FAO|WHO)\s*$/i, "")
    .replace(new RegExp(`\\s*-\\s*${pais}\\s*$`, "i"), "")
    .trim();
  if (!titulo) return null;

  const deadlineRaw = tag(item, "undpprocnot:deadline");
  const deadline = deadlineRaw.slice(0, 10);
  // Solo avisos abiertos.
  if (!deadline || deadline < hoy) return null;

  const sigla = (ref.split("-")[0] || "UNDP").toUpperCase();
  const agencia = AGENCIAS[sigla] ?? sigla;
  const area = tag(item, "undpprocnot:area_desc");

  return makeLicitacion({
    source: "undp",
    source_id: id,
    country: iso,
    entity: `${agencia} ${pais}`,
    title: titulo,
    summary: [ref && `Referencia ${ref}`, area && area !== "OTHER" ? `Área: ${area}` : ""]
      .filter(Boolean)
      .join(" · "),
    status: "vigente",
    publish_date: tag(item, "dc:date").slice(0, 10) || null,
    close_date: deadlineRaw ? `${deadline}T23:59:00-06:00` : null,
    source_url: link,
    raw: { ref, area, deadline: deadlineRaw, pais },
  });
}

// ---- utilidades ----
function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]).trim() : "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function getText(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: "application/rss+xml, application/xml, text/xml, */*" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}
