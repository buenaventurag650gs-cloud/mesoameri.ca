// Registro de fetchers habilitados. Agregar uno nuevo = agregar una entrada.

import type { Licitacion } from "../schema";
import type { FetcherEnv } from "./base";
import { fetchBid } from "./bid";
import { fetchPanamaDgcp } from "./panama_dgcp";
import { fetchSicopCr, enrichSicopCr, type EnrichStats } from "./sicop_cr";
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

export const FETCHERS: FetcherDef[] = [
  { name: "sicop_cr",     fn: fetchSicopCr, enrich: (lics) => enrichSicopCr(lics) },
  { name: "panama_dgcp",  fn: fetchPanamaDgcp },
  { name: "bid",          fn: fetchBid },
  { name: "undp",         fn: fetchUndp },
  { name: "world_bank",   fn: fetchWorldBank },
];
