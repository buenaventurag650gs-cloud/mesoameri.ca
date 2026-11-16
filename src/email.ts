// Correo del digest diario vía Resend (https://resend.com).
// Se envía desde el cron tras la corrida, con las licitaciones NUEVAS del día.

import type { Licitacion } from "./schema";

const RESEND_URL = "https://api.resend.com/emails";

export interface EmailEnv {
  RESEND_API_KEY?: string;
  DIGEST_EMAIL_TO?: string; // destinatario (coma-separado para varios)
  DIGEST_EMAIL_FROM?: string; // remitente verificado; por defecto onboarding de Resend
  PUBLIC_URL?: string; // base para los enlaces (ej. https://....workers.dev)
}

export interface SendResult {
  sent: boolean;
  reason?: string;
  status?: number;
  id?: string;
}

// ---- helpers ----
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
function group(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
function monto(l: Licitacion): string {
  const raw = l.raw as Record<string, unknown> | null;
  const e = (raw && (raw._enriched as Record<string, unknown>)) || null;
  const crc = e && typeof e.montoCRC === "number" ? e.montoCRC : null;
  const usd = e && typeof e.montoUSD === "number" ? e.montoUSD : null;
  if (usd && usd > 0) return `$${group(usd)}`;
  if (crc && crc > 0) return `₡${group(crc)}`;
  return "";
}
function fmtClose(iso: string | null): string {
  if (!iso) return "";
  const [d, t] = iso.slice(0, 16).split("T");
  const p = d.split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}${t ? ` ${t}` : ""}` : "";
}
function detailUrl(base: string, l: Licitacion): string {
  const raw = l.raw as Record<string, unknown> | null;
  const seq = raw && typeof raw.cartelSeq === "string" ? raw.cartelSeq : "00";
  if (l.source === "sicop_cr" && l.source_id) {
    return `${base}/cartel?no=${encodeURIComponent(l.source_id)}&seq=${encodeURIComponent(seq)}`;
  }
  return l.source_url || base;
}

// Email HTML simple y compatible (estilos inline, sin scripts).
export function renderDigestEmail(
  newLics: Licitacion[],
  totalVigentes: number,
  base: string,
  asOf: string
): string {
  const items = newLics
    .slice(0, 60)
    .map((l) => {
      const m = monto(l);
      const cierre = fmtClose(l.close_date);
      const cats = l.categories.join(" · ");
      const meta = [m && `💰 ${m}`, cierre && `Cierre ${cierre}`].filter(Boolean).join("  ·  ");
      return (
        `<tr><td style="padding:12px 0;border-bottom:1px solid #e5e9f0;">` +
        `<div style="font-size:11px;color:#2a4a73;font-weight:600;text-transform:uppercase;letter-spacing:.03em;">${esc(cats)}</div>` +
        `<a href="${esc(detailUrl(base, l))}" style="font-size:15px;font-weight:600;color:#083d73;text-decoration:none;">${esc(l.title)}</a>` +
        `<div style="font-size:13px;color:#64748b;margin-top:2px;">${esc(l.entity)}</div>` +
        (meta ? `<div style="font-size:13px;color:#1a2330;margin-top:4px;">${esc(meta)}</div>` : "") +
        `</td></tr>`
      );
    })
    .join("");

  const extra = newLics.length > 60 ? `<p style="color:#64748b;font-size:13px;">…y ${newLics.length - 60} más.</p>` : "";

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"></head>
<body style="margin:0;background:#f7f9fc;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a2330;">
<div style="max-width:620px;margin:0 auto;padding:24px 18px;">
  <h1 style="font-size:19px;margin:0 0 2px;">Licitaciones Mesoamérica — Costa Rica</h1>
  <p style="color:#64748b;font-size:13px;margin:0 0 18px;">${esc(asOf)} · ${newLics.length} nuevas hoy · ${totalVigentes} vigentes en total</p>
  <table style="width:100%;border-collapse:collapse;">${items}</table>
  ${extra}
  <p style="margin:22px 0 0;">
    <a href="${esc(base)}/?country=CR" style="display:inline-block;background:#0a66c2;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;">Ver todas las licitaciones →</a>
  </p>
  <p style="color:#94a3b8;font-size:12px;margin-top:24px;">Enviado automáticamente por Mesoamérica. Fuente: SICOP (Costa Rica).</p>
</div></body></html>`;
}

export async function sendEmail(env: EmailEnv, subject: string, html: string): Promise<SendResult> {
  if (!env.RESEND_API_KEY) return { sent: false, reason: "falta RESEND_API_KEY" };
  if (!env.DIGEST_EMAIL_TO) return { sent: false, reason: "falta DIGEST_EMAIL_TO" };

  const from = env.DIGEST_EMAIL_FROM || "Mesoamérica <onboarding@resend.dev>";
  const to = env.DIGEST_EMAIL_TO.split(",").map((s) => s.trim()).filter(Boolean);

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  const body = await res.text().catch(() => "");
  if (!res.ok) return { sent: false, reason: `HTTP ${res.status}: ${body.slice(0, 200)}`, status: res.status };

  let id: string | undefined;
  try {
    id = (JSON.parse(body) as { id?: string }).id;
  } catch {
    /* ignore */
  }
  return { sent: true, status: res.status, id };
}
