# mesoamerica — Cloudflare Worker

Digest de licitaciones de Mesoamérica (México sur, Guatemala, Belice, El Salvador,
Honduras, Nicaragua, Costa Rica, Panamá, República Dominicana). Corre como
Cloudflare Worker con D1 (SQLite serverless) y Cron Trigger diario.

Mismo patrón que CelesteApp: Worker servido en `mesoamerica.<tu-subdominio>.workers.dev`,
mapeable a dominio propio después.

## Arquitectura

```
Cron Trigger (diario 7am CR)
      ↓
scheduled() handler
      ↓
┌──────────────────────┐
│ Fetchers             │ → sicop_cr (todosloscontratos.cr OCDS)
│                      │   ungm (UN Global Marketplace)
│                      │   [guatecompras, bcie, ... próximos]
└──────────────────────┘
      ↓
Classifier (keywords por categoría, word boundaries — sin categoría = "Sin categoría")
      ↓
D1 upsert — se guarda TODO, clasificado o no (dedupe por source+id, trackea nuevo/actualizado/sin cambios)

fetch() handler
      ↓
┌─ GET /                 → HTML digest con filtros por país
├─ GET /?country=CR      → filtrado
├─ GET /api/vigentes.json → JSON para integración
├─ GET /api/runs.json    → últimas corridas (debug)
└─ POST /admin/run       → dispara pipeline manual (requiere token)
```

## Despliegue (dos caminos)

### Camino A: desde el dashboard de Cloudflare (recomendado si ya tenés GitHub)

1. Repo ya está en GitHub ✓
2. En el dashboard de Cloudflare: **Workers & Pages → Create → Connect to Git**,
   elegís el repo `mesoamerica`.
3. Cloudflare detecta `wrangler.toml` y configura build/deploy automático.
4. **Crear D1**: en el dashboard, **Workers & Pages → D1 → Create database**,
   nombre `mesoamerica-db`.
5. **Pegar el database_id** del D1 recién creado en `wrangler.toml` (línea
   `database_id = "REPLACE_WITH_D1_ID_AFTER_CREATE"`) y hacer commit → push.
6. **Crear las tablas**: desde el dashboard de D1, pestaña **Console**, pegar
   el contenido de `schema.sql` y ejecutar. Después `samples/seed.sql` para
   datos demo.
7. **Secrets**: en el worker, **Settings → Variables → Encrypt variable**,
   agregar `ADMIN_TOKEN` (string random) y `CONTACT_EMAIL`.
8. El cron ya quedó configurado en `wrangler.toml` — se activa solo.

### Camino B: desde la terminal con wrangler (más rápido si ya conocés CLI)

```bash
npm install
wrangler d1 create mesoamerica-db
# → copiar database_id al wrangler.toml
npm run db:init:remote
wrangler d1 execute mesoamerica-db --remote --file=./samples/seed.sql
wrangler secret put ADMIN_TOKEN
wrangler secret put CONTACT_EMAIL
npm run deploy
```

## Verificar

```bash
# Ver el digest en el navegador
open https://mesoamerica.<tu-subdominio>.workers.dev/

# Disparar el pipeline manualmente
curl -X POST https://mesoamerica.<tu-subdominio>.workers.dev/admin/run \
     -H "x-admin-token: <ADMIN_TOKEN>"

# Ver últimas corridas
curl https://mesoamerica.<tu-subdominio>.workers.dev/api/runs.json | jq

# Logs en vivo (solo con CLI)
npm run tail
```

## Países cubiertos

México (sur), Guatemala, Belice, El Salvador, Honduras, Nicaragua, Costa Rica,
Panamá y República Dominicana. El fetcher de UNGM ya pregunta por todos ellos.

## Qué queda por confirmar al conectar con las fuentes reales

Los dos fetchers que existen tienen placeholders razonables pero no verificados
contra producción:

1. **`src/fetchers/sicop_cr.ts`** — endpoint OCDS de todosloscontratos.cr.
   Asume `GET /api/ocds/releases?page=N&size=100`.
2. **`src/fetchers/ungm.ts`** — endpoint de búsqueda de UNGM.
   Asume `POST /Public/Notice/Search` con JSON.

Después de la primera corrida vía `/admin/run`, revisar `/api/runs.json` para
ver qué fetcher falló y con qué mensaje.

## Fetchers por agregar (orden sugerido)

1. **Guatecompras** (OCDS vía Ministerio de Finanzas de Guatemala)
2. **BCIE** — adquisiciones.bcie.org bloquea scraping directo (confirmado);
   su portal de datos abiertos (datosabiertos.bcie.org) solo tiene el plan de
   adquisiciones, no licitaciones vigentes — descartado por ahora
3. **CompraNet** (México) — regional sur
4. **COMPRASAL** (El Salvador) — requiere sesión
5. **HonduCompras** (Honduras) — poco documentado

Ya agregados: SICOP CR (`sicop_cr.ts`), **PanamaCompra V3** (`panama_dgcp.ts`
— API REST real en `apisv3.panamacompra.gob.pa/busqueda/proceso-lista-publico`,
sin login; el portal de datos abiertos OCDS de Panamá dejó de actualizarse a
mediados de 2024, así que no se usó), BID, PNUD y Banco Mundial.

Agregar un fetcher nuevo = un archivo en `src/fetchers/` que exporta
`async function fetchX(env: FetcherEnv): Promise<Licitacion[]>` y
una entrada en el array `FETCHERS` en `src/fetchers/index.ts`.
El pipeline no necesita otros cambios.

## Afinar el clasificador

Diccionarios en `src/classifier.ts` (`CATEGORIES`). Para agregar un tema
nuevo o términos nuevos no hay que tocar nada más que ese archivo —
etiquetas visibles (nombre del chip/checkbox) en `CAT_LABEL` dentro de
`src/digest.ts`.

El digest muestra TODO lo que traen las fuentes (vigentes de cualquier
tema, incluso sin clasificar — esas caen en el chip "Sin categoría").
La clasificación por tema ya no filtra qué se guarda: solo alimenta
los botones de filtro del digest y el filtro por tema del correo.

## Costos esperados

- **Workers**: dentro del free tier (100k requests/día).
- **D1**: free tier cubre 25M reads/mes y 50k writes/día.
- **Cron triggers**: incluidos.

Total probable: $0/mes.
