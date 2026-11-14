// Render HTML del digest. Standalone, inline CSS, listo para email o navegador.

import { COUNTRIES, type Licitacion } from "./schema";

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

function fmtDt(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 16).replace("T", " ");
}

const STYLE = `
<style>
  body { font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         color: #222; max-width: 1100px; margin: 20px auto; padding: 0 16px; }
  h1   { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #666; margin: 0 0 20px; }
  table{ border-collapse: collapse; width: 100%; font-size: 13px; }
  th   { text-align: left; background: #f5f5f5; padding: 8px; border-bottom: 2px solid #ddd; }
  td   { padding: 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  tr.new td { background: #fffbe6; }
  .tag { display: inline-block; background: #eef; color: #335;
         border-radius: 3px; padding: 1px 6px; font-size: 11px; margin-right: 4px; }
  .country-header td { background: #333; color: #fff; font-weight: bold; padding: 6px 8px; }
  a    { color: #0a66c2; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .meta { color: #888; font-size: 12px; }
  .nav  { margin-bottom: 20px; }
  .nav a { background: #eef; padding: 4px 10px; border-radius: 4px; margin-right: 4px; }
</style>
`;

import { dedupeKey } from "./schema";

export interface DigestOptions {
  newKeys?: Set<string>;
  asOf?: string;
  title?: string;
  showNav?: boolean;
}

export function renderDigest(lics: Licitacion[], opts: DigestOptions = {}): string {
  const newKeys = opts.newKeys ?? new Set<string>();
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const title = opts.title ?? "Licitaciones Mesoamérica";

  // Agrupa por país
  const byCountry = new Map<string, Licitacion[]>();
  for (const l of lics) {
    if (!byCountry.has(l.country)) byCountry.set(l.country, []);
    byCountry.get(l.country)!.push(l);
  }

  const totals = [...byCountry.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([c, items]) => `${COUNTRIES[c] ?? c} ${items.length}`)
    .join(", ");

  const nuevas = lics.filter((l) => newKeys.has(dedupeKey(l))).length;

  const rows: string[] = [];
  for (const [country, items] of [...byCountry.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    rows.push(
      `<tr class="country-header"><td colspan="8">` +
      `${esc(COUNTRIES[country] ?? country)} · ${items.length}` +
      `</td></tr>`
    );
    items.sort((a, b) => (a.close_date ?? "z").localeCompare(b.close_date ?? "z"));
    for (const l of items) {
      const isNew = newKeys.has(dedupeKey(l));
      rows.push(
        `<tr class="${isNew ? "new" : ""}">` +
        `<td>${esc(l.status)}</td>` +
        `<td>${esc(l.entity)}</td>` +
        `<td>${esc(l.title)}<div class="meta">${esc(l.source_id)}</div></td>` +
        `<td>${esc((l.summary || "").slice(0, 300))}</td>` +
        `<td>${fmtDate(l.publish_date)}</td>` +
        `<td>${fmtDt(l.close_date)}</td>` +
        `<td>${l.categories.map((c) => `<span class="tag">${esc(c)}</span>`).join("")}</td>` +
        `<td><a href="${esc(l.source_url)}" target="_blank" rel="noopener">Ver</a></td>` +
        `</tr>`
      );
    }
  }

  const nav = opts.showNav
    ? `<div class="nav">
         <a href="/">Todas</a>
         <a href="/?country=CR">Costa Rica</a>
         <a href="/?country=GT">Guatemala</a>
         <a href="/?country=SV">El Salvador</a>
         <a href="/?country=HN">Honduras</a>
         <a href="/?country=NI">Nicaragua</a>
         <a href="/?country=PA">Panamá</a>
         <a href="/api/vigentes.json">JSON</a>
       </div>`
    : "";

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${STYLE}</head>
<body>
<h1>${esc(title)} — ${asOf}</h1>
<p class="sub">${lics.length} vigentes (${nuevas} nuevas). ${esc(totals)}.</p>
${nav}
<table>
<thead><tr>
<th>Estado</th><th>Entidad</th><th>Proceso</th><th>Resumen</th>
<th>Publicación</th><th>Cierre</th><th>Categorías</th><th>Enlace</th>
</tr></thead>
<tbody>${rows.join("")}</tbody>
</table>
</body></html>`;
}
