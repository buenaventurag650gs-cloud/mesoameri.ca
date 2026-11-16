// Clasificador por palabras clave. Simple, transparente, debuggeable.
// Si esto se queda corto, el siguiente paso es un LLM en batch — no antes.

import type { Licitacion } from "./schema";

// Cuando una palabra tiene plural o variantes de uso frecuente, se listan.
// Alternativa: usar stemming — es más poderoso pero menos auditable.
export const CATEGORIES: Record<string, string[]> = {
  urbanismo: [
    "plan regulador", "planes reguladores",
    "ordenamiento territorial", "uso del suelo",
    "zonificacion", "plan maestro", "planes maestros",
    "plan de desarrollo urbano", "catastro", "levantamiento topografico",
    "desarrollo urbano", "regeneracion urbana", "revitalizacion",
    "espacio publico", "espacios publicos", "areas publicas",
    "movilidad urbana", "mercado municipal", "mercados municipales",
    "parque urbano", "parques urbanos", "mobiliario urbano",
    "equipamiento urbano", "patrimonio arquitectonico", "litoral",
  ],
  ambiental: [
    "ambiental", "ambientales", "ambientalmente",
    "gestion ambiental", "impacto ambiental",
    "estudio hidrologico", "estudios hidrologicos",
    "recurso hidrico", "recursos hidricos",
    "cuenca", "cuencas",
    "bandera azul", "biodiversidad", "sinac", "conservacion",
    "pagos por servicios ambientales", "psa", "bosque", "bosques",
  ],
  residuos: [
    "residuos", "residuos solidos", "residuos valorizables", "valorizables",
    "manejo de residuos", "gestion de residuos", "recuperacion de materiales",
    "reciclaje", "composta", "relleno sanitario",
  ],
  "agua-saneamiento": [
    "agua potable", "alcantarillado", "acueducto", "acueductos",
    "pozo", "pozos",
    "planta de tratamiento", "plantas de tratamiento",
    "saneamiento", "asada", "asadas", "aya",
    "red de distribucion", "aguas residuales",
    "aguas pluviales", "red pluvial", "pluvial", "riego",
  ],
  "obra-publica": [
    "obra publica", "obras publicas",
    "construccion", "reconstruccion", "rehabilitacion", "remodelacion",
    "mejoras constructivas", "ampliacion", "edificio", "puente", "puentes",
    "carretera", "carreteras", "vial",
    "pavimentacion", "aeropuerto", "muelle",
  ],
  energia: [
    "fotovoltaico", "solar", "eolico", "biomasa",
    "eficiencia energetica", "red electrica", "subestacion",
  ],
  consultoria: [
    "consultoria", "servicios profesionales", "asesoria",
    "estudios preliminares", "diseno", "supervision",
  ],
};

export function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")  // quita tildes
    .replace(/\s+/g, " ")
    .trim();
}

// escape para usar un string como regex literal
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termMatches(term: string, haystack: string): boolean {
  // Word boundaries manuales porque el \b de JS falla con unicode y multi-palabra.
  // Pedimos que antes/después no haya [a-z0-9].
  const re = new RegExp(`(?<![a-z0-9])${escapeRegex(term)}(?![a-z0-9])`, "i");
  return re.test(haystack);
}

export function classify(lic: Licitacion): Licitacion {
  const haystack = normalize(`${lic.title} ${lic.summary} ${lic.entity}`);
  const cats: string[] = [];
  const hits = new Set<string>();

  for (const [cat, terms] of Object.entries(CATEGORIES)) {
    const matched = terms.filter((t) => termMatches(t, haystack));
    if (matched.length > 0) {
      cats.push(cat);
      matched.forEach((m) => hits.add(m));
    }
  }

  lic.categories = cats;
  lic.keywords_hit = [...hits].sort();
  return lic;
}

export function filterRelevant(lics: Licitacion[], include: Set<string> | null): Licitacion[] {
  return lics.filter((l) => {
    if (l.categories.length === 0) return false;
    if (include === null) return true;
    return l.categories.some((c) => include.has(c));
  });
}
