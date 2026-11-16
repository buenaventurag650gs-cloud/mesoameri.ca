// Registro de fetchers habilitados. Agregar uno nuevo = agregar una entrada.

import type { Licitacion } from "../schema";
import type { FetcherEnv } from "./base";
import { fetchSicopCr, enrichSicopCr, type EnrichStats } from "./sicop_cr";
import { fetchUngm } from "./ungm";

export interface FetcherDef {
  name: string;
  fn: (env: FetcherEnv) => Promise<Licitacion[]>;
  // Opcional: enriquece los concursos YA filtrados como relevantes con datos
  // de detalle (muta cada Licitacion). Se corre entre filtrar y guardar.
  // Devuelve estadísticas de diagnóstico.
  enrich?: (lics: Licitacion[], env: FetcherEnv) => Promise<EnrichStats | void>;
}

export const FETCHERS: FetcherDef[] = [
  { name: "sicop_cr", fn: fetchSicopCr, enrich: (lics) => enrichSicopCr(lics) },
  { name: "ungm",     fn: fetchUngm },
];
