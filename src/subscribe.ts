// Suscripción al correo del digest, con doble opt-in:
//   1) El usuario deja su correo  → /subscribe  → se guarda "pendiente" y se le
//      envía un correo de confirmación con un enlace.
//   2) El usuario hace clic en el enlace → /confirm → queda "confirmado".
//   3) Cada correo del digest trae un enlace de baja → /unsubscribe.
//
// El doble opt-in evita que alguien suscriba a terceros y mejora la entrega
// (menos reportes de spam).

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

// Token aleatorio (hex de 32 chars) usando el crypto del runtime de Workers.
export function genToken(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validEmail(e: string): boolean {
  return e.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export function confirmUrl(base: string, email: string, token: string): string {
  const b = base.replace(/\/$/, "");
  return `${b}/confirm?e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}`;
}

export function unsubscribeUrl(base: string, email: string, token: string): string {
  const b = base.replace(/\/$/, "");
  return `${b}/unsubscribe?e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}`;
}

// Correo de confirmación (doble opt-in).
export function confirmEmailHtml(base: string, email: string, token: string): string {
  const url = confirmUrl(base, email, token);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"></head>
<body style="margin:0;background:#f7f9fc;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a2330;">
<div style="max-width:560px;margin:0 auto;padding:28px 20px;">
  <h1 style="font-size:19px;margin:0 0 10px;">Confirmá tu suscripción</h1>
  <p style="font-size:15px;line-height:1.5;color:#1a2330;margin:0 0 16px;">
    Recibimos una solicitud para enviarte el resumen de nuevas licitaciones de Costa Rica a
    <b>${esc(email)}</b>. Para empezar a recibirlo, confirmá con el botón:</p>
  <p style="margin:0 0 20px;">
    <a href="${esc(url)}" style="display:inline-block;background:#0a66c2;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:15px;font-weight:600;">Confirmar mi correo</a>
  </p>
  <p style="font-size:13px;color:#64748b;margin:0 0 4px;">Si el botón no funciona, copiá este enlace:</p>
  <p style="font-size:13px;color:#0a66c2;word-break:break-all;margin:0 0 20px;">${esc(url)}</p>
  <p style="font-size:12px;color:#94a3b8;margin:0;">Si no fuiste vos, ignorá este correo: no se enviará nada sin tu confirmación.</p>
</div></body></html>`;
}

// Página HTML simple y con la misma estética para las respuestas del flujo.
export function statusPage(opts: {
  title: string;
  heading: string;
  message: string;
  base: string;
  tone?: "ok" | "info" | "error";
}): string {
  const color =
    opts.tone === "error" ? "#b42318" : opts.tone === "info" ? "#0a66c2" : "#0f7b4f";
  const base = opts.base.replace(/\/$/, "") || "/";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} — Mesoamérica</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;background:#f7f9fc;color:#1a2330;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px;}
  .box{background:#fff;border:1px solid #e5e9f0;border-radius:14px;max-width:460px;width:100%;padding:28px 26px;text-align:center;}
  .dot{width:44px;height:44px;border-radius:50%;background:${color}14;color:${color};display:flex;align-items:center;justify-content:center;
       margin:0 auto 14px;font-size:24px;font-weight:700;}
  h1{font-size:19px;margin:0 0 8px;}
  p{color:#475569;margin:0 0 18px;overflow-wrap:anywhere;}
  a.btn{display:inline-block;background:#0a66c2;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;}
</style></head>
<body><div class="box">
  <div class="dot">${opts.tone === "error" ? "!" : "✓"}</div>
  <h1>${esc(opts.heading)}</h1>
  <p>${esc(opts.message)}</p>
  <a class="btn" href="${esc(base)}/?country=CR">Ver las licitaciones</a>
</div></body></html>`;
}
