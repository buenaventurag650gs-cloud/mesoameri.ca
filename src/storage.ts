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
        .prepare("SELECT status, close_date FROM licitaciones WHERE dedupe_key = ?")
        .bind(key)
        .first<{ status: string; close_date: string | null }>();

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
          JSON.stringify(lic.raw),
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

  async seenSince(isoTs: string): Promise<Set<string>> {
    const { results } = await this.db
      .prepare("SELECT dedupe_key FROM licitaciones WHERE first_seen_at >= ?")
      .bind(isoTs)
      .all<{ dedupe_key: string }>();
    return new Set(results.map((r) => r.dedupe_key));
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
