// Ficha consolidada de un concurso, servida por nuestro Worker.
// Replica (y resume) el "Pliego de condiciones" de SICOP usando sus APIs
// públicas: cabecera, líneas, funcionarios y documentos.

const BASE = "https://prod-api.sicop.go.cr";
const HEADER_URL = `${BASE}/bid/api/v1/public/epCartel/findPublishedById`;
const PROD_URL = `${BASE}/bid/api/v1/public/epCartelProd/findByEpCartelId`;
const STAFF_URL = `${BASE}/bid/api/v1/public/epCartelRoleStaff/findByEpCartelId`;
const FILES_URL = `${BASE}/bid/api/v1/public/epCartelFile/getCartelFilesById`;
const PAR_URL = `${BASE}/comn/api/v1/public/comnFile/downloadWithPAR`;
const SICOP_SEARCH = "https://www.sicop.go.cr/app/module/bid/public/tenders";
const TIMEOUT_MS = 20_000;

type Dict = Record<string, unknown>;

interface ProdLine {
  prodNm?: string; prodQty?: number; prodUnit?: string;
  prodPrc?: number; budgetAmt?: number; currencyType?: string;
}
interface Staff { roleCd?: string; staffNm?: string; deptNm?: string; }
interface CartelFile {
  docNm?: string; clientFileNm?: string; fileSizeMb?: string; fileTypeNm?: string;
  serverFileNm?: string; fileServerPath?: string;
}
// Archivo con su enlace de descarga ya resuelto.
interface ResolvedFile extends CartelFile { url?: string }

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// En GET no mandamos Content-Type (algunos endpoints lo rechazan sin cuerpo).
function headers(withBody: boolean): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "User-Agent": UA,
    Origin: "https://www.sicop.go.cr",
    Referer: SICOP_SEARCH,
  };
  if (withBody) h["Content-Type"] = "application/json";
  return h;
}

async function req<T>(url: string, body?: unknown): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: body ? "POST" : "GET",
      signal: ac.signal,
      headers: headers(!!body),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function renderCartelDetail(cartelNo: string, cartelSeq: string): Promise<string> {
  let h: Dict;
  try {
    h = await req<Dict>(HEADER_URL, { cartelNo, cartelSeq });
  } catch (e) {
    return errorPage(`No se pudo cargar el concurso ${esc(cartelNo)} desde SICOP (${esc((e as Error).message)}).`);
  }

  // El resto es complementario: si falla, igual mostramos la ficha.
  const [lines, staff, files] = await Promise.all([
    req<{ content?: ProdLine[] }>(PROD_URL, {
      pageNumber: 0, pageSize: 200,
      tableSorter: { sorter: "", order: "desc" }, tableFilters: [],
      formFilters: [
        { field: "cartelNo", value: cartelNo },
        { field: "cartelSeq", value: cartelSeq },
      ],
    }).then((r) => r.content ?? []).catch(() => [] as ProdLine[]),
    req<Staff[]>(STAFF_URL, { cartelNo, cartelSeq }).catch(() => [] as Staff[]),
    req<CartelFile[]>(
      `${FILES_URL}?cartelNo=${encodeURIComponent(cartelNo)}&cartelSeq=${encodeURIComponent(cartelSeq)}&docFileSeqno=`
    ).catch(() => [] as CartelFile[]),
  ]);

  // Resolver el enlace de descarga de cada documento. SICOP devuelve una URL
  // firmada temporal (PAR), así que se pide al momento de ver la ficha.
  const resolved: ResolvedFile[] = await Promise.all(
    files.map(async (f) => {
      const path = `${str(f.fileServerPath).replace(/^\//, "")}/${str(f.serverFileNm)}`;
      if (!str(f.serverFileNm)) return f;
      try {
        const url = await reqText(`${PAR_URL}?fileUrl=${encodeURI(path)}`);
        return { ...f, url: url.trim().startsWith("http") ? url.trim() : undefined };
      } catch {
        return f;
      }
    })
  );

  return detailPage(h, lines, staff, resolved);
}

