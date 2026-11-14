// Registro de fetchers habilitados. Agregar uno nuevo = agregar una entrada.

import type { Licitacion } from "../schema";
import type { FetcherEnv } from "./base";
import { fetchSicopCr } from "./sicop_cr";
import { fetchUngm } from "./ungm";

export interface FetcherDef {
  name: string;
  fn: (env: FetcherEnv) => Promise<Licitacion[]>;
}

export const FETCHERS: FetcherDef[] = [
  { name: "sicop_cr", fn: fetchSicopCr },
  { name: "ungm",     fn: fetchUngm },
];
