// Render HTML del digest. Standalone, inline CSS, listo para navegador o email.
// Presentación en tarjetas con todos los datos relevantes de cada concurso.

import { COUNTRIES, dedupeKey, type Licitacion } from "./schema";

// Etiquetas legibles de las categorías de interés (para chips de filtro y
// para los temas que puede elegir alguien al suscribirse). Exportadas para
// que index.ts use el mismo catálogo en el formulario de suscripción y en
// el filtrado del correo por tema.
export const CAT_LABEL: Record<string, string> = {
  urbanismo: "Urbanismo",
  ambiental: "Ambiental",
  residuos: "Residuos",
  "agua-saneamiento": "Agua y saneamiento",
  "obra-publica": "Obra pública",
  energia: "Energía",
  consultoria: "Consultoría",
  salud: "Salud",
  educacion: "Educación",
  seguridad: "Seguridad",
  transporte: "Transporte",
  tecnologia: "Tecnología",
  administracion: "Administración",
  agropecuario: "Agropecuario",
  "cultura-deporte": "Cultura y deporte",
};

// Antes residuos/agua-saneamiento se agrupaban bajo "ambiental" para no
// saturar los chips de filtro. Ahora que hay un botón por tema, cada
// categoría se muestra y filtra por separado — groupCat queda como
// identidad (se mantiene la función por si hace falta volver a agrupar).
const CAT_GROUP: Record<string, string> = {};
export function groupCat(c: string): string {
  return CAT_GROUP[c] ?? c;
}

// Categoría comodín para concursos que el clasificador no logró ubicar en
// ningún tema — así el chip "Sin categoría" permite verlos aparte sin que
// se pierdan de la lista general ("Todas" los sigue mostrando siempre).
const OTROS = "__otros__";

// Bandera del país (imagen, se ve igual en todos los sistemas incluido Windows).
// MULTI y desconocidos usan un globo.
function flagImg(iso: string): string {
  if (!/^[A-Za-z]{2}$/.test(iso)) return `<span class="flag flag-globe" aria-hidden="true">🌎</span>`;
  const cc = iso.toLowerCase();
  return (
    `<img class="flag" src="https://flagcdn.com/24x18/${cc}.png"` +
    ` srcset="https://flagcdn.com/48x36/${cc}.png 2x" width="24" height="18" alt="" loading="lazy">`
  );
}

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