// Diagnóstico: prueba cada endpoint y reporta qué responde desde el Worker.
export async function diagnoseCartel(cartelNo: string, cartelSeq: string): Promise<unknown> {
  const filesUrl =
    `${FILES_URL}?cartelNo=${encodeURIComponent(cartelNo)}&cartelSeq=${encodeURIComponent(cartelSeq)}&docFileSeqno=`;

  async function probe(label: string, url: string, body?: unknown, withCT = true) {
    try {
      const h = headers(!!body);
      if (!withCT) delete h["Content-Type"];
      const r = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: h,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const t = await r.text();
      return { label, status: r.status, ct: r.headers.get("content-type"), len: t.length, sample: t.slice(0, 220) };
    } catch (e) {
      return { label, error: (e as Error).message };
    }
  }

  return {
    files_get: await probe("files GET", filesUrl),
    files_get_noheaders: await (async () => {
      try {
        const r = await fetch(filesUrl, { headers: { Accept: "application/json" } });
        const t = await r.text();
        return { status: r.status, len: t.length, sample: t.slice(0, 220) };
      } catch (e) {
        return { error: (e as Error).message };
      }
    })(),
    header_post: await probe("header POST", HEADER_URL, { cartelNo, cartelSeq }),
  };
}

// GET que devuelve texto plano (el endpoint de descarga devuelve la URL firmada).
async function reqText(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: headers(false), signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- helpers ----------
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
function str(v: unknown): string { return typeof v === "string" ? v.trim() : v == null ? "" : String(v); }
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function grp(n: number): string { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "."); }
function money(n: number | null, cur = "CRC"): string {
  if (n == null || n === 0) return "";
  return `${cur === "USD" ? "$" : "₡"}${grp(n)}`;
}
function fmtDt(v: unknown): string {
  const s = str(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return "";
  return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
}
function tc(s: string): string {
  if (!s || s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s(/-])([a-záéíóúñ])/g, (_, p, c) => p + c.toUpperCase());
}
// Combina "6" + "Meses" → "6 Meses"
function dur(v: unknown, unit: unknown): string {
  const n = num(v);
  if (n == null || n === 0) return "";
  return `${n} ${str(unit)}`.trim();
}

