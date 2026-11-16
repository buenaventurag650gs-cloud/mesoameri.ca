// Render HTML del digest. Standalone, inline CSS, listo para navegador o email.
// Presentación en tarjetas con todos los datos relevantes de cada concurso.

import { COUNTRIES, dedupeKey, type Licitacion } from "./schema";

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

// ---- Formateo ----
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = iso.slice(0, 10).split("-");
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : "";
}

function fmtDt(iso: string | null | undefined): string {
  if (!iso) return "";
  const [date, time] = iso.slice(0, 16).split("T");
  const d = date.split("-");
  if (d.length !== 3) return "";
  return `${d[2]}/${d[1]}/${d[0]}${time ? ` ${time}` : ""}`;
}

function groupThousands(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function money(crc: number | null, usd: number | null): string {
  if (crc != null && crc > 0) return `₡${groupThousands(crc)}`;
  if (usd != null && usd > 0) return `$${groupThousands(usd)}`;
  return "";
}

// Datos enriquecidos guardados dentro de raw._enriched (ver fetcher SICOP).
interface Enriched {
  montoCRC?: number | null;
  montoUSD?: number | null;
  tipoProceso?: string;
  modalidad?: string;
  clasificacion?: string;
  apertura?: string | null;
  duracionContrato?: string;
  contacto?: string;
  numLineas?: number | null;
}

function getEnriched(l: Licitacion): Enriched | null {
  const raw = l.raw as Record<string, unknown> | null;
  if (raw && typeof raw === "object" && raw._enriched) {
    return raw._enriched as Enriched;
  }
  return null;
}

function getProcNo(l: Licitacion): string {
  const raw = l.raw as Record<string, unknown> | null;
  if (raw && typeof raw.instCartelNo === "string") return raw.instCartelNo;
  // Fallback: el summary trae "Procedimiento <n>"
  const m = (l.summary || "").match(/Procedimiento\s+(\S+)/);
  return m ? m[1] : "";
}

const STYLE = `
<style>
  :root {
    --ink:#1a2330; --muted:#64748b; --line:#e5e9f0; --bg:#f7f9fc;
    --brand:#0a66c2; --brand-ink:#083d73; --new:#fff8e1; --new-line:#f3d98b;
    --chip:#eef3fb; --chip-ink:#2a4a73; --ok:#0f7b4f;
  }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         color: var(--ink); background: var(--bg); margin: 0; padding: 0 16px 48px; }
  .wrap { max-width: 1180px; margin: 0 auto; }
  header.top { padding: 28px 0 8px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); margin: 0; font-size: 14px; }
  .nav { display: flex; flex-wrap: wrap; gap: 6px; margin: 18px 0 8px; }
  .nav a { background: #fff; border: 1px solid var(--line); color: var(--brand-ink);
           padding: 6px 12px; border-radius: 999px; font-size: 13px; text-decoration: none; }
  .nav a:hover { border-color: var(--brand); color: var(--brand); }
  .country { margin: 26px 0 12px; font-size: 13px; font-weight: 700; letter-spacing: .04em;
             text-transform: uppercase; color: var(--muted); display: flex; align-items: center; gap: 8px; }
  .country::after { content: ""; flex: 1; height: 1px; background: var(--line); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 14px; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 16px 16px 14px;
          display: flex; flex-direction: column; gap: 10px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
  .card.new { background: var(--new); border-color: var(--new-line); }
  .card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
  .tags { display: flex; flex-wrap: wrap; gap: 5px; }
  .tag { background: var(--chip); color: var(--chip-ink); border-radius: 6px;
         padding: 2px 8px; font-size: 11.5px; font-weight: 600; }
  .pill-new { background: var(--ok); color: #fff; border-radius: 999px; padding: 2px 9px;
              font-size: 11px; font-weight: 700; white-space: nowrap; }
  .title { font-size: 15.5px; font-weight: 650; line-height: 1.35; margin: 0; }
  .entity { color: var(--muted); font-size: 13px; margin: -2px 0 0; }
  .monto { font-size: 19px; font-weight: 750; color: var(--brand-ink); }
  .monto .lbl { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase;
                letter-spacing: .04em; display: block; margin-bottom: -2px; }
  .facts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; font-size: 13px;
           border-top: 1px solid var(--line); padding-top: 10px; }
  .fact .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
  .fact .v { font-weight: 600; }
  .foot { display: flex; justify-content: space-between; align-items: center; gap: 10px;
          border-top: 1px solid var(--line); padding-top: 10px; }
  .procno { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); }
  .btn { background: var(--brand); color: #fff; text-decoration: none; padding: 7px 14px;
         border-radius: 8px; font-size: 13px; font-weight: 600; white-space: nowrap; }
  .btn:hover { background: var(--brand-ink); }
  .empty { background:#fff; border:1px solid var(--line); border-radius:12px; padding:28px; text-align:center; color:var(--muted); }
  @media (max-width: 420px) { .grid { grid-template-columns: 1fr; } }
</style>
`;

export interface DigestOptions {
  newKeys?: Set<string>;
  asOf?: string;
  title?: string;
  showNav?: boolean;
}

function card(l: Licitacion, isNew: boolean): string {
  const e = getEnriched(l);
  const procNo = getProcNo(l);
  const montoStr = e ? money(e.montoCRC ?? null, e.montoUSD ?? null) : "";

  const tags = l.categories.map((c) => `<span class="tag">${esc(c)}</span>`).join("");

  const facts: string[] = [];
  const addFact = (k: string, v: string) => {
    if (v) facts.push(`<div class="fact"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`);
  };
  if (e?.clasificacion) addFact("Clasificación", e.clasificacion);
  if (e?.tipoProceso) addFact("Tipo", e.tipoProceso);
  if (e?.modalidad) addFact("Modalidad", e.modalidad);
  addFact("Cierre recepción", fmtDt(l.close_date));
  if (e?.apertura) addFact("Apertura", fmtDt(e.apertura));
  addFact("Publicación", fmtDate(l.publish_date));
  if (e?.duracionContrato) addFact("Duración contrato", e.duracionContrato);
  if (e?.contacto) addFact("Contacto", e.contacto);

  const montoBlock = montoStr
    ? `<div class="monto"><span class="lbl">Presupuesto</span>${esc(montoStr)}</div>`
    : "";

  return (
    `<article class="card ${isNew ? "new" : ""}">` +
    `<div class="card-top"><div class="tags">${tags}</div>${isNew ? `<span class="pill-new">NUEVO</span>` : ""}</div>` +
    `<div><p class="title">${esc(l.title)}</p><p class="entity">${esc(l.entity)}</p></div>` +
    montoBlock +
    (facts.length ? `<div class="facts">${facts.join("")}</div>` : "") +
    `<div class="foot"><span class="procno">${esc(procNo)}</span>` +
    `<a class="btn" href="${esc(l.source_url)}" target="_blank" rel="noopener">Ver en SICOP →</a></div>` +
    `</article>`
  );
}

export function renderDigest(lics: Licitacion[], opts: DigestOptions = {}): string {
  const newKeys = opts.newKeys ?? new Set<string>();
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const title = opts.title ?? "Licitaciones Mesoamérica";

  const byCountry = new Map<string, Licitacion[]>();
  for (const l of lics) {
    if (!byCountry.has(l.country)) byCountry.set(l.country, []);
    byCountry.get(l.country)!.push(l);
  }

  const totals = [...byCountry.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([c, items]) => `${COUNTRIES[c] ?? c} ${items.length}`)
    .join(" · ");

  const nuevas = lics.filter((l) => newKeys.has(dedupeKey(l))).length;

  const sections: string[] = [];
  for (const [country, items] of [...byCountry.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Nuevas primero; dentro, por cierre más próximo.
    items.sort((a, b) => {
      const an = newKeys.has(dedupeKey(a)) ? 0 : 1;
      const bn = newKeys.has(dedupeKey(b)) ? 0 : 1;
      if (an !== bn) return an - bn;
      return (a.close_date ?? "z").localeCompare(b.close_date ?? "z");
    });
    const cards = items
      .map((l) => card(l, newKeys.has(dedupeKey(l))))
      .join("");
    sections.push(
      `<div class="country">${esc(COUNTRIES[country] ?? country)} · ${items.length}</div>` +
      `<div class="grid">${cards}</div>`
    );
  }

  const body = sections.length
    ? sections.join("")
    : `<div class="empty">Sin concursos vigentes por ahora. El sistema se actualiza todos los días.</div>`;

  const nav = opts.showNav
    ? `<nav class="nav">
         <a href="/">Todas</a>
         <a href="/?country=CR">Costa Rica</a>
         <a href="/?country=GT">Guatemala</a>
         <a href="/?country=SV">El Salvador</a>
         <a href="/?country=HN">Honduras</a>
         <a href="/?country=NI">Nicaragua</a>
         <a href="/?country=PA">Panamá</a>
         <a href="/api/vigentes.json">JSON</a>
       </nav>`
    : "";

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${STYLE}</head>
<body><div class="wrap">
<header class="top">
  <h1>${esc(title)}</h1>
  <p class="sub">${asOf} · ${lics.length} vigentes${nuevas ? ` · ${nuevas} nuevas` : ""} · ${esc(totals)}</p>
</header>
${nav}
${body}
</div></body></html>`;
}
