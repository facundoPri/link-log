// Narrative for the full video's opening and closing cards: the PR, one line per chapter, and the possible
// product bugs the chapter reports found (.reviews/QA-ch*.md, consolidated in planning/qa/fac-48-video-qa-summary.md).
// Pass/fail itself always comes from the manifest, never from here.

export const PR = {
  title: "Needs attention only after a real failure",
  branch: "facundoPri/fac-48-needs-attention",
  tickets: <[string, string][]>[
    ["FAC-48", "Needs attention only after a real failure: reasons, retries, Retry/Dismiss"],
    ["FAC-52", "Jev configuration preflight"],
    ["FAC-53", "Per-link job queue: Jev waits for the extraction"],
    ["FAC-54", "Jev retries by phase, batch stop on account errors"],
    ["FAC-55", "Cancel one job from Activity, with its dependents"],
    ["FAC-56", "Settings: use the preview as content"],
    ["FAC-57", "Login walls and block pages"],
  ],
};

/** One line per chapter for the full intro (chapter id → line). */
export const CHAPTER_LINES: Record<string, string> = {
  "ch1-waiting": "Links waiting behind a busy browser slot are not failures, even after a reload; cancelled imports stay neutral",
  "ch2-failures": "Real failures are retried in plain sight, then listed with a plain reason, Retry and Dismiss",
  "ch3-keep-use": "The preview fallback, previous content kept on a failed re-extract, and login walls discarded",
  "ch4-jev-waits": "Auto-tag and lenses wait for the link's extraction, one job at a time per link",
  "ch5-jev-cost": "Jev without a key is off and says why; account errors stop the batch; nothing billed is resent",
  "ch6-cancel": "✕ on one job cancels it and what waits for it, and leaves the link as if nothing happened",
};

export type Finding = { title: string; scenarios: string[]; detail: string };

/** Possible product bugs found while filming (product code untouched). */
export const FINDINGS: Finding[] = [
  {
    title: "Jobs waiting for a browser slot read “Preparing content”, never “Queued”",
    scenarios: ["NA-03"],
    detail: "The Workflow marks the job running before it gets a slot, so a job that has done nothing shows a running step for up to a minute.",
  },
  {
    title: "Cancel batch can't cancel links waiting for the browser slot",
    scenarios: ["NA-04", "PQ-07"],
    detail: "Same root cause: those jobs are already “running”, and batch cancel only takes queued/waiting jobs. Toast “Nothing left to cancel”; the links are extracted anyway. Per-job ✕ works (NA-05, PQ-07b).",
  },
  {
    title: "An unresolvable host fails at once instead of being retried",
    scenarios: ["NA-09"],
    detail: "Empty DNS answer → “unreachable”, retryable:false: 1 preview + 1 content attempt, not 3 + 2. Maybe intended; then the plan needs fixing.",
  },
  {
    title: "“Auto-tag N with content” never says “Skipped 1 link without content”",
    scenarios: ["PQ-02"],
    detail: "The client drops the no-content links before calling the server, so the server skips nothing and no toast shows. Tagging itself is right.",
  },
  {
    title: "Nested buttons in Activity batch cards (minor, a11y)",
    scenarios: ["PQ-07b"],
    detail: "“Cancel batch” / “Retry failed” sit inside the collapsible trigger button; React warns, and the trigger's accessible name includes them.",
  },
];
