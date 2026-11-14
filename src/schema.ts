// Esquema normalizado. Toda fuente convierte a Licitacion antes del pipeline.

export const COUNTRIES: Record<string, string> = {
  MX: "México",
  GT: "Guatemala",
  BZ: "Belice",
  SV: "El Salvador",
  HN: "Honduras",
  NI: "Nicaragua",
  CR: "Costa Rica",
  PA: "Panamá",
  DO: "República Dominicana",
  MULTI: "Multi-país",
};

export type Status =
  | "vigente"
  | "cerrada"
  | "adjudicada"
  | "desierta"
  | "suspendida"
  | "cancelada"
  | "desconocido";

export interface Licitacion {
  source: string;        // "sicop_cr", "ungm", "bcie"
  source_id: string;     // id del proceso en la fuente original
  country: string;       // ISO alpha-2 o "MULTI"
  entity: string;
  title: string;
  summary: string;
  status: Status;
  publish_date: string | null;   // YYYY-MM-DD
  close_date: string | null;     // ISO datetime
  source_url: string;
  categories: string[];          // llena el classifier
  keywords_hit: string[];        // qué palabras pegaron
  raw: unknown;                  // payload original (debug)
}

export function dedupeKey(l: Pick<Licitacion, "source" | "source_id" | "country" | "entity" | "title">): string {
  if (l.source_id) return `${l.source}:${l.source_id}`;
  return `${l.source}:${l.country}:${l.entity}:${l.title}`.toLowerCase();
}

export function makeLicitacion(partial: Partial<Licitacion> & Pick<Licitacion, "source" | "source_id" | "country">): Licitacion {
  return {
    entity: "",
    title: "",
    summary: "",
    status: "desconocido",
    publish_date: null,
    close_date: null,
    source_url: "",
    categories: [],
    keywords_hit: [],
    raw: null,
    ...partial,
  };
}
