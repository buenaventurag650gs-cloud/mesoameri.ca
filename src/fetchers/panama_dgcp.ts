// Panamá vía PanamaCompra V3 — API pública REAL (descubierta inspeccionando
// el portal con el navegador).
//
// Endpoint:  POST https://apisv3.panamacompra.gob.pa/busqueda/proceso-lista-publico
// Sin autenticación. Filtramos por idEstado=36 ("Vigente"), que es el único
// estado activo que de verdad usa el sistema hoy (los IDs "Abierta"(8) y
// "Programada"(15) del catálogo público aparecen sin registros — la UI real
// solo usa "Vigente"). Igual que con SICOP, usamos una ventana de 60 días de
// publicación para cubrir licitaciones de Licitación Pública (30+ días de
// anticipación obligatoria) sin perder nada.
//
// El detalle de cada proceso (fecha límite de ofertas, monto, ítems) vive en
// otro endpoint mucho más pesado (~50 KB por proceso, estructura genérica de
// "componentes de página"), así que por ahora NO lo consultamos — igual que
// con Banco Mundial/BID/PNUD, mostramos lo que da la lista y el usuario entra
// al link para ver la fecha límite y el resto del pliego.
//
// Link al detalle: el portal arma la URL con un identificador ofuscado
// (base64 url-safe + reverso de la cadena) a partir de
// {i: idProcesosContratacionFlujos, tp: idTipoProceso}. Replicamos exactamente
// ese esquema (extraído del bundle de Angular del portal) para poder enlazar
// directo a la ficha pública, igual que hacemos con el PDF de SICOP.

import { makeLicitacion, type Licitacion, type Status } from "../schema";
import { type FetcherEnv } from "./base";

const API_URL = "https://apisv3.panamacompra.gob.pa/busqueda/proceso-lista-publico";
const PORTAL_ORIGIN = "https://www.panamacompra.gob.pa";

const WINDOW_DAYS = 60; // igual que SICOP: ventana de publicación amplia
const PAGE_SIZE = 500; // margen generoso (el volumen real en 60 días ronda ~250)
const ID_ESTADO_VIGENTE = 36; // "Vigente" — el único estado activo real en V3
const REQ_TIMEOUT_MS = 20_000;

interface ApiRegistro {
  idProcesosContratacion?: number;
  idProcesosContratacionFlujos?: number;
  titulo?: string;
  numProceso?: string;
  fechaPublicacion?: string;
  nombreRealizado?: string;
  idEstado?: number;
  nombreModalidad?: string;
  nombreEntidad?: string;
  nombreUnidadCompra?: string;
  nombreDependencia?: string;
  idTipoProceso?: number;
  nombre?: string; // tipo de proceso legible, ej. "Licitacion pública"
  prefijo?: string;
}

interface ApiResponse {
  status?: number;
  result?: {
    pagina?: number;
    registrosPorPagina?: number;
    totalRegistros?: number;
    totalPaginas?: number;
    registros?: ApiRegistro[];
  };
}

export async function fetchPanamaDgcp(env: FetcherEnv): Promise<Licitacion[]> {
  const hoy = new Date();
  const desde = new Date(Date.now() - WINDOW_DAYS * 86_400_000);

  const body = {
    registrosPorPagina: PAGE_SIZE,
    valorSiguiente: "",
    filtro: {
      idEstado: ID_ESTADO_VIGENTE,
      idTipoProceso: -1,
      fechaDesde: isoDate(desde),
      fechaHasta: isoDate(hoy),
      idProvincia: 0,
    },
  };

  const data = await postJson<ApiResponse>(API_URL, body, env);
  const registros = data.result?.registros ?? [];

  // Aviso suave si algún día el volumen supera la página pedida (no debería
  // pasar con 60 días de ventana, pero si pasa es mejor saberlo en los logs
  // que perder licitaciones en silencio).
  if (registros.length >= PAGE_SIZE) {
    console.warn(
      `panama_dgcp: la respuesta llegó al tope de ${PAGE_SIZE} registros; puede haber licitaciones sin traer.`
    );
  }

  const out: Licitacion[] = [];
  const seen = new Set<string>();
  for (const r of registros) {
    const lic = toLicitacion(r);
    if (lic && !seen.has(lic.source_id)) {
      seen.add(lic.source_id);
      out.push(lic);
    }
  }
  return out;
}

function toLicitacion(r: ApiRegistro): Licitacion | null {
  const id = r.idProcesosContratacion;
  const flujo = r.idProcesosContratacionFlujos;
  const numProceso = (r.numProceso ?? "").trim();
  const titulo = (r.titulo ?? "").trim();
  if (!id || !flujo || !numProceso || !titulo) return null;

  const entidad =
    [r.nombreEntidad?.trim(), r.nombreUnidadCompra?.trim()].filter(Boolean).join(" / ") ||
    "Panamá — Sector público";
  const resumen = [r.nombre, r.nombreModalidad, r.nombreDependencia]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" · ");

  const tipoProceso = r.idTipoProceso ?? -1;

  return makeLicitacion({
    source: "panama_dgcp",
    source_id: String(id),
    country: "PA",
    entity: entidad,
    title: titulo,
    summary: resumen,
    status: mapStatus(r.nombreRealizado),
    publish_date: (r.fechaPublicacion ?? "").slice(0, 10) || null,
    close_date: null, // no viene en la lista; está en el detalle (muy pesado de consultar por ítem)
    source_url: buildDetailUrl(numProceso, flujo, tipoProceso),
    raw: {
      numProceso,
      tipo: r.nombre,
      prefijo: r.prefijo,
      estado: r.nombreRealizado,
      dependencia: r.nombreDependencia,
      unidadCompra: r.nombreUnidadCompra,
    },
  });
}

function mapStatus(s?: string | null): Status {
  const t = (s ?? "").toLowerCase();
  if (t.includes("adjudic")) return "adjudicada"; // incluye "por adjudicar" (ya cerró a ofertas)
  if (t.includes("desiert")) return "desierta";
  if (t.includes("cancel") || t.includes("anulad")) return "cancelada";
  if (t.includes("suspend")) return "suspendida";
  if (t.includes("cerrad")) return "cerrada";
  if (t.includes("reclamo")) return "cerrada"; // en disputa, no acepta más ofertas
  if (t.includes("abiert") || t.includes("vigente") || t.includes("programad") || t.includes("autoriz")) {
    return "vigente";
  }
  return "desconocido";
}

// ---- Link al detalle público (mismo esquema que usa el portal) ----
//
// encodeUrl(json) = reverso( base64url( json ) )  — extraído del bundle
// Angular de PanamaCompra V3 (clase con encode/decode/switch).

function buildDetailUrl(numProceso: string, idFlujo: number, idTipoProceso: number): string {
  const esCotizacion = idTipoProceso === 2; // "Cotización en línea"
  const path = esCotizacion ? "solicitud-de-cotizacion" : "pliego-de-cargos";
  const token = encodeUrlToken(JSON.stringify({ i: idFlujo, tp: idTipoProceso }));
  return `${PORTAL_ORIGIN}/Inicio/#/${path}/${encodeURIComponent(numProceso)}/${token}`;
}

function b64encodeUtf8(str: string): string {
  const percent = encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_m, p1: string) =>
    String.fromCharCode(parseInt(p1, 16))
  );
  return btoa(percent);
}

function encodeUrlToken(str: string): string {
  const safe = b64encodeUtf8(str).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c] ?? "");
  return [...safe].reverse().join("");
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---- POST JSON con timeout ----
async function postJson<T>(url: string, body: unknown, env: FetcherEnv): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": env.USER_AGENT,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
