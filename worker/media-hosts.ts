export type MediaSource = "youtube" | "instagram" | "x";

export function allowedMediaHost(host: string, source?: MediaSource): boolean {
  const youtube = host === "yt3.ggpht.com" || host === "i.ytimg.com";
  const instagram = host === "scontent.cdninstagram.com" || /(^|\.)fna\.fbcdn\.net$/.test(host);
  const x = host === "pbs.twimg.com";
  return source === "youtube" ? youtube : source === "instagram" ? instagram : source === "x" ? x : youtube || instagram || x;
}