type Pair = [string, string];
function factsBlock(pairs: Pair[]): string {
  const rows = pairs.filter(([, v]) => v).map(
    ([k, v]) => `<div class="f"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`
  );
  return rows.length ? `<div class="facts">${rows.join("")}</div>` : "";
}
function section(title: string, inner: string): string {
  return inner ? `<h2>${esc(title)}</h2>${inner}` : "";
}
// Texto largo: lo recortamos para que la ficha siga legible.
function longText(v: unknown, max = 900): string {
  const s = str(v).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function detailPage(h: Dict, lines: ProdLine[], staff: Staff[], files: ResolvedFile[]): string {
  const title = str(h.cartelNm);
  const inst = str(h.cartelInstNm);
  const procNo = str(h.instCartelNo);
  const sicopNo = `${str(h.cartelNo)}-${str(h.cartelSeq)}`;
  const estado = str(h.cartelStatStr) || str(h.cartelStat);
  const budget = money(num(h.cartelBudget), "CRC") || money(num(h.cartelBudgetUsd), "USD");

  // 1. Información general
  const general = factsBlock([
    ["Presupuesto estimado", budget],
    ["Clasificación del objeto", tc(str(h.ppsTypeNm))],
    ["Tipo de procedimiento", tc(str(h.proceTypeNm))],
    ["Tipo de modalidad", tc(str(h.proceTypeDetailNm))],
    ["Publicación", fmtDt(h.regDt)],
    ["Inicio de recepción", fmtDt(h.biddocStartDt)],
    ["Cierre de recepción", fmtDt(h.biddocEndDt)],
    ["Apertura de ofertas", fmtDt(h.openbidDt)],
    ["Plazo del acto final", dur(h.wbidDur, h.wbidDurCriteriaNm)],
    ["Tipo de recepción", str(h.onlineYnNm)],
    ["Lugar de apertura", str(h.openbidSpot)],
    ["Concurso confidencial", str(h.cartelSecretYnNm)],
    ["Fuente de presupuesto", str(h.bdgtSrcNm)],
  ]);

  // 2. Funcionarios
  const admin = staff.find((s) => str(s.roleCd) === "4");
  const funcs = factsBlock([
    ["Elaborador", str(h.writerNm)],
    ["Encargado de publicación", str(h.executorNm)],
    ["Encargado de aclaraciones", str(h.explainStaffNm)],
    ["Evaluador / apertura", str(h.openbidExamStaffNm) || str(h.openbidStaffNm)],
    ["Recomendación acto final", str(h.poqStaffNm)],
    ["Administrador de contrato", admin ? `${str(admin.staffNm)}${admin.deptNm ? ` — ${str(admin.deptNm)}` : ""}` : ""],
  ]);

  // 3. Aclaración y objeción
  const aclara = factsBlock([
    ["Admite aclaraciones", str(h.explainAllowYnNm)],
    ["Límite para aclaraciones", fmtDt(h.explainRcvEndDt)],
    ["Límite para objeciones", fmtDt(h.opinionEndDt)],
  ]);

  // 4. Garantías
  const garant = factsBlock([
    ["Recepción de garantías", str(h.onlineGuarnDocRcvYnNm)],
    ["Garantía de participación", str(h.participationGuarnRcvYnNm)],
    ["Monto / % participación", money(num(h.participationGuarnAmt)) || str(h.participationGuarnAmtType)],
    ["Vigencia participación", dur(h.participationGuarnDur, "días")],
    ["Garantía de cumplimiento", str(h.fulfillmentGuarnRcvYnNm)],
    ["Monto / % cumplimiento", money(num(h.fulfillmentGuarnAmt)) || str(h.fulfillmentGuarnAmtType)],
    ["Colateral", str(h.collateralGuarnRcvYnNm)],
  ]);

  // 5. Oferta
  const oferta = factsBlock([
    ["Máx. ofertas base", str(h.biddocMaxCnt)],
    ["Máx. ofertas alternativas", str(h.abiddocMaxCnt)],
    ["Vigencia de la oferta", dur(h.biddocValDur, h.biddocValDurTypeNm)],
    ["Ofertas conjuntas", str(h.jointBidYnNm)],
    ["Mejora de precios", str(h.mejoraProceYnNm)],
    ["Revisión / reajuste de precios", str(h.amtReadjustYnNm)],
    ["Participación de proveedores", str(h.supplierLimitYnNm)],
  ]);

  // 6. Contrato
  const contrato = factsBlock([
    ["Vigencia del contrato", dur(h.contractDur, h.contractDurUnitNm)],
    ["Prórroga", dur(h.contractExtendDur, h.contractExtendDurUnitNm)],
    ["Pago por adelantado", str(h.advancedNm)],
    ["Monto adelanto", money(num(h.advancedAmt))],
    ["Órdenes de pedido", str(h.makeordersyn)],
  ]);

  const multa = longText(h.fine, 600);
  const multaBlock = multa ? `<div class="longtext"><div class="k">Multa / cláusula penal</div><p>${esc(multa)}</p></div>` : "";

  // 7. Líneas
  const linesRows = lines
    .map((l) => {
      const cur = str(l.currencyType) || "CRC";
      return (
        `<tr><td data-l="Descripción">${esc(str(l.prodNm))}</td>` +
        `<td data-l="Cantidad" class="r">${l.prodQty != null ? esc(l.prodQty) : ""} ${esc(str(l.prodUnit))}</td>` +
        `<td data-l="Precio unit." class="r">${esc(money(num(l.prodPrc), cur))}</td>` +
        `<td data-l="Presupuesto" class="r">${esc(money(num(l.budgetAmt), cur))}</td></tr>`
      );
    })
    .join("");
  const linesTotal = lines.reduce((s, l) => s + (num(l.budgetAmt) ?? 0), 0);
  const linesBlock = lines.length
    ? `<div class="tablewrap"><table class="lines"><thead><tr>
         <th>Descripción</th><th class="r">Cantidad</th><th class="r">Precio unit.</th><th class="r">Presupuesto</th>
       </tr></thead><tbody>${linesRows}</tbody>
       <tfoot><tr><td colspan="3" class="r"><b>Total referencia</b></td><td class="r"><b>${esc(money(linesTotal))}</b></td></tr></tfoot>
       </table></div>`
    : "";

  // 8. Documentos
  const docRows = files
    .map((f) => {
      const name = esc(str(f.docNm) || str(f.clientFileNm));
      const meta = `${esc(str(f.clientFileNm))}${f.fileSizeMb ? ` · ${esc(str(f.fileSizeMb))} MB` : ""}`;
      const label = f.url
        ? `<a href="${esc(f.url)}" target="_blank" rel="noopener" download>${name} ↓</a>`
        : `<b>${name}</b>`;
      return `<li>${label}<span class="doc-meta">${meta}</span></li>`;
    })
    .join("");
  const anyUrl = files.some((f) => f.url);
  const docsBlock = files.length
    ? `<ul class="docs">${docRows}</ul>` +
      `<p class="hint">${
        anyUrl
          ? "Los enlaces de descarga son temporales: si expiran, recargá esta ficha."
          : "Los archivos se descargan desde el expediente en SICOP."
      }</p>`
    : "";

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title) || "Concurso"} — SICOP</title>
<style>
  :root{--ink:#1a2330;--muted:#64748b;--line:#e5e9f0;--brand:#0a66c2;--brand-ink:#083d73;--bg:#f7f9fc;}
  *{box-sizing:border-box;}
  body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--ink);
       background:var(--bg);margin:0;padding:20px 14px 60px;overflow-wrap:anywhere;}
  .sheet{max-width:880px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:14px;padding:24px 26px;}
  .bar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px;}
  .back{color:var(--brand);text-decoration:none;font-size:14px;}
  .actions{display:flex;gap:8px;flex-wrap:wrap;}
  .btn{border:1px solid var(--line);background:#fff;color:var(--brand-ink);border-radius:8px;padding:7px 13px;
       font-size:13px;font-weight:600;text-decoration:none;cursor:pointer;}
  .btn.primary{background:var(--brand);color:#fff;border-color:var(--brand);}
  h1{font-size:20px;line-height:1.3;margin:0 0 4px;}
  .inst{color:var(--muted);margin:0 0 2px;font-size:14px;}
  .procno{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--muted);}
  .estado{display:inline-block;margin-top:8px;background:#e9f6ef;color:#0f7b4f;border-radius:999px;
          padding:3px 11px;font-size:12px;font-weight:700;}
  h2{font-size:14px;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line);
     text-transform:uppercase;letter-spacing:.04em;color:var(--muted);}
  .facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:12px 20px;}
  .f .k{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;}
  .f .v{font-weight:650;font-size:14.5px;}
  .longtext{margin-top:14px;}
  .longtext .k{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;}
  .longtext p{margin:4px 0 0;font-size:13.5px;color:#333c4a;}
  .tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
  table.lines{width:100%;border-collapse:collapse;font-size:13.5px;min-width:520px;}
  table.lines th{background:#f1f5fb;text-align:left;padding:8px 10px;border-bottom:2px solid var(--line);}
  table.lines td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;}
  table.lines .r{text-align:right;white-space:nowrap;}
  table.lines tfoot td{border-top:2px solid var(--line);}
  ul.docs{list-style:none;padding:0;margin:0;}
  ul.docs li{padding:9px 0;border-bottom:1px solid var(--line);font-size:14px;}
  ul.docs a{color:var(--brand);text-decoration:none;font-weight:650;}
  ul.docs a:hover{text-decoration:underline;}
  .doc-meta{display:block;color:var(--muted);font-size:12.5px;margin-top:2px;}
  .hint{color:var(--muted);font-size:12.5px;margin-top:8px;}
  .src{margin-top:24px;font-size:13px;color:var(--muted);}
  .src a{color:var(--brand);}
  @media (max-width:560px){
    body{padding:14px 10px 48px;}
    .sheet{padding:18px 16px;border-radius:12px;}
    h1{font-size:18px;}
    .facts{grid-template-columns:1fr;gap:10px;}
    table.lines{min-width:0;}
    table.lines thead{display:none;}
    table.lines tr{display:block;border-bottom:1px solid var(--line);padding:8px 0;}
    table.lines td{display:flex;justify-content:space-between;gap:12px;border:none;padding:3px 0;text-align:left;}
    table.lines td::before{content:attr(data-l);color:var(--muted);font-size:11.5px;text-transform:uppercase;flex-shrink:0;}
    table.lines td.r{text-align:right;white-space:normal;}
    table.lines tfoot td{border-top:1px solid var(--line);}
  }
  @media print{
    body{background:#fff;padding:0;}
    .sheet{border:none;border-radius:0;max-width:none;padding:0;}
    .actions,.back{display:none;}
    table.lines{min-width:0;}
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
  <p class="procno">${esc(procNo)} · SICOP ${esc(sicopNo)}</p>
  ${estado ? `<span class="estado">${esc(estado)}</span>` : ""}
  ${section("Información general", general)}
  ${section("Bien, servicio u obra", linesBlock)}
  ${section("Funcionarios relacionados", funcs)}
  ${section("Aclaraciones y objeciones", aclara)}
  ${section("Garantías", garant)}
  ${section("Oferta", oferta)}
  ${section("Condiciones de contrato", contrato + multaBlock)}
  ${section("Documentos del pliego", docsBlock)}
  <p class="src">Fuente: SICOP — Sistema Integrado de Compras Públicas de Costa Rica.
     Para ofertar o descargar documentos, ingresá al expediente en
     <a href="${esc(SICOP_SEARCH)}" target="_blank" rel="noopener">sicop.go.cr</a>
     y buscá el procedimiento <b>${esc(procNo)}</b>.</p>
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
