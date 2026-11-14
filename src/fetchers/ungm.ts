// UN Global Marketplace — una búsqueda por país (ISO alpha-3).
// TODO al conectar: confirmar endpoint y campos del payload.

import { makeLicitacion, type Licitacion, type Status } from "../schema";
import { httpGet, parseIsoDate, parseIsoDateTime, type FetcherEnv } from "./base";

const BASE_URL = "https://www.ungm.org";
const SEARCH_PATH = "/Public/Notice/Search";

const COUNTRY_MAP: Record<string, string> = {
  MEX: "MX", GTM: "GT", BLZ: "BZ", SLV: "SV",
  HND: "HN", NIC: "NI", CRI: "CR", PAN: "PA",
  DOM: "DO",
};

interface UngmNotice {
  Id?: string | number;
  ReferenceNo?: string;
  Title?: string;
  TitleEn?: string;
  Description?: string;
  UNOrganizationName?: string;
  UNOrganization?: string;
  PublishedOn?: string;
  PublishedDate?: string;
  DeadlineDate?: string;
  Deadline?: string;
  Status?: string | number;
}

interface UngmResponse {
  ResultList?: UngmNotice[];
  Notices?: UngmNotice[];
}

export async function fetchUngm(env: FetcherEnv): Promise<Licitacion[]> {
  const out: Licitacion[] = [];
  for (const [iso3, iso2] of Object.entries(COUNTRY_MAP)) {
    try {
      const notices = await searchByCountry(env, iso3);
      for (const n of notices) {
        const lic = noticeToLicitacion(n, iso2);
        if (lic) out.push(lic);
      }
    } catch (e) {
      console.warn(`ungm ${iso3}: ${(e as Error).message}`);
    }
  }
  return out;
}

async function searchByCountry(env: FetcherEnv, iso3: string): Promise<UngmNotice[]> {
  const payload = {
    PageIndex: 0,
    PageSize: 100,
    SortField: "DeadlineDate",
    SortAscending: true,
    NoticeTypes: [] as number[],
    Countries: [iso3],
    Statuses: [1, 2],
  };
  const r = await httpGet(`${BASE_URL}${SEARCH_PATH}`, env, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await r.json()) as UngmResponse;
  return data.ResultList ?? data.Notices ?? [];
}

function noticeToLicitacion(n: UngmNotice, iso2: string): Licitacion | null {
  const id = String(n.Id ?? n.ReferenceNo ?? n.TitleEn ?? "").trim();
  if (!id) return null;
  return makeLicitacion({
    source: "ungm",
    source_id: id,
    country: iso2,
    entity: n.UNOrganizationName ?? n.UNOrganization ?? "UN agency",
    title: n.Title ?? n.TitleEn ?? "",
    summary: n.Description ?? "",
    status: mapStatus(n.Status),
    publish_date: parseIsoDate(n.PublishedOn ?? n.PublishedDate),
    close_date: parseIsoDateTime(n.DeadlineDate ?? n.Deadline),
    source_url: `${BASE_URL}/Public/Notice/${encodeURIComponent(id)}`,
    raw: n,
  });
}

function mapStatus(s: string | number | undefined): Status {
  const str = String(s ?? "").toLowerCase();
  if (str.includes("active") || str === "1") return "vigente";
  if (str.includes("award") || str === "2") return "adjudicada";
  if (str.includes("cancel")) return "cancelada";
  return "desconocido";
}
