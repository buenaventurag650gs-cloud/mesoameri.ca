// Capa sobre D1. Upsert por dedupe_key con conteo new/updated/unchanged.

import type { Licitacion } from "./schema";
import { dedupeKey } from "./schema";

export interface UpsertCounts {
  new: number;
  updated: number;
  unchanged: number;
}

export class Storage {
  constructor(private db: D1Database) {}

  async upsertMany(lics: Licitacion[]): Promise<UpsertCounts> {
    const counts: UpsertCounts = { new: 0, updated: 0, unchanged: 0 };
    const now = new Date().toISOString();

    for (const lic of lics) {
      const key = dedupeKey(lic);

      // Ver si existe para decidir verdict
      const existing = await this.db
        .prepare("SELECT status, close_date, raw FROM licitaciones WHERE dedupe_key = ?")
        .bind(key)
        .first<{ status: string; close_date: string | null; raw: string | null }>();

      let verdict: keyof UpsertCounts;
      if (!existing) {
        verdict = "new";
      } else if (
        existing.status === lic.status &&
        existing.close_date === lic.close_date
      ) {
        verdict = "unchanged";
      } else {
        verdict = "updated";
      }

      // Preservar el detalle enriquecido (raw._enriched) si esta corrida no lo
      // trae pero ya estaba guardado — así no se pierde al refrescar un concurso
      // que quedó fuera del tope de enriquecimiento de esta corrida.
      let rawToStore: unknown = lic.raw;
      if (existing?.raw) {
        try {
          const oldRaw = JSON.parse(existing.raw) as Record<string, unknown> | null;
          const newRaw =
            lic.raw && typeof lic.raw === "object"
              ? (lic.raw as Record<string, unknown>)
              : null;
          if (oldRaw && oldRaw._enriched && !(newRaw && newRaw._enriched)) {
            rawToStore = { ...(newRaw ?? {}), _enriched: oldRaw._enriched };
          }
        } catch {
          /* raw viejo corrupto: lo ignoramos */
        }
      }

      await this.db
        .prepare(
          `INSERT INTO licitaciones (
             dedupe_key, source, source_id, country, entity, title, summary,
             status, publish_date, close_date, source_url, categories,
             keywords_hit, raw, first_seen_at, last_seen_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(dedupe_key) DO UPDATE SET
             status       = excluded.status,
             publish_date = excluded.publish_date,
             close_date   = excluded.close_date,
             summary      = excluded.summary,
             categories   = excluded.categories,
             keywords_hit = excluded.keywords_hit,
             raw          = excluded.raw,
             last_seen_at = excluded.last_seen_at`
        )
        .bind(
          key, lic.source, lic.source_id, lic.country, lic.entity,
          lic.title, lic.summary, lic.status, lic.publish_date, lic.close_date,
          lic.source_url,
          JSON.stringify(lic.categories),
          JSON.stringify(lic.keywords_hit),
          JSON.stringify(rawToStore),
          now, now,
        )
        .run();

      counts[verdict]++;
    }
    return counts;
  }

  async vigentes(country?: string): Promise<Licitacion[]> {
    const stmt = country
      ? this.db.prepare(
          "SELECT * FROM licitaciones WHERE status = 'vigente' AND country = ? ORDER BY country, close_date ASC"
        ).bind(country)
      : this.db.prepare(
          "SELECT * FROM licitaciones WHERE status = 'vigente' ORDER BY country, close_date ASC"
        );
    const { results } = await stmt.all<D1Row>();
    return results.map(rowToLicitacion);
  }

