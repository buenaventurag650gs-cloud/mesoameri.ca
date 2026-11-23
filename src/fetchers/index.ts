// Registro de fetchers habilitados. Agregar uno nuevo = agregar una entrada.

import type { Licitacion } from "../schema";
import type { FetcherEnv } from "./base";
import { fetchBid } from "./bid";
import { fetchPanamaDgcp } from "./panama_dgcp";
import { fetchSicopCr, type EnrichStats } from "./sicop_cr";
import { fetchUndp } from "./undp";
import { fetchWorldBank } from "./world_bank";

export interface FetcherDef {
  name: string;
  fn: (env: FetcherEnv) => Promise<Licitacion[]>;
  // Opcional: enriquece los concursos YA filtrados como relevantes con datos
  // de detalle (muta cada Licitacion). Se corre entre filtrar y guardar.
  // Devuelve estadísticas de diagnóstico.
  enrich?: (lics: Licitacion[], env: FetcherEnv) => Promise<EnrichStats | void>;
}

// SICOP ya NO enriquece aquí (en la corrida diaria, que compite por el
// mismo presupuesto de subrequests que la búsqueda ampliada por temas).
// El detalle (presupuesto, tipo, apertura…) lo completa el cron de cada
// 2 horas (enrichBacklog en src/index.ts), que corre sin competir con
// ninguna búsqueda — llega al mismo resultado, solo que unas horas después.
export const FETCHERS: FetcherDef[] = [
  { name: "sicop_cr",     fn: fetchSicopCr },
  { name: "panama_dgcp",  fn: fetchPanamaDgcp },
  { name: "bid",          fn: fetchBid },
  { name: "undp",         fn: fetchUndp },
  { name: "world_bank",   fn: fetchWorldBank },
];
