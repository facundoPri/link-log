// Sample library used by the demos. Fictional pages on real kinds of sites.

export type TagDef = { name: string; tone: number; count: number };

export const TAGS: TagDef[] = [
  { name: "research", tone: 5, count: 23 },
  { name: "to read", tone: 2, count: 41 },
  { name: "recipes", tone: 1, count: 17 },
  { name: "side project", tone: 3, count: 12 },
  { name: "design", tone: 6, count: 9 },
  { name: "video", tone: 0, count: 14 },
];

// Tags that appear in the demos but not in the hero sidebar.
const EXTRA_TONES: Record<string, number> = { "quick dinner": 7 };

export const tone = (name: string) => TAGS.find((t) => t.name === name)?.tone ?? EXTRA_TONES[name] ?? 4;

export type Row = {
  title: string;
  domain: string;
  letter: string;
  tone: number;
  tags: { name: string; score?: number }[];
  ago?: string;
};

export const LIBRARY: Row[] = [
  {
    title: "Designing calm interfaces for dense data",
    domain: "uxdesign.cc",
    letter: "U",
    tone: 6,
    tags: [{ name: "design" }, { name: "to read" }],
    ago: "2h",
  },
  {
    title: "D1 prepared statements and batching",
    domain: "developers.cloudflare.com",
    letter: "C",
    tone: 1,
    tags: [{ name: "side project" }],
    ago: "5h",
  },
  {
    title: "Weeknight dal with crispy shallots",
    domain: "bonappetit.com",
    letter: "B",
    tone: 0,
    tags: [{ name: "recipes" }],
    ago: "1d",
  },
  {
    title: "How diffusion models learn to denoise",
    domain: "youtube.com",
    letter: "Y",
    tone: 0,
    tags: [{ name: "research" }, { name: "video" }],
    ago: "3d",
  },
];

export const INCOMING: Row[] = [
  {
    title: "Local first software: you own your data",
    domain: "inkandswitch.com",
    letter: "I",
    tone: 5,
    tags: [
      { name: "research", score: 93 },
      { name: "to read", score: 86 },
    ],
  },
  {
    title: "One pan lemon orzo with spinach",
    domain: "seriouseats.com",
    letter: "S",
    tone: 2,
    tags: [{ name: "recipes", score: 97 }],
  },
  {
    title: "Manifest V3 service workers, explained",
    domain: "developer.chrome.com",
    letter: "D",
    tone: 4,
    tags: [{ name: "side project", score: 88 }],
  },
];
