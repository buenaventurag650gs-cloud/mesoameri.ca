// Página de detalle consolidada de un concurso, servida por nuestro Worker.
// Trae en vivo la cabecera (findPublishedById) y las líneas (epCartelProd) de
// SICOP y las muestra todo junto, lista para imprimir o guardar como PDF.

const HEADER_URL =
  "https://prod-api.sicop.go.cr/bid/api/v1/public/epCartel/findPublishedById";
const PROD_URL =
  "https://prod-api.sicop.go.cr/bid/api/v1/public/epCartelProd/findByEpCartelId";
const SICOP_SEARCH =
  "https://www.sicop.go.cr/app/module/bid/public/tenders";
const TIMEOUT_MS = 20_000;

interface ProdLine {
  prodNm?: string;
  prodQty?: number;
  prodUnit?: string;
  prodPrc?: number;
  budgetAmt?: number;
  currencyType?: string;
  cate?: string;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Origin: "https://www.sicop.go.cr",
        Referer: SICOP_SEARCH,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function renderCartelDetail(cartelNo: string, cartelSeq: string): Promise<string> {
  let header: Record<string, unknown>;
  try {
    header = await post<Record<string, unknown>>(HEADER_URL, { cartelNo, cartelSeq });
  } catch (e) {
    return errorPage(`No se pudo cargar el concurso ${esc(cartelNo)} desde SICOP (${esc((e as Error).message)}).`);
  }

  let lines: ProdLine[] = [];
  try {
    const prod = await post<{ content?: ProdLine[] }>(PROD_URL, {
      pageNumber: 0,
      pageSize: 200,
      tableSorter: { sorter: "", order: "desc" },
      tableFilters: [],
      formFilters: [
        { field: "cartelNo", value: cartelNo },
        { field: "cartelSeq", value: cartelSeq },
      ],
    });
    lines = prod.content ?? [];
  } catch {
    /* sin líneas: igual mostramos la cabecera */
  }

  return detailPage(header, lines);
}

// ---------- helpers ----------
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function group(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
function money(n: number | null, cur = "CRC"): string {
  if (n == null) return "—";
  const sym = cur === "USD" ? "$" : "₡";
  return `${sym}${group(n)}`;
}
function fmtDt(v: unknown): string {
  const s = str(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return "—";
  return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
}
function titleCase(s: string): string {
  if (!s || s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s(/-])([a-záéíóúñ])/g, (_, p, c) => p + c.toUpperCase());
}

function detailPage(h: Record<string, unknown>, lines: ProdLine[]): string {
  const title = str(h.cartelNm);
  const inst = str(h.cartelInstNm);
  const procNo = str(h.instCartelNo);
  const estado = str(h.cartelStatStr) || str(h.cartelStat);
  const budgetCrc = num(h.cartelBudget);
  const budgetUsd = num(h.cartelBudgetUsd);
  const budgetStr = budgetUsd && budgetUsd > 0 ? money(budgetUsd, "USD") : money(budgetCrc, "CRC");
  const tipo = [titleCase(str(h.proceTypeNm)), titleCase(str(h.proceTypeDetailNm))].filter(Boolean).join(" · ");
  const clasif = titleCase(str(h.ppsTypeNm));
  const dur = h.contractDur ? `${h.contractDur} ${str(h.contractDurUnitNm)}`.trim() : "";
  const contacto = str(h.executorNm);
  const fuente = str(h.bdgtSrcNm);
  const garantia = str(h.participationGuarnRcvYnNm);
  const garantiaAmt = num(h.participationGuarnAmt);

  const facts: Array<[string, string]> = [
    ["Presupuesto", budgetStr],
    ["Clasificación", clasif || "—"],
    ["Tipo de procedimiento", tipo || "—"],
    ["Publicación", fmtDt(h.regDt)],
    ["Inicio de recepción", fmtDt(h.biddocStartDt)],
    ["Cierre de recepción", fmtDt(h.biddocEndDt)],
    ["Apertura de ofertas", fmtDt(h.openbidDt)],
    ["Duración del contrato", dur || "—"],
    ["Contacto", contacto || "—"],
  ];
  if (fuente) facts.push(["Fuente de presupuesto", fuente]);
  if (garantia) facts.push(["Garantía de participación", garantiaAmt ? `${garantia} (${money(garantiaAmt)})` : garantia]);

  const factsHtml = facts
    .map(([k, v]) => `<div class="f"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`)
    .join("");

  const linesRows = lines
    .map((l) => {
      const cur = str(l.currencyType) || "CRC";
      return (
        `<tr><td>${esc(str(l.prodNm))}</td>` +
        `<td class="r">${l.prodQty != null ? esc(l.prodQty) : ""} ${esc(str(l.prodUnit))}</td>` +
        `<td class="r">${money(num(l.prodPrc), cur)}</td>` +
        `<td class="r">${money(num(l.budgetAmt), cur)}</td></tr>`
      );
    })
    .join("");

  const linesTotal = lines.reduce((s, l) => s + (num(l.budgetAmt) ?? 0), 0);
  const linesBlock = lines.length
    ? `<h2>Líneas del concurso (${lines.length})</h2>
       <table class="lines"><thead><tr>
         <th>Descripción</th><th class="r">Cantidad</th><th class="r">Precio unit.</th><th class="r">Presupuesto</th>
       </tr></thead><tbody>${linesRows}</tbody>
       <tfoot><tr><td colspan="3" class="r"><b>Total referencia</b></td><td class="r"><b>${esc(money(linesTotal))}</b></td></tr></tfoot>
       </table>`
    : "";

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title) || "Concurso"} — SICOP</title>
<style>
  :root{--ink:#1a2330;--muted:#64748b;--line:#e5e9f0;--brand:#0a66c2;--brand-ink:#083d73;--bg:#f7f9fc;}
  *{box-sizing:border-box;}
  body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg);margin:0;padding:24px 16px 60px;}
  .sheet{max-width:860px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:14px;padding:28px 30px;}
  .bar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px;}
  .back{color:var(--brand);text-decoration:none;font-size:14px;}
  .actions{display:flex;gap:8px;}
  .btn{border:1px solid var(--line);background:#fff;color:var(--brand-ink);border-radius:8px;padding:7px 13px;font-size:13px;font-weight:600;text-decoration:none;cursor:pointer;}
  .btn.primary{background:var(--brand);color:#fff;border-color:var(--brand);}
  h1{font-size:21px;line-height:1.3;margin:0 0 4px;}
  .inst{color:var(--muted);margin:0 0 2px;font-size:14px;}
  .procno{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--muted);}
  .estado{display:inline-block;margin-top:8px;background:#e9f6ef;color:#0f7b4f;border-radius:999px;padding:3px 11px;font-size:12px;font-weight:700;}
  .facts{display:grid;grid-template-columns:1fr 1fr;gap:12px 22px;margin:22px 0 6px;border-top:1px solid var(--line);padding-top:18px;}
  .f .k{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;}
  .f .v{font-weight:650;font-size:15px;}
  h2{font-size:15px;margin:26px 0 10px;}
  table.lines{width:100%;border-collapse:collapse;font-size:13.5px;}
  table.lines th{background:#f1f5fb;text-align:left;padding:8px 10px;border-bottom:2px solid var(--line);}
  table.lines td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;}
  table.lines .r{text-align:right;white-space:nowrap;}
  table.lines tfoot td{border-top:2px solid var(--line);}
  .src{margin-top:22px;font-size:13px;color:var(--muted);}
  .src a{color:var(--brand);}
  @media print{
    body{background:#fff;padding:0;}
    .sheet{border:none;border-radius:0;max-width:none;padding:0;}
    .actions,.back{display:none;}
  }
</style></head>
<body><div class="sheet">
  <div class="bar">
    <a class="back" href="/?country=CR">← Volver al listado</a>
    <div class="actions">
      <a class="btn" href="${esc(SICOP_SEARCH)}" target="_blank" rel="noopener">Ver en SICOP</a>
      <button class="btn primary" onclick="window.print()">Imprimir / Guardar PDF</button>
    </div>
  </div>
  <h1>${esc(title)}</h1>
  <p class="inst">${esc(inst)}</p>
  <p class="procno">${esc(procNo)}</p>
  ${estado ? `<span class="estado">${esc(estado)}</span>` : ""}
  <div class="facts">${factsHtml}</div>
  ${linesBlock}
  <p class="src">Fuente: SICOP — Sistema Integrado de Compras Públicas de Costa Rica.
     Para ofertar, ingresá al expediente en <a href="${esc(SICOP_SEARCH)}" target="_blank" rel="noopener">sicop.go.cr</a>
     (buscá el procedimiento <b>${esc(procNo)}</b>).</p>
</div></body></html>`;
}

function errorPage(msg: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Concurso no disponible</title></head>
<body style="font-family:-apple-system,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#1a2330;">
<p><a href="/?country=CR" style="color:#0a66c2;">← Volver al listado</a></p>
<h1 style="font-size:19px;">Concurso no disponible</h1>
<p style="color:#64748b;">${msg}</p>
</body></html>`;
}