  // Concursos vigentes de una fuente que todavía NO tienen detalle enriquecido.
  // Los más próximos a cerrar primero (son los más urgentes de completar).
  async pendingEnrichment(source: string, limit: number): Promise<Licitacion[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM licitaciones
          WHERE source = ? AND status = 'vigente'
            AND (raw IS NULL OR raw NOT LIKE '%"_enriched"%')
          ORDER BY close_date ASC
          LIMIT ?`
      )
      .bind(source, limit)
      .all<D1Row>();
    return results.map(rowToLicitacion);
  }

  // Borra registros por clave exacta. Devuelve cuántos había.
  async deleteKeys(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const ph = keys.map(() => "?").join(",");
    const before = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM licitaciones WHERE dedupe_key IN (${ph})`)
      .bind(...keys)
      .first<{ n: number }>();
    await this.db
      .prepare(`DELETE FROM licitaciones WHERE dedupe_key IN (${ph})`)
      .bind(...keys)
      .run();
    return before?.n ?? 0;
  }

  // Guarda el raw enriquecido (y completa close_date si venía nulo).
  async updateRaw(key: string, raw: unknown, closeDate: string | null): Promise<void> {
    await this.db
      .prepare(
        `UPDATE licitaciones
            SET raw = ?, close_date = COALESCE(close_date, ?), last_seen_at = ?
          WHERE dedupe_key = ?`
      )
      .bind(JSON.stringify(raw), closeDate, new Date().toISOString(), key)
      .run();
  }

  // De las claves dadas, cuáles ya tienen detalle enriquecido guardado
  // (raw contiene "_enriched"). Sirve para no re-enriquecer en cada corrida.
  async enrichedKeys(keys: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (keys.length === 0) return out;
    const placeholders = keys.map(() => "?").join(",");
    const { results } = await this.db
      .prepare(
        `SELECT dedupe_key, raw FROM licitaciones WHERE dedupe_key IN (${placeholders})`
      )
      .bind(...keys)
      .all<{ dedupe_key: string; raw: string | null }>();
    for (const r of results) {
      if (r.raw && r.raw.includes('"_enriched"')) out.add(r.dedupe_key);
    }
    return out;
  }

  async seenSince(isoTs: string): Promise<Set<string>> {
    const { results } = await this.db
      .prepare("SELECT dedupe_key FROM licitaciones WHERE first_seen_at >= ?")
      .bind(isoTs)
      .all<{ dedupe_key: string }>();
    return new Set(results.map((r) => r.dedupe_key));
  }

  // ---- Suscriptores del correo (doble opt-in) ----

  async ensureSubscribersTable(): Promise<void> {
    await this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS subscribers (
           email        TEXT PRIMARY KEY,
           token        TEXT NOT NULL,
           status       TEXT NOT NULL DEFAULT 'pending',
           country      TEXT,
           created_at   TEXT NOT NULL,
           confirmed_at TEXT,
           topics       TEXT NOT NULL DEFAULT ''
         )`
      )
      .run();
    // Migración: tablas creadas antes de agregar "topics" no la tienen.
    // SQLite no soporta "ADD COLUMN IF NOT EXISTS", así que se intenta y se
    // ignora el error si la columna ya existe.
    try {
      await this.db.prepare("ALTER TABLE subscribers ADD COLUMN topics TEXT NOT NULL DEFAULT ''").run();
    } catch {
      // ya existe — no hay nada que hacer
    }
  }

  // Alta: si ya existe confirmado, no hace nada (evita reenviar confirmación).
  // Si estaba pendiente o dado de baja, refresca token, temas y lo deja
  // pendiente. `topics` es una lista separada por comas (ej. "urbanismo,ambiental")
  // o "" para recibir todas las categorías.
  async addSubscriber(
    email: string,
    token: string,
    country: string | null,
    topics = ""
  ): Promise<"created" | "pending" | "already"> {
    await this.ensureSubscribersTable();
    const existing = await this.db
      .prepare("SELECT status FROM subscribers WHERE email = ?")
      .bind(email)
      .first<{ status: string }>();
    const now = new Date().toISOString();
    if (existing) {
      if (existing.status === "confirmed") return "already";
      await this.db
        .prepare(
          "UPDATE subscribers SET token = ?, status = 'pending', country = ?, created_at = ?, topics = ? WHERE email = ?"
        )
        .bind(token, country, now, topics, email)
        .run();
      return "pending";
    }
    await this.db
      .prepare(
        "INSERT INTO subscribers (email, token, status, country, created_at, topics) VALUES (?,?,'pending',?,?,?)"
      )
      .bind(email, token, country, now, topics)
      .run();
    return "created";
  }

  async confirmSubscriber(email: string, token: string): Promise<boolean> {
    await this.ensureSubscribersTable();
    const row = await this.db
      .prepare("SELECT token FROM subscribers WHERE email = ?")
      .bind(email)
      .first<{ token: string }>();
    if (!row || row.token !== token) return false;
    await this.db
      .prepare("UPDATE subscribers SET status = 'confirmed', confirmed_at = ? WHERE email = ?")
      .bind(new Date().toISOString(), email)
      .run();
    return true;
  }

  async unsubscribe(email: string, token: string): Promise<boolean> {
    await this.ensureSubscribersTable();
    const row = await this.db
      .prepare("SELECT token FROM subscribers WHERE email = ?")
      .bind(email)
      .first<{ token: string }>();
    if (!row || row.token !== token) return false;
    await this.db
      .prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE email = ?")
      .bind(email)
      .run();
    return true;
  }

  async confirmedSubscribers(): Promise<{ email: string; token: string; topics: string }[]> {
    await this.ensureSubscribersTable();
    const { results } = await this.db
      .prepare("SELECT email, token, topics FROM subscribers WHERE status = 'confirmed' ORDER BY confirmed_at ASC")
      .all<{ email: string; token: string; topics: string }>();
    return results;
  }

  async recordRun(source: string, startedAt: string, counts: UpsertCounts, error?: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO runs (started_at, finished_at, source, fetched, new_count, updated, unchanged, error)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .bind(
        startedAt,
        new Date().toISOString(),
        source,
        counts.new + counts.updated + counts.unchanged,
        counts.new, counts.updated, counts.unchanged,
        error ?? null,
      )
      .run();
  }
}

interface D1Row {
  dedupe_key: string;
  source: string;
  source_id: string;
  country: string;
  entity: string;
  title: string;
  summary: string;
  status: string;
  publish_date: string | null;
  close_date: string | null;
  source_url: string;
  categories: string;
  keywords_hit: string;
  raw: string;
  first_seen_at: string;
  last_seen_at: string;
}

function rowToLicitacion(r: D1Row): Licitacion {
  return {
    source: r.source,
    source_id: r.source_id,
    country: r.country,
    entity: r.entity ?? "",
    title: r.title ?? "",
    summary: r.summary ?? "",
    status: (r.status ?? "desconocido") as Licitacion["status"],
    publish_date: r.publish_date,
    close_date: r.close_date,
    source_url: r.source_url ?? "",
    categories: JSON.parse(r.categories || "[]"),
    keywords_hit: JSON.parse(r.keywords_hit || "[]"),
    raw: r.raw ? JSON.parse(r.raw) : null,
  };
}