// Íconos SVG inline (sin dependencias externas). Heredan color y tamaño
// del texto adyacente via currentColor y width/height en em.
const ICON_PATHS: Record<string, string> = {
  building: '<path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M9 7h2M9 11h2M9 15h2"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9a2.6 2 0 0 0-2.5-1.3c-1.5 0-2.6.8-2.6 1.9 0 2.3 5.2 1.2 5.2 3.5 0 1.1-1.1 1.9-2.6 1.9A2.6 2 0 0 1 9.5 15M12 6.3v11.4"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M16 3v4M8 3v4M4 11h16"/>',
  hash: '<path d="M5 9h14M5 15h14M11 4 9 20M15 4l-2 16"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  download: '<path d="M12 3v12M7 11l5 5 5-5M5 21h14"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
};
function icon(name: string): string {
  const p = ICON_PATHS[name];
  if (!p) return "";
  return (
    `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
    ` stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`
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

// Etiqueta corta de la fuente, para mostrar en cada tarjeta y filtrar.
// SICOP/BID son fijos; el PNUD cubre varias agencias ONU, así que lo
// leemos del raw si viene (UNICEF, UNOPS, PNUD…).
function getSourceLabel(l: Licitacion): string {
  if (l.source === "sicop_cr") return "SICOP";
  if (l.source === "panama_dgcp") return "PanamaCompra";
  if (l.source === "bid") return "BID";
  if (l.source === "world_bank") return "Banco Mundial";
  if (l.source === "undp") {
    const raw = l.raw as Record<string, unknown> | null;
    const ag = raw && typeof raw.agencia === "string" ? raw.agencia : "";
    return ag || "ONU";
  }
  return l.source.toUpperCase();
}

// Clase CSS por fuente, para colorear la etiqueta.
function getSourceClass(l: Licitacion): string {
  if (l.source === "sicop_cr") return "src-sicop";
  if (l.source === "panama_dgcp") return "src-pa";
  if (l.source === "bid") return "src-bid";
  if (l.source === "world_bank") return "src-wb";
  if (l.source === "undp") return "src-un";
  return "src-x";
}

// Enlace a NUESTRA página de detalle consolidada (solo para SICOP/CR, que
// tiene cartelSeq). Para otras fuentes usamos el source_url directo.
function detailHref(l: Licitacion): string {
  // Solo enlazamos a nuestra ficha si el id es un cartelNo real de SICOP
  // (numérico). Si no, el detalle no existe y mandamos al origen.
  if (l.source === "sicop_cr" && l.source_id && /^\d+$/.test(l.source_id)) {
    const raw = l.raw as Record<string, unknown> | null;
    const seq = raw && typeof raw.cartelSeq === "string" ? raw.cartelSeq : "00";
    return `/cartel?no=${encodeURIComponent(l.source_id)}&seq=${encodeURIComponent(seq)}`;
  }
  return l.source_url;
}

const STYLE = `
<style>
  :root {
    --ink:#1a2330; --muted:#5b6b84; --line:#e5e9f0; --bg:#f7f9fc;
    --brand:#0a66c2; --brand-ink:#083d73; --new:#fff8e1; --new-line:#f3d98b;
    --chip:#eef3fb; --chip-ink:#2a4a73; --ok:#0f7b4f;
  }
  .ico { width: 1em; height: 1em; flex: 0 0 auto; vertical-align: -0.12em; }
  .flag { width: 20px; height: 15px; border-radius: 2px; vertical-align: -2px; margin-right: 8px;
          box-shadow: 0 0 0 1px rgba(16,24,40,.08); object-fit: cover; }
  .flag-globe { font-size: 15px; margin-right: 6px; box-shadow: none; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         color: var(--ink); background: var(--bg); margin: 0; padding: 0 16px 48px;
         overflow-wrap: anywhere; word-break: break-word; }
  .wrap { max-width: 1180px; margin: 0 auto; }
  .wrap, header.top, .section, .card { max-width: 100%; }
  img, svg { max-width: 100%; }
  header.top { padding: 28px 0 8px; }
  .brand { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 12px; }
  .brand h1 { font-size: 25px; margin: 0; letter-spacing: -0.02em; font-weight: 800; color: var(--brand-ink); }
  .brand .tag { margin: 0; font-size: 14.5px; color: var(--ink); font-weight: 500; }
  .intro { margin: 8px 0 0; font-size: 13.5px; color: var(--muted); max-width: 760px; line-height: 1.5; }
  .sub { color: var(--muted); margin: 8px 0 0; font-size: 13px; }
  .nav { display: flex; flex-wrap: wrap; gap: 6px; margin: 18px 0 8px; }
  .nav a { background: #fff; border: 1px solid var(--line); color: var(--brand-ink);
           padding: 6px 12px; border-radius: 999px; font-size: 13px; text-decoration: none; }
  .nav a:hover { border-color: var(--brand); color: var(--brand); }
  /* Caja de suscripción: con ícono propio y acento para que no se confunda
     con la barra de búsqueda/filtros de más abajo. */
  .subscribe { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
               background: #eef4fc; border: 1px solid #d7e6f7; border-left: 4px solid var(--brand);
               border-radius: 12px; padding: 12px 16px; margin: 20px 0 22px; }
  .subscribe .sub-head { display: flex; align-items: center; gap: 11px; min-width: 0; }
  .subscribe .sub-icon { flex: 0 0 auto; width: 32px; height: 32px; border-radius: 999px;
                          background: var(--brand); color: #fff; display: flex; align-items: center;
                          justify-content: center; }
  .subscribe .sub-icon .ico { width: 1em; height: 1em; }
  .subscribe .sub-txt { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .subscribe .sub-txt strong { font-size: 14px; color: var(--brand-ink); }
  .subscribe .sub-txt span { font-size: 12.5px; color: var(--muted); }
  .subscribe .sub-row { display: flex; gap: 8px; flex: 1; min-width: 240px; max-width: 420px; }
  .subscribe input { flex: 1; min-width: 0; border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px;
                     font-size: 14px; background: #fff; color: var(--ink); }
  .subscribe button { background: var(--brand); color: #fff; border: none; border-radius: 8px; padding: 9px 16px;
                      font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  .subscribe button:hover { background: var(--brand-ink); }
  .subscribe .sub-topics { flex-basis: 100%; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .subscribe .sub-topics-label { font-size: 12px; color: var(--muted); }
  .subscribe .sub-topics-list { display: flex; gap: 12px; flex-wrap: wrap; }
  .sub-topic { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; color: var(--brand-ink);
               cursor: pointer; white-space: nowrap; }
  .sub-topic input { width: auto; flex: none; accent-color: var(--brand); cursor: pointer; }
  .country { margin: 26px 0 12px; font-size: 13px; font-weight: 700; letter-spacing: .04em;
             text-transform: uppercase; color: var(--muted); display: flex; align-items: center; gap: 8px; }
  .country::after { content: ""; flex: 1; height: 1px; background: var(--line); }
  .secnew { background: var(--ok); color: #fff; border-radius: 999px; padding: 1px 9px;
            font-size: 10.5px; font-weight: 700; text-transform: none; letter-spacing: normal; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 330px), 1fr)); gap: 14px; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 16px 16px 14px;
          display: flex; flex-direction: column; gap: 10px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
  .card.new { background: var(--new); border-color: var(--new-line); }
  .card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; flex-wrap: wrap; }
  .tags { display: flex; flex-wrap: wrap; gap: 5px; }
  .tag { background: var(--chip); color: var(--chip-ink); border-radius: 6px;
         padding: 2px 8px; font-size: 11.5px; font-weight: 600; }
  .pill-new { background: var(--ok); color: #fff; border-radius: 999px; padding: 2px 9px;
              font-size: 11px; font-weight: 700; white-space: nowrap; }
  .head { display: flex; flex-direction: column; gap: 3px; }
  .title { font-size: 16px; font-weight: 600; line-height: 1.4; margin: 0; overflow-wrap: anywhere; }
  .entity { color: var(--muted); font-size: 13px; margin: 0; display: flex; align-items: center; gap: 6px; min-width: 0; }
  .entity .etxt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mrow { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .monto { display: inline-flex; align-items: baseline; gap: 5px; font-size: 20px; font-weight: 700;
           color: var(--brand-ink); white-space: nowrap; }
  .monto .ico { align-self: center; }
  .closeat { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--muted); white-space: nowrap; }
  .detail { display: none; }
  .card.open .detail { display: block; }
  .facts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; font-size: 13px;
           border-top: 1px solid var(--line); padding-top: 12px; }
  .fact { min-width: 0; }
  .fact .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
  .fact .v { font-weight: 600; overflow-wrap: anywhere; }
  .detail-foot { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  .foot { display: flex; justify-content: space-between; align-items: center; gap: 10px;
          border-top: 1px solid var(--line); padding-top: 10px; }
  .procno { display: inline-flex; align-items: center; gap: 4px; min-width: 0;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); }
  .procno .ptxt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vermas { border: none; background: none; color: var(--brand); cursor: pointer; flex: 0 0 auto;
            display: inline-flex; align-items: center; gap: 4px; font-size: 13px; font-weight: 600; padding: 4px 2px; }
  .vermas:hover { color: var(--brand-ink); }
  .vermas .ico { transition: transform .15s ease; }
  .card.open .vermas .ico { transform: rotate(180deg); }
  .btn { background: var(--brand); color: #fff; text-decoration: none; padding: 7px 14px;
         border-radius: 8px; font-size: 13px; font-weight: 600; white-space: nowrap; display: inline-block; }
  .btn:hover { background: var(--brand-ink); }
  .btn-ghost { background: #fff; color: var(--brand-ink); border: 1px solid var(--line);
               display: inline-flex; align-items: center; gap: 5px; }
  .btn-ghost:hover { background: #fff; border-color: var(--brand); color: var(--brand); }
  .empty { background:#fff; border:1px solid var(--line); border-radius:12px; padding:28px; text-align:center; color:var(--muted); }
  /* Barra de búsqueda y filtros: ícono de lupa propio y fondo blanco en
     bloque (a diferencia de la caja de suscripción, de arriba, que es azul
     con ícono de sobre) para que se lean como dos cosas distintas. */
  .filters { position: sticky; top: 0; z-index: 5; background: #fff;
             border: 1px solid var(--line); border-radius: 12px;
             padding: 12px 14px 10px; margin-bottom: 4px; }
  .filters .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .search-wrap { position: relative; display: flex; align-items: center; flex: 1; min-width: 180px; }
  .search-wrap .ico { position: absolute; left: 13px; color: var(--muted); pointer-events: none; }
  .filters input[type=search] { width: 100%; border: 1px solid var(--line);
             border-radius: 999px; padding: 8px 14px 8px 34px; font-size: 14px; background: var(--bg); color: var(--ink); }
  .filters select { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 13px; background: #fff; color: var(--ink); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
  .chip { background: #fff; border: 1px solid var(--line); color: var(--chip-ink); cursor: pointer;
          padding: 5px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600; }
  .chip:hover { border-color: var(--brand); }
  .chip.on { background: var(--brand); color: #fff; border-color: var(--brand); }
  .chip .n { opacity: .7; font-weight: 600; margin-left: 4px; }
  .count { color: var(--muted); font-size: 13px; margin: 12px 0 2px; }
  .toprt { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .closebadge { border-radius: 999px; padding: 2px 9px; font-size: 11px; font-weight: 700; white-space: nowrap; }
  .closebadge.urgent { background: #fde8e8; color: #b42318; }
  .closebadge.soon   { background: #fef3d7; color: #9a6a00; }
  .closebadge.ok     { background: #eef3fb; color: #2a4a73; }
  .closebadge.past   { background: #eceff3; color: #64748b; }
  .srcbadge { border-radius: 4px; padding: 2px 7px; font-size: 10.5px; font-weight: 700;
              letter-spacing: .03em; text-transform: uppercase; white-space: nowrap; }
  .srcbadge.src-sicop { background: #e4edf7; color: #083d73; }
  .srcbadge.src-pa    { background: #fbe8e6; color: #8a2a1f; }
  .srcbadge.src-bid   { background: #e8f1e4; color: #2d5e1b; }
  .srcbadge.src-wb    { background: #efe7f7; color: #5a3a86; }
  .srcbadge.src-un    { background: #e4f0f7; color: #175a8a; }
  .srcbadge.src-x     { background: #eceff3; color: #475569; }
  .star { border: none; background: none; cursor: pointer; font-size: 18px; line-height: 1;
          color: #c4ccd8; padding: 0 2px; }
  .star.on { color: #f1b400; }
  .star:hover { color: #f1b400; }
  .selects { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 9px; }
  .selects select { flex: 1; min-width: 160px; }
  .noresults { display:none; background:#fff; border:1px solid var(--line); border-radius:12px;
               padding:28px; text-align:center; color:var(--muted); margin-top:12px; }
  @media (max-width: 560px) {
    body { padding: 0 10px 40px; font-size: 14.5px; }
    .brand h1 { font-size: 20px; }
    .grid { grid-template-columns: 1fr; gap: 12px; }
    .card { padding: 14px 13px 12px; }
    .facts { grid-template-columns: 1fr; gap: 8px; }
    .title { font-size: 15.5px; }
    .monto { font-size: 18px; }
    .filters { padding: 10px 12px 8px; }
    .filters .row { flex-direction: column; align-items: stretch; }
    .search-wrap, .filters select { width: 100%; min-width: 0; }
    .selects { flex-direction: column; }
    .selects select { width: 100%; min-width: 0; }
    .foot { gap: 8px; }
    .detail-foot .btn { width: 100%; text-align: center; justify-content: center; }
    .procno { font-size: 11.5px; }
    .card-top { gap: 6px; }
    .fact .v { font-size: 13.5px; }
    .nav { gap: 5px; }
    .nav a { padding: 5px 10px; font-size: 12.5px; }
    .subscribe { flex-direction: column; align-items: stretch; gap: 10px; }
    .subscribe .sub-row { max-width: none; min-width: 0; }
    .subscribe .sub-topics { flex-direction: column; align-items: flex-start; gap: 6px; }
  }
</style>
`;

export interface DigestOptions {
  newKeys?: Set<string>;    // publicadas en las últimas 24h (pill "NUEVO")
  weekKeys?: Set<string>;   // publicadas en los últimos 7 días (filtro)
  asOf?: string;
  title?: string;
  showNav?: boolean;
}

// Días hasta el cierre de recepción. Devuelve {label, cls} o null.
function closeBadge(closeIso: string | null): { label: string; cls: string } | null {
  if (!closeIso) return null;
  const close = new Date(closeIso).getTime();
  if (isNaN(close)) return null;
  const days = Math.ceil((close - Date.now()) / 86_400_000);
  if (days < 0) return { label: "Cerrado", cls: "past" };
  if (days === 0) return { label: "Cierra hoy", cls: "urgent" };
  if (days === 1) return { label: "Cierra mañana", cls: "urgent" };
  if (days <= 3) return { label: `Cierra en ${days} días`, cls: "urgent" };
  if (days <= 7) return { label: `Cierra en ${days} días`, cls: "soon" };
  return { label: `Cierra en ${days} días`, cls: "ok" };
}

// BID y PNUD no se enriquecen (las búsquedas secundarias costarían
// subrequests), pero el `raw` ya trae metadatos útiles. Los
// transforma en facts opcionales que la tarjeta puede mostrar.
function nonSicopFacts(l: Licitacion): Array<[string, string]> {
  const raw = l.raw as Record<string, unknown> | null;
  if (!raw) return [];
  const out: Array<[string, string]> = [];
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  if (l.source === "bid") {
    const tipo = str(raw.type);
    const tipoMap: Record<string, string> = {
      SPECIFIC: "Aviso específico",
      GENERAL: "Aviso general",
      EOI: "Expresión de interés",
    };
    if (tipo) out.push(["Tipo", tipoMap[tipo] ?? tipo]);
    const metodo = str(raw.prcrmnt_mthd_engl_nm);
    if (metodo) out.push(["Método", metodo]);
    const sector = str(raw.sector) || str(raw.sectorenglnm);
    if (sector) out.push(["Sector", sector]);
    const proyecto = str(raw.projectname);
    if (proyecto) out.push(["Proyecto", proyecto]);
  } else if (l.source === "undp") {
    const agencia = str(raw.agencia);
    if (agencia) out.push(["Agencia", agencia]);
    const area = str(raw.area);
    if (area && area !== "OTHER") out.push(["Área", area]);
    const ref = str(raw.ref);
    if (ref) out.push(["Referencia", ref]);
  } else if (l.source === "world_bank") {
    const tipo = str(raw.tipo);
    if (tipo) out.push(["Tipo", tipo]);
    const metodo = str(raw.metodo);
    if (metodo) out.push(["Método", metodo]);
    const proyecto = str(raw.proyecto);
    if (proyecto) out.push(["Proyecto", proyecto]);
    const ref = str(raw.ref);
    if (ref) out.push(["Referencia", ref]);
  }
  return out;
}

function card(l: Licitacion, isNew: boolean, isWeek: boolean): string {
  const e = getEnriched(l);
  const procNo = getProcNo(l);
  const montoStr = e ? money(e.montoCRC ?? null, e.montoUSD ?? null) : "";
  const badge = closeBadge(l.close_date);
  const srcLabel = getSourceLabel(l);
  const srcClass = getSourceClass(l);

  const srcTag = `<span class="srcbadge ${srcClass}">${esc(srcLabel)}</span>`;
  // Categorías agrupadas para mostrar (sin duplicados), con su etiqueta legible.
  const catGroups = [...new Set(l.categories.map(groupCat))].filter((c) => CAT_LABEL[c]);
  const catTags = catGroups
    .map((c) => `<span class="tag">${esc(CAT_LABEL[c])}</span>`)
    .join("");
  const tags = srcTag + catTags;

  const facts: string[] = [];
  const addFact = (k: string, v: string) => {
    if (v) facts.push(`<div class="fact"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`);
  };
  // Identificadores desagregados: número de procedimiento y número SICOP,
  // para ubicar la licitación por cualquiera de los dos.
  const sicopNo = l.source === "sicop_cr" && l.source_id && /^\d+$/.test(l.source_id) ? l.source_id : "";
  if (procNo) addFact("Nº procedimiento", procNo);
  if (sicopNo) addFact("Nº SICOP", sicopNo);
  if (e?.clasificacion) addFact("Clasificación", e.clasificacion);
  if (e?.tipoProceso) addFact("Tipo", e.tipoProceso);
  if (e?.modalidad) addFact("Modalidad", e.modalidad);
  // Facts específicos de BID/UNDP cuando no hay datos de enriquecimiento.
  if (!e) for (const [k, v] of nonSicopFacts(l)) addFact(k, v);
  addFact("Cierre recepción", fmtDt(l.close_date));
  if (e?.apertura) addFact("Apertura", fmtDt(e.apertura));
  addFact("Publicación", fmtDate(l.publish_date));
  if (e?.duracionContrato) addFact("Duración contrato", e.duracionContrato);
  if (e?.contacto) addFact("Contacto", e.contacto);

  const closeStr = fmtDt(l.close_date);
  const badgeBlock = badge
    ? `<span class="closebadge ${badge.cls}">${esc(badge.label)}</span>`
    : "";

  // Atributos para filtrar/ordenar en el navegador.
  // El texto de búsqueda incluye ambos números (procedimiento y SICOP) y una
  // versión del procedimiento sin guiones, para encontrar por cualquier parte.
  const procNoFlat = procNo.replace(/[-\s]/g, "");
  const dataText = esc(
    `${l.title} ${l.entity} ${procNo} ${procNoFlat} ${sicopNo}`.toLowerCase()
  );
  // Si no matcheó ningún tema, cae en "Sin categoría" para que el chip la
  // encuentre, pero el chip "Todas" la sigue mostrando siempre.
  const dataCats = esc(catGroups.length ? catGroups.join(" ") : OTROS);
  const dataMonto = e ? (e.montoUSD && e.montoUSD > 0 ? e.montoUSD * 520 : e.montoCRC ?? 0) : 0;
  const dataClose = esc(l.close_date ?? "");
  const dataInst = esc(l.entity.toLowerCase());
  const dataClasif = esc(e?.clasificacion ?? "");
  const dataSrc = esc(l.source);
  const favId = esc(l.source_id);

  const montoBlock = montoStr
    ? `<span class="monto">${icon("coin")}${esc(montoStr)}</span>`
    : "";
  const closeBlock = closeStr
    ? `<span class="closeat">${icon("calendar")}${esc(closeStr)}</span>`
    : "";
  const mrow = montoBlock || closeBlock
    ? `<div class="mrow">${montoBlock}${closeBlock}</div>`
    : "";

  return (
    `<article class="card ${isNew ? "new" : ""}"` +
    ` data-cats="${dataCats}" data-text="${dataText}"` +
    ` data-new="${isNew ? 1 : 0}" data-week="${isWeek ? 1 : 0}"` +
    ` data-monto="${dataMonto}" data-close="${dataClose}"` +
    ` data-inst="${dataInst}" data-clasif="${dataClasif}" data-src="${dataSrc}" data-id="${favId}">` +
    `<div class="card-top"><div class="tags">${badgeBlock}${tags}</div>` +
    `<div class="toprt">` +
    `<button class="star" data-fav="${favId}" title="Guardar" aria-label="Guardar">☆</button>` +
    `${isNew ? `<span class="pill-new">NUEVO</span>` : ""}</div></div>` +
    `<div class="head"><p class="title">${esc(l.title)}</p>` +
    `<p class="entity">${icon("building")}<span class="etxt">${esc(l.entity)}</span></p></div>` +
    mrow +
    `<div class="foot">` +
    (procNo
      ? `<span class="procno">${icon("hash")}<span class="ptxt">${esc(procNo)}</span></span>`
      : `<span class="procno"></span>`) +
    `<button class="vermas" type="button" aria-expanded="false">` +
    `<span class="vmtxt">Ver más</span>${icon("chevron")}</button>` +
    `</div>` +
    `<div class="detail">` +
    (facts.length ? `<div class="facts">${facts.join("")}</div>` : "") +
    `<div class="detail-foot">${detailButton(l)}${pdfButton(l)}</div>` +
    `</div>` +
    `</article>`
  );
}

// Para SICOP (con ficha propia) ofrecemos descargar la "ficha de preparación"
// como PDF: abre la ficha con ?pdf=1, que dispara la descarga automáticamente.
function pdfButton(l: Licitacion): string {
  const internal = l.source === "sicop_cr" && l.source_id && /^\d+$/.test(l.source_id);
  if (!internal) return "";
  const raw = l.raw as Record<string, unknown> | null;
  const seq = raw && typeof raw.cartelSeq === "string" ? raw.cartelSeq : "00";
  const href = `/cartel?no=${encodeURIComponent(l.source_id!)}&seq=${encodeURIComponent(seq)}&pdf=1`;
  return (
    `<a class="btn btn-ghost" href="${esc(href)}" target="_blank" rel="noopener">` +
    `${icon("download")}Ficha PDF</a>`
  );
}

// El botón de la tarjeta: para SICOP abre nuestra ficha consolidada en la
// misma pestaña; para BID/PNUD abre el aviso original en otra pestaña.
function detailButton(l: Licitacion): string {
  const href = detailHref(l);
  const internal =
    l.source === "sicop_cr" && l.source_id && /^\d+$/.test(l.source_id);
  if (internal) return `<a class="btn" href="${esc(href)}">Ver detalle →</a>`;
  return (
    `<a class="btn" href="${esc(href)}" target="_blank" rel="noopener">` +
    `Abrir en origen ↗</a>`
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

  // Para el encabezado: si la vista está filtrada a un solo país, el
  // subtítulo lo nombra; si no, describe la región completa.
  const singleCountry = byCountry.size === 1 ? [...byCountry.keys()][0] : null;
  const heroTag = singleCountry
    ? `Licitaciones públicas vigentes en ${COUNTRIES[singleCountry] ?? singleCountry}`
    : "Licitaciones públicas vigentes en Centroamérica, Panamá y República Dominicana";

  const weekKeys = opts.weekKeys ?? new Set<string>();
  const nuevas = lics.filter((l) => newKeys.has(dedupeKey(l))).length;
  const esta_semana = lics.filter((l) => weekKeys.has(dedupeKey(l))).length;

  // Conteo por categoría para los chips (una tarjeta cuenta una vez por
  // tema, aunque matchee varios términos del mismo). Las que no matchearon
  // ningún tema cuentan bajo "Sin categoría".
  const catCounts = new Map<string, number>();
  for (const l of lics) {
    const groups = new Set(l.categories.map(groupCat).filter((c) => CAT_LABEL[c]));
    if (groups.size === 0) groups.add(OTROS);
    for (const g of groups) catCounts.set(g, (catCounts.get(g) ?? 0) + 1);
  }

  const sections: string[] = [];
  for (const [country, items] of [...byCountry.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    items.sort((a, b) => {
      const an = newKeys.has(dedupeKey(a)) ? 0 : 1;
      const bn = newKeys.has(dedupeKey(b)) ? 0 : 1;
      if (an !== bn) return an - bn;
      return (a.close_date ?? "z").localeCompare(b.close_date ?? "z");
    });
    const cards = items
      .map((l) => card(l, newKeys.has(dedupeKey(l)), weekKeys.has(dedupeKey(l))))
      .join("");
    const nuevasCount = items.filter((l) => weekKeys.has(dedupeKey(l))).length;
    const nuevasBadge = nuevasCount
      ? ` <span class="secnew">${nuevasCount} esta semana</span>`
      : "";
    sections.push(
      `<section class="section">` +
      `<div class="country">${flagImg(country)}${esc(COUNTRIES[country] ?? country)} · ` +
      `<span class="secn">${items.length}</span>${nuevasBadge}</div>` +
      `<div class="grid">${cards}</div></section>`
    );
  }

  const body = sections.length
    ? sections.join("")
    : `<div class="empty">Sin concursos vigentes por ahora. El sistema se actualiza todos los días.</div>`;

  // Chips de categoría (+ Sin categoría + Esta semana + Guardados). Todos
  // los chips son exclusivos entre sí excepto Guardados, que se puede sumar
  // a cualquiera. Un chip por tema, en el orden declarado en CAT_LABEL;
  // solo se muestran los que tienen al menos un concurso.
  const chipOrder = Object.keys(CAT_LABEL);
  const chips =
    `<button class="chip on" data-cat="">Todas</button>` +
    chipOrder
      .filter((c) => catCounts.get(c))
      .map(
        (c) =>
          `<button class="chip" data-cat="${esc(c)}">${esc(CAT_LABEL[c])}` +
          `<span class="n">${catCounts.get(c)}</span></button>`
      )
      .join("") +
    (catCounts.get(OTROS)
      ? `<button class="chip" data-cat="${OTROS}">Sin categoría<span class="n">${catCounts.get(OTROS)}</span></button>`
      : "") +
    (esta_semana
      ? `<button class="chip" id="weekchip">Esta semana<span class="n">${esta_semana}</span></button>`
      : "") +
    `<button class="chip" id="favchip" data-fav-filter="1">★ Guardados</button>`;

  // Instituciones únicas (para el select)
  const insts = [...new Set(lics.map((l) => l.entity).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "es")
  );
  const instOptions =
    `<option value="">Todas las instituciones</option>` +
    insts.map((i) => `<option value="${esc(i.toLowerCase())}">${esc(i)}</option>`).join("");

  // Clasificaciones presentes (de los enriquecidos)
  const clasifSet = new Set<string>();
  for (const l of lics) {
    const e = getEnriched(l);
    if (e?.clasificacion) clasifSet.add(e.clasificacion);
  }
  const clasifOptions =
    `<option value="">Toda clasificación</option>` +
    [...clasifSet].sort().map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");

  // Fuentes presentes (SICOP, BID, UNDP) con su conteo
  const srcCounts = new Map<string, number>();
  for (const l of lics) srcCounts.set(l.source, (srcCounts.get(l.source) ?? 0) + 1);
  const SRC_LABEL: Record<string, string> = {
    sicop_cr: "SICOP",
    panama_dgcp: "PanamaCompra",
    bid: "BID",
    undp: "ONU (PNUD y otras)",
    world_bank: "Banco Mundial",
  };
  const srcOptions =
    `<option value="">Todas las fuentes</option>` +
    [...srcCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `<option value="${esc(s)}">${esc(SRC_LABEL[s] ?? s)} (${n})</option>`)
      .join("");

  const filters = sections.length
    ? `<div class="filters">
         <div class="row">
           <div class="search-wrap">${icon("search")}
             <input type="search" id="q" placeholder="Buscar por título, institución o número…" autocomplete="off">
           </div>
           <select id="sort">
             <option value="cierre">Orden: cierre más próximo</option>
             <option value="nuevos">Orden: más nuevos</option>
             <option value="monto">Orden: mayor presupuesto</option>
           </select>
         </div>
         <div class="chips">${chips}</div>
         <div class="selects">
           <select id="src">${srcOptions}</select>
           <select id="inst">${instOptions}</select>
           <select id="clasif">${clasifOptions}</select>
         </div>
       </div>
       <p class="count">Mostrando <b id="count">${lics.length}</b> de ${lics.length} concursos</p>`
    : "";

  // Nav dinámica: solo muestra los países que tienen datos en este momento.
  // Orden geográfico norte→sur; cualquier país nuevo aparece automáticamente.
  const GEO_ORDER = ["MX","GT","BZ","SV","HN","NI","CR","PA","DO","MULTI"];
  const countriesWithData = [...byCountry.keys()].sort(
    (a, b) => {
      const ai = GEO_ORDER.indexOf(a);
      const bi = GEO_ORDER.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    }
  );
  const countryLinks = countriesWithData
    .map((c) => `<a href="/?country=${esc(c)}">${flagImg(c)}${esc(COUNTRIES[c] ?? c)}</a>`)
    .join("\n         ");

  // El CSV y el JSON respetan el país actual (si la vista está filtrada).
  const curCountry = singleCountry ?? "";
  const dlQ = curCountry ? `?country=${esc(curCountry)}` : "";
  const nav = opts.showNav
    ? `<nav class="nav">
         <a href="/">Todas</a>
         ${countryLinks}
         <a href="/api/vigentes.csv${dlQ}">CSV</a>
         <a href="/api/vigentes.json${dlQ}">JSON</a>
       </nav>`
    : "";

  // Checkboxes de temas: quien se suscribe elige qué le interesa. Si no
  // marca ninguno, recibe todas las categorías (comportamiento por defecto).
  const topicChecks = Object.entries(CAT_LABEL)
    .map(
      ([key, label]) =>
        `<label class="sub-topic"><input type="checkbox" name="topics" value="${esc(key)}">${esc(label)}</label>`
    )
    .join("");

  const subscribeBox = opts.showNav
    ? `<form class="subscribe" method="post" action="/subscribe">
         <div class="sub-head">
           <span class="sub-icon">${icon("mail")}</span>
           <div class="sub-txt">
             <strong>Recibí las nuevas licitaciones por correo</strong>
             <span>Un resumen cuando aparezcan concursos nuevos. Te podés dar de baja cuando querás.</span>
           </div>
         </div>
         <div class="sub-row">
           <input type="email" name="email" required placeholder="tu@correo.com" aria-label="Tu correo electrónico">
           <button type="submit">Suscribirme</button>
         </div>
         <div class="sub-topics">
           <span class="sub-topics-label">Temas (opcional, si no marcás ninguno recibís todo):</span>
           <div class="sub-topics-list">${topicChecks}</div>
         </div>
       </form>`
    : "";

  const metaDesc =
    "Rastreador diario de licitaciones públicas abiertas en Centroamérica, Panamá y República " +
    "Dominicana — obra pública, salud, educación, ambiente, tecnología y más — tomadas directo de " +
    "SICOP, PanamaCompra, BID, PNUD y Banco Mundial.";

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(metaDesc)}">
<title>${esc(title)}</title>${STYLE}</head>
<body><div class="wrap">
<header class="top">
  <div class="brand">
    <h1>mesoameri.ca</h1>
    <p class="tag">${esc(heroTag)}</p>
  </div>
  <p class="intro">Rastreamos todos los días las licitaciones abiertas en la región — obra pública,
    salud, educación, ambiente, tecnología y más — directo desde las fuentes oficiales (SICOP,
    PanamaCompra, BID, PNUD, Banco Mundial). Elegí un tema o un país abajo, o suscribite para
    recibir las nuevas por correo.</p>
  <p class="sub">${asOf} · ${lics.length} vigentes${nuevas ? ` · ${nuevas} nuevas` : ""} · ${esc(totals)}</p>
</header>
${nav}
${subscribeBox}
${filters}
${body}
<div class="noresults" id="noresults">No hay concursos que coincidan con el filtro.</div>
</div>
${sections.length ? FILTER_SCRIPT : ""}
</body></html>`;
}

const FILTER_SCRIPT = `<script>
(function(){
  var q = document.getElementById('q');
  var sortSel = document.getElementById('sort');
  var instSel = document.getElementById('inst');
  var clasifSel = document.getElementById('clasif');
  var srcSel = document.getElementById('src');
  var catChips = Array.prototype.slice.call(document.querySelectorAll('.chip[data-cat]'));
  var favChip = document.getElementById('favchip');
  var weekChip = document.getElementById('weekchip');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var allChip = document.querySelector('.chip[data-cat=""]');
  // Chips exclusivos: categorías + "Esta semana"; solo uno activo a la vez.
  // Guardados (favOnly) es independiente y se suma a cualquiera.
  var exChips = catChips.slice();
  if (weekChip) exChips.push(weekChip);
  var sel = '';        // '' = Todas; slug de categoría; o '__week__'
  var favOnly = false;

  var FKEY='meso_fav';
  function loadFavs(){ try{ return JSON.parse(localStorage.getItem(FKEY)||'[]'); }catch(e){ return []; } }
  var favs = loadFavs();
  function isFav(id){ return favs.indexOf(id)>=0; }
  function toggleFav(id){ var i=favs.indexOf(id); if(i>=0)favs.splice(i,1); else favs.push(id);
    try{ localStorage.setItem(FKEY, JSON.stringify(favs)); }catch(e){} }
  function paintStars(){
    var stars=document.querySelectorAll('.star');
    for(var i=0;i<stars.length;i++){ var id=stars[i].getAttribute('data-fav');
      if(isFav(id)){ stars[i].classList.add('on'); stars[i].textContent='★'; }
      else { stars[i].classList.remove('on'); stars[i].textContent='☆'; } }
  }

  function sortGrids(mode){
    var grids = document.querySelectorAll('.grid');
    for (var g=0; g<grids.length; g++){
      var items = Array.prototype.slice.call(grids[g].children);
      items.sort(function(a,b){
        if (mode==='monto') return (parseFloat(b.dataset.monto)||0)-(parseFloat(a.dataset.monto)||0);
        if (mode==='nuevos'){
          var d = (parseInt(b.dataset.new)||0)-(parseInt(a.dataset.new)||0);
          if (d) return d;
          return (a.dataset.close||'9').localeCompare(b.dataset.close||'9');
        }
        return (a.dataset.close||'9').localeCompare(b.dataset.close||'9');
      });
      for (var i=0;i<items.length;i++) grids[g].appendChild(items[i]);
    }
  }

  function apply(){
    var term = (q.value||'').toLowerCase().trim();
    var inst = instSel.value, clasif = clasifSel.value;
    var src = srcSel ? srcSel.value : '';
    var catSel = (sel && sel !== '__week__') ? sel : '';
    var weekSel = sel === '__week__';
    var visible = 0;
    for (var i=0;i<cards.length;i++){
      var c = cards[i];
      var cats = (c.dataset.cats||'').split(' ');
      var matchCat = !catSel || cats.indexOf(catSel) >= 0;
      var matchText = !term || (c.dataset.text||'').indexOf(term)>=0;
      var matchInst = !inst || (c.dataset.inst||'')===inst;
      var matchClasif = !clasif || (c.dataset.clasif||'')===clasif;
      var matchSrc = !src || (c.dataset.src||'')===src;
      var matchFav = !favOnly || isFav(c.dataset.id);
      var matchWeek = !weekSel || c.dataset.week==='1';
      var show = matchCat && matchText && matchInst && matchClasif && matchSrc && matchFav && matchWeek;
      c.style.display = show ? '' : 'none';
      if (show) visible++;
    }
    sortGrids(sortSel.value);
    var cnt = document.getElementById('count'); if (cnt) cnt.textContent = visible;
    var secs = document.querySelectorAll('.section');
    for (var s=0;s<secs.length;s++){
      var any=false, cc=secs[s].querySelectorAll('.card');
      for (var j=0;j<cc.length;j++){ if (cc[j].style.display!=='none'){ any=true; break; } }
      secs[s].style.display = any ? '' : 'none';
    }
    document.getElementById('noresults').style.display = visible ? 'none' : 'block';
  }

  // Selección exclusiva: activa un chip y apaga los demás del grupo.
  // Volver a hacer clic en el activo regresa a "Todas".
  function setSel(v, chip){
    sel = (sel === v && v !== '') ? '' : v;
    exChips.forEach(function(x){ x.classList.remove('on'); });
    if (sel === '') { allChip.classList.add('on'); }
    else { chip.classList.add('on'); }
    apply();
  }
  catChips.forEach(function(ch){
    ch.addEventListener('click', function(){ setSel(ch.dataset.cat, ch); });
  });
  if (weekChip) weekChip.addEventListener('click', function(){ setSel('__week__', weekChip); });
  if (favChip) favChip.addEventListener('click', function(){
    favOnly = !favOnly; favChip.classList.toggle('on', favOnly); apply();
  });
  document.addEventListener('click', function(ev){
    var t = ev.target;
    if (!t || !t.closest) return;
    var vm = t.closest('.vermas');
    if (vm){
      var card = vm.closest('.card');
      if (card){
        var open = card.classList.toggle('open');
        vm.setAttribute('aria-expanded', open ? 'true' : 'false');
        var tx = vm.querySelector('.vmtxt');
        if (tx) tx.textContent = open ? 'Ver menos' : 'Ver más';
      }
      return;
    }
    var star = t.closest('.star');
    if (star){
      toggleFav(star.getAttribute('data-fav')); paintStars();
      if (favOnly) apply();
    }
  });
  q.addEventListener('input', apply);
  sortSel.addEventListener('change', apply);
  instSel.addEventListener('change', apply);
  clasifSel.addEventListener('change', apply);
  if (srcSel) srcSel.addEventListener('change', apply);
  paintStars();
  apply();
})();
</script>`;
