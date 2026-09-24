// Pure lens contract shared by the web app, the Worker and the extension.
export type Question = {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria: Record<string, string> | string[];
};
export type Answer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "score";
      score: number;
      confidence: number;
      probabilities: Record<string, number>;
      legend: Record<string, string>;
    }
  | { type: "multi"; probabilities: Record<string, number> }; // key → p(yes)
export type LensType = "noul" | "choice" | "multi" | "score";
export type LensScope = "library" | "browser";
export type LensOption = { key: string; label: string; description: string };
export type LensLevel = { label: string; description: string };
export type Lens = {
  id: string;
  name: string;
  type: LensType;
  /** library lenses appear as All links views; browser lenses only in Browser. */
  scope: LensScope;
  question: string;
  options: LensOption[]; // choice + multi (choice includes auto "other")
  levels: LensLevel[]; // score, low → high, 2–10
  criteria: { yes: string; no: string }; // noul only
  threshold: number;
  version: number;
  created_at: string;
};
export type LensResult = {
  lens_id: string;
  answer: Answer;
  lens_version: number;
  content_version: number;
  model: string;
  evaluated_at: string;
  batch_id: string;
};

export function lensBucket(
  lens: Pick<Lens, "threshold">,
  result: { answer: Answer },
): "yes" | "unsure" | "no" | string {
  const a = result.answer;
  if (a.type === "noul")
    return a.noul >= lens.threshold ? "yes" : a.noul >= 0.5 ? "unsure" : "no";
  if (a.type === "choice") return a.choice;
  return "score";
}

export function lensSelectedKeys(
  lens: Pick<Lens, "threshold" | "options">,
  result: { answer: Answer },
): string[] {
  const a = result.answer;
  if (a.type !== "multi") return [];
  return lens.options
    .filter((o) => (a.probabilities[o.key] ?? 0) >= lens.threshold)
    .map((o) => o.key);
}

/** FNV-1a over UTF-16 code units, two seeds → 16 hex chars. Stable across runtimes. */
export function stableHash(text: string): string {
  let a = 0x811c9dc5,
    b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x0100019b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * Identity of what Jev is asked. Question, type, options, levels and criteria
 * change it; the threshold does not, so a purely visual threshold change keeps
 * browser probabilities (library lenses keep their numeric version contract).
 */
export function lensFingerprint(
  lens: Pick<Lens, "type" | "question" | "options" | "levels" | "criteria">,
): string {
  return stableHash(
    JSON.stringify([
      lens.type,
      lens.question,
      lens.options.map((o) => [o.key, o.label, o.description]),
      lens.levels.map((l) => [l.label, l.description]),
      lens.type === "noul" ? [lens.criteria.yes, lens.criteria.no] : [],
    ]),
  );
}

export type LensFilter = {
  lensId: string;
  /** noul: yes/unsure/no · choice: option keys · multi: option keys + "none". OR within a lens. */
  keys: string[];
  /** score only: minimum level index (inclusive). */
  minLevel: number | null;
};

export function filterActive(filter: LensFilter | undefined): boolean {
  return !!filter && (filter.keys.length > 0 || filter.minLevel !== null);
}

/**
 * A filter constrains only rows with a finished answer. Missing, pending, failed
 * or unavailable rows never match a constrained filter, including a "No" filter,
 * so an unknown is never mistaken for a negative.
 */
export function matchesLensFilter(
  lens: Pick<Lens, "type" | "threshold" | "options">,
  answer: Answer | null | undefined,
  filter: LensFilter | undefined,
): boolean {
  if (!filter || !filterActive(filter)) return true;
  if (!answer || answer.type !== lens.type) return false;
  const result = { answer };
  if (lens.type === "noul" || lens.type === "choice")
    return !filter.keys.length || filter.keys.includes(lensBucket(lens, result));
  if (lens.type === "multi") {
    if (!filter.keys.length) return true;
    const keys = lensSelectedKeys(lens, result);
    return (
      (filter.keys.includes("none") && !keys.length) ||
      keys.some((k) => filter.keys.includes(k))
    );
  }
  return (
    answer.type === "score" &&
    (filter.minLevel === null || answer.score >= filter.minLevel)
  );
}

/** AND across lenses. */
export function matchesAllLensFilters(
  lenses: Pick<Lens, "id" | "type" | "threshold" | "options">[],
  answers: (lensId: string) => Answer | null | undefined,
  filters: LensFilter[],
): boolean {
  return filters.every((f) => {
    const lens = lenses.find((l) => l.id === f.lensId);
    return !lens || matchesLensFilter(lens, answers(lens.id), f);
  });
}
