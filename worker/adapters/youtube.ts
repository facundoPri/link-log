import { fetchTranscript } from "youtube-transcript-plus";
import type { ContentAdapter } from "./types";
export function youtubeId(input: string): string | null {
  const u = new URL(input);
  if (
    ![
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
    ].includes(u.hostname)
  )
    return null;
  const id =
    u.hostname === "youtu.be"
      ? u.pathname.slice(1)
      : u.searchParams.get("v") ||
        u.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1];
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

export const youtubeAdapter: ContentAdapter = {
  matches: (url) => !!youtubeId(url),
  async extract(_env, url) {
    const videoId = youtubeId(url)!;
    const transcript = await fetchTranscript(videoId, {
      videoDetails: true,
      retries: 0,
      signal: AbortSignal.timeout(45000),
    });
    const markdown = `# ${transcript.videoDetails.title}\n\n${transcript.segments.map((s) => `[${Math.floor(s.offset / 60)}:${String(Math.floor(s.offset % 60)).padStart(2, "0")}] ${s.text}`).join("\n\n")}`;
    if (!transcript.segments.length)
      throw new Error(
        "No hay transcripción pública. Podés cargarla manualmente.",
      );
    return { markdown, source: "youtube" };
  },
};
