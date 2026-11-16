// Render HTML del digest. Standalone, inline CSS, listo para navegador o email.
// Presentación en tarjetas con todos los datos relevantes de cada concurso.

import { COUNTRIES, dedupeKey, type Licitacion } from "./schema";

// Etiquetas legibles de las categorías de interés (para chips de filtro).
const CAT_LABEL: Record<string, string> = {
  urbanismo: "Urbanismo",
  ambiental: "Ambiental",
  residuos: "Residuos",
  "agua-saneamiento": "Agua y saneamiento",
  "obra-publica": "Obra pública",
};

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
    --ink:#1a2330; --muted:#64748b; --line:#e5e9f0; --bg:#f7f9fc;
    --brand:#0a66c2; --brand-ink:#083d73; --new:#fff8e1; --new-line:#f3d98b;
    --chip:#eef3fb; --chip-ink:#2a4a73; --ok:#0f7b4f;
  }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         color: var(--ink); background: var(--bg); margin: 0; padding: 0 16px 48px;
         overflow-wrap: anywhere; word-break: break-word; }
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
          border-top: 1px solid var(--line); padding-top: 10px; flex-wrap: wrap; }
  .procno { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted);
            min-width: 0; }
  .btn { background: var(--brand); color: #fff; text-decoration: none; padding: 7px 14px;
         border-radius: 8px; font-size: 13px; font-weight: 600; white-space: nowrap; }
  .btn:hover { background: var(--brand-ink); }
  .empty { background:#fff; border:1px solid var(--line); border-radius:12px; padding:28px; text-align:center; color:var(--muted); }
  /* Barra de filtros */
  .filters { position: sticky; top: 0; z-index: 5; background: var(--bg);
             padding: 12px 0 10px; margin-bottom: 4px; border-bottom: 1px solid var(--line); }
  .filters .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .filters input[type=search] { flex: 1; min-width: 180px; border: 1px solid var(--line);
             border-radius: 999px; padding: 8px 14px; font-size: 14px; background: #fff; color: var(--ink); }
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
    h1 { font-size: 19px; }
    .grid { grid-template-columns: 1fr; gap: 12px; }
    .card { padding: 14px 13px 12px; }
    .facts { grid-template-columns: 1fr; gap: 8px; }
    .title { font-size: 15px; }
    .monto { font-size: 18px; }
    .filters { padding: 10px 0 8px; }
    .filters .row { flex-direction: column; align-items: stretch; }
    .filters input[type=search], .filters select { width: 100%; min-width: 0; }
    .selects { flex-direction: column; }
    .selects select { width: 100%; min-width: 0; }
    .foot { gap: 8px; }
    .foot .btn { width: 100%; text-align: center; }
    .procno { font-size: 11.5px; }
    .nav { gap: 5px; }
    .nav a { padding: 5px 10px; font-size: 12.5px; }
  }
</style>
`;

export interface DigestOptions {
  newKeys?: Set<string>;
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

function card(l: Licitacion, isNew: boolean): string {
  const e = getEnriched(l);
  const procNo = getProcNo(l);
  const montoStr = e ? money(e.montoCRC ?? null, e.montoUSD ?? null) : "";
  const badge = closeBadge(l.close_date);

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
  const badgeBlock = badge
    ? `<span class="closebadge ${badge.cls}">${esc(badge.label)}</span>`
    : "";

  // Atributos para filtrar/ordenar en el navegador
  const dataText = esc(`${l.title} ${l.entity} ${procNo}`.toLowerCase());
  const dataCats = esc(l.categories.join(" "));
  const dataMonto = e ? (e.montoUSD && e.montoUSD > 0 ? e.montoUSD * 520 : e.montoCRC ?? 0) : 0;
  const dataClose = esc(l.close_date ?? "");
  const dataInst = esc(l.entity.toLowerCase());
  const dataClasif = esc(e?.clasificacion ?? "");
  const favId = esc(l.source_id);

  return (
    `<article class="card ${isNew ? "new" : ""}"` +
    ` data-cats="${dataCats}" data-text="${dataText}"` +
    ` data-new="${isNew ? 1 : 0}" data-monto="${dataMonto}" data-close="${dataClose}"` +
    ` data-inst="${dataInst}" data-clasif="${dataClasif}" data-id="${favId}">` +
    `<div class="card-top"><div class="tags">${tags}</div>` +
    `<div class="toprt">${badgeBlock}` +
    `<button class="star" data-fav="${favId}" title="Guardar" aria-label="Guardar">☆</button>` +
    `${isNew ? `<span class="pill-new">NUEVO</span>` : ""}</div></div>` +
    `<div><p class="title">${esc(l.title)}</p><p class="entity">${esc(l.entity)}</p></div>` +
    montoBlock +
    (facts.length ? `<div class="facts">${facts.join("")}</div>` : "") +
    `<div class="foot"><span class="procno">${esc(procNo)}</span>` +
    `<a class="btn" href="${esc(detailHref(l))}">Ver detalle →</a></div>` +
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

  // Conteo por categoría (solo las de interés) para los chips.
  const catCounts = new Map<string, number>();
  for (const l of lics) {
    for (const c of l.categories) {
      if (CAT_LABEL[c]) catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
    }
  }

  const sections: string[] = [];
  for (const [country, items] of [...byCountry.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    items.sort((a, b) => {
      const an = newKeys.has(dedupeKey(a)) ? 0 : 1;
      const bn = newKeys.has(dedupeKey(b)) ? 0 : 1;
      if (an !== bn) return an - bn;
      return (a.close_date ?? "z").localeCompare(b.close_date ?? "z");
    });
    const cards = items.map((l) => card(l, newKeys.has(dedupeKey(l)))).join("");
    sections.push(
      `<section class="section">` +
      `<div class="country">${esc(COUNTRIES[country] ?? country)} · <span class="secn">${items.length}</span></div>` +
      `<div class="grid">${cards}</div></section>`
    );
  }

  const body = sections.length
    ? sections.join("")
    : `<div class="empty">Sin concursos vigentes por ahora. El sistema se actualiza todos los días.</div>`;

  // Chips de categoría (+ favoritos)
  const chipOrder = ["urbanismo", "ambiental", "residuos", "agua-saneamiento", "obra-publica"];
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
    (lics.filter((l) => /^municipalidad/i.test(l.entity.trim())).length
      ? `<button class="chip" id="munichip">Municipalidades<span class="n">` +
        `${lics.filter((l) => /^municipalidad/i.test(l.entity.trim())).length}</span></button>`
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

  const filters = sections.length
    ? `<div class="filters">
         <div class="row">
           <input type="search" id="q" placeholder="Buscar por título, institución o número…" autocomplete="off">
           <select id="sort">
             <option value="cierre">Orden: cierre más próximo</option>
             <option value="nuevos">Orden: más nuevos</option>
             <option value="monto">Orden: mayor presupuesto</option>
           </select>
         </div>
         <div class="chips">${chips}</div>
         <div class="selects">
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
    .map((c) => `<a href="/?country=${esc(c)}">${esc(COUNTRIES[c] ?? c)}</a>`)
    .join("\n         ");

  const nav = opts.showNav
    ? `<nav class="nav">
         <a href="/">Todas</a>
         ${countryLinks}
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
  var catChips = Array.prototype.slice.call(document.querySelectorAll('.chip[data-cat]'));
  var favChip = document.getElementById('favchip');
  var muniChip = document.getElementById('munichip');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var active = {};
  var favOnly = false;
  var muniOnly = false;
  var allChip = document.querySelector('.chip[data-cat=""]');

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

  function activeCount(){ return Object.keys(active).length; }

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
    var nCats = activeCount();
    var visible = 0;
    for (var i=0;i<cards.length;i++){
      var c = cards[i];
      var cats = (c.dataset.cats||'').split(' ');
      var matchCat = nCats===0;
      if (!matchCat){ for (var k=0;k<cats.length;k++){ if (active[cats[k]]){ matchCat=true; break; } } }
      var matchText = !term || (c.dataset.text||'').indexOf(term)>=0;
      var matchInst = !inst || (c.dataset.inst||'')===inst;
      var matchClasif = !clasif || (c.dataset.clasif||'')===clasif;
      var matchFav = !favOnly || isFav(c.dataset.id);
      var matchMuni = !muniOnly || (c.dataset.inst||'').indexOf('municipalidad') === 0;
      var show = matchCat && matchText && matchInst && matchClasif && matchFav && matchMuni;
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

  catChips.forEach(function(ch){
    ch.addEventListener('click', function(){
      var cat = ch.dataset.cat;
      if (cat===''){ active={}; catChips.forEach(function(x){x.classList.remove('on');}); allChip.classList.add('on'); }
      else {
        allChip.classList.remove('on');
        if (active[cat]){ delete active[cat]; ch.classList.remove('on'); }
        else { active[cat]=true; ch.classList.add('on'); }
        if (activeCount()===0) allChip.classList.add('on');
      }
      apply();
    });
  });
  if (favChip) favChip.addEventListener('click', function(){
    favOnly = !favOnly; favChip.classList.toggle('on', favOnly); apply();
  });
  if (muniChip) muniChip.addEventListener('click', function(){
    muniOnly = !muniOnly; muniChip.classList.toggle('on', muniOnly); apply();
  });
  document.addEventListener('click', function(ev){
    var t = ev.target;
    if (t && t.classList && t.classList.contains('star')){
      toggleFav(t.getAttribute('data-fav')); paintStars();
      if (favOnly) apply();
    }
  });
  q.addEventListener('input', apply);
  sortSel.addEventListener('change', apply);
  instSel.addEventListener('change', apply);
  clasifSel.addEventListener('change', apply);
  paintStars();
  apply();
})();
</script>`;
