// Costa Rica vía todosloscontratos.cr (OCDS).
// TODO al conectar: confirmar RELEASES_PATH y shape del release.

import { makeLicitacion, type Licitacion, type Status } from "../schema";
import { httpJson, parseIsoDate, parseIsoDateTime, type FetcherEnv } from "./base";

const BASE_URL = "https://todosloscontratos.cr";
const RELEASES_PATH = "/api/ocds/releases";
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

interface OcdsResponse {
  releases?: OcdsRelease[];
  data?: OcdsRelease[];
}

interface OcdsRelease {
  ocid: string;
  date?: string;
  tender?: {
    id?: string;
    title?: string;
    description?: string;
    status?: string;
    tenderPeriod?: { endDate?: string };
  };
  buyer?: { name?: string };
}

export async function fetchSicopCr(env: FetcherEnv): Promise<Licitacion[]> {
  const out: Licitacion[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${BASE_URL}${RELEASES_PATH}?page=${page}&size=${PAGE_SIZE}`;
    let data: OcdsResponse;
    try {
      data = await httpJson<OcdsResponse>(url, env);
    } catch (e) {
      console.warn(`sicop_cr page ${page}: ${(e as Error).message}`);
      break;
    }
    const releases = data.releases ?? data.data ?? [];
    if (releases.length === 0) break;

    for (const r of releases) {
      const lic = releaseToLicitacion(r);
      if (lic) out.push(lic);
    }

    if (releases.length < PAGE_SIZE) break;
  }
  return out;
}

function releaseToLicitacion(r: OcdsRelease): Licitacion | null {
  if (!r.ocid) return null;
  const tender = r.tender ?? {};
  const buyer = r.buyer ?? {};
  return makeLicitacion({
    source: "sicop_cr",
    source_id: r.ocid,
    country: "CR",
    entity: (buyer.name ?? "").trim(),
    title: (tender.title ?? "").trim(),
    summary: (tender.description ?? "").trim(),
    status: mapStatus(tender.status),
    publish_date: parseIsoDate(r.date),
    close_date: parseIsoDateTime(tender.tenderPeriod?.endDate),
    source_url: buildSicopUrl(r.ocid),
    raw: r,
  });
}

function mapStatus(s?: string): Status {
  const map: Record<string, Status> = {
    active: "vigente",
    planning: "vigente",
    complete: "adjudicada",
    unsuccessful: "desierta",
    cancelled: "cancelada",
    withdrawn: "cancelada",
  };
  return map[(s ?? "").toLowerCase()] ?? "desconocido";
}

function buildSicopUrl(ocid: string): string {
  return `https://www.sicop.go.cr/moduloBid/common/review/EpExamRcvSuplDetail.jsp?cartelNo=${encodeURIComponent(ocid)}`;
}
