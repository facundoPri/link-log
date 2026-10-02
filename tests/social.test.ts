import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { parseYoutubePost, parseInstagram, parseXPost } from "../worker/adapters/social";
import { resolveCaption, selectCaptionTrack } from "../worker/adapters/youtube";
import { composeSocial, mediaAssetIdentity, MEDIA_UPSERT_SQL } from "../worker/handlers/extract";
import type { MediaItem } from "../src/types";
import { preservedContentStateSql } from "../worker/content-state";
import { transcribeImage } from "../worker/ocr";
import { captionMenuTracks } from "../src/lib/youtube";

const targetYt = "Ugkxe1slZtTlyFyU5jKfx_AHqNb_qLkc198Y";

describe("social post isolation and order", () => {
  test("YouTube keeps only the structured post with the exact ID", () => {
    const unrelated = { "@type": "https://schema.org/DiscussionForumPosting", url: "https://www.youtube.com/post/other", text: "reply", image: ["https://yt3.ggpht.com/reply"] };
    const target = { ...unrelated, url: `https://www.youtube.com/post/${targetYt}`, text: "Author text", image: ["https://yt3.ggpht.com/first", "https://yt3.ggpht.com/second"] };
    const html = `<script type="application/ld+json">${JSON.stringify(unrelated)}</script><script type="application/ld+json">${JSON.stringify(target)}</script>`;
    const result = parseYoutubePost(html, targetYt);
    expect(result.text).toBe("Author text");
    expect(result.media.map((m) => m.media_key)).toEqual(["/first", "/second"]);
  });

  test("YouTube text-only posts with an explicit empty image list are complete", () => {
    const post = { "@type": "https://schema.org/DiscussionForumPosting", url: `https://www.youtube.com/post/${targetYt}`, text: "Text only", image: [] };
    const result = parseYoutubePost(`<script type="application/ld+json">${JSON.stringify(post)}</script>`, targetYt);
    expect(result.details.completeness).toBe("verified");
    expect(result.media).toHaveLength(0);
  });

  test("Instagram selects the target carousel and retains mixed-media order", () => {
    const target = { code: "DdUI0nIgGam", caption: { text: "Own caption" }, carousel_media_count: 3, carousel_media: [
      { pk: "a", media_type: 1, display_uri: "https://scontent.cdninstagram.com/a.jpg" },
      { pk: "b", media_type: 2, display_uri: "https://scontent.cdninstagram.com/b.jpg" },
      { pk: "c", media_type: 1, display_uri: "https://scontent.cdninstagram.com/c.jpg" },
    ] };
    const html = `<script type="application/json">${JSON.stringify({ unrelated: { code: "other", caption: { text: "reply" } }, target })}</script>`;
    const result = parseInstagram(html, "DdUI0nIgGam", false);
    expect(result.text).toBe("Own caption");
    expect(result.media.map((m) => [m.media_key, m.kind])).toEqual([["a", "image"], ["b", "video"], ["c", "image"]]);
    expect(result.details.completeness).toBe("verified");
  });

  test("Instagram only verifies a carousel when its expected count is exposed", () => {
    const media = [{ pk: "a", media_type: 1, display_uri: "https://scontent.cdninstagram.com/a.jpg", image_versions2: { candidates: [
      { width: 640, height: 640, url: "https://scontent.cdninstagram.com/a-640.jpg" },
      { width: 1440, height: 1440, url: "https://scontent.cdninstagram.com/a-1440.jpg" },
    ] } }];
    const post = { code: "DdUI0nIgGam", caption: { text: "Own caption" }, carousel_media: media };
    const html = `<script type="application/json">${JSON.stringify({ post })}</script>`;
    const result = parseInstagram(html, "DdUI0nIgGam", false);
    expect(result.details.completeness).toBe("unverified");
    expect(result.media[0]?.url).toContain("a-1440.jpg");
    expect(result.media[0]?.preview_url).toContain("a.jpg");
    const withCount = `<script type="application/json">${JSON.stringify({ post, summary: { code: "DdUI0nIgGam", carousel_media_count: 1 } })}</script>`;
    expect(parseInstagram(withCount, "DdUI0nIgGam", false).details.completeness).toBe("verified");
  });

  test("Instagram keeps an image supplied only through image versions", () => {
    const post = { code: "DdUI0nIgGam", caption: { text: "Caption" }, carousel_media_count: 1, carousel_media: [
      { pk: "a", media_type: 1, image_versions2: { candidates: [{ width: 800, height: 800, url: "https://scontent.cdninstagram.com/only.jpg" }] } },
    ] };
    const result = parseInstagram(`<script type="application/json">${JSON.stringify(post)}</script>`, "DdUI0nIgGam", false);
    expect(result.media).toHaveLength(1);
    expect(result.media[0]?.preview_url).toContain("only.jpg");
    expect(result.details.completeness).toBe("verified");
  });

  test("X uses only the requested tweet's text and media", () => {
    const key = btoa("Tweet:2101459900169892038");
    const other = btoa("Tweet:2101460265544151171");
    const html = `{__id:"${key}",media_entities2:$R[1]={__refs:$R[2]=["client:${key}:media_entities2:0"]}} {__id:"client:${other}:details",full_text:"Reply text"} {__id:"client:${key}:details",full_text:"Own text"} {__id:"client:${key}:media_entities2:0",media_url_https:"https://pbs.twimg.com/media/own.jpg",type:"photo"} {__id:"client:${other}:media_entities2:0",media_url_https:"https://pbs.twimg.com/media/reply.jpg",type:"photo"}`;
    const result = parseXPost(html, "2101459900169892038");
    expect(result.text).toBe("Own text");
    expect(result.media).toHaveLength(1);
    expect(result.media[0]?.url).toContain("own");
    expect(result.details.completeness).toBe("verified");
  });

  test("X never borrows reply text or another attachment URL", () => {
    const key = btoa("Tweet:2101459900169892038");
    const other = btoa("Tweet:2101460265544151171");
    expect(() => parseXPost(`{__id:"client:${key}:details",created_at_ms:1} {__id:"client:${other}:details",full_text:"Reply text"}`, "2101459900169892038")).toThrow("text was unavailable");
    const html = `{__id:"${key}",media_entities2:$R[1]={__refs:$R[2]=["client:${key}:media_entities2:0","client:${key}:media_entities2:1"]}} {__id:"client:${key}:details",full_text:"Own text"} {__id:"client:${key}:media_entities2:0",type:"photo"} {__id:"client:${key}:media_entities2:1",media_url_https:"https://pbs.twimg.com/media/second.jpg",type:"photo"}`;
    const result = parseXPost(html, "2101459900169892038");
    expect(result.media.map((item) => item.media_key)).toEqual(["1"]);
    expect(result.details.completeness).toBe("unverified");
    expect(result.details.issues).toContain("Attachment 0 has no safe preview.");
  });

  test("X reads only top-level full_text even when a quoted post appears first", () => {
    const key = btoa("Tweet:2101459900169892038");
    const root = `{__id:"${key}",media_entities2:$R[1]={__refs:$R[2]=[]}}`;
    const nestedFirst = `${root} {__id:"client:${key}:details",quoted:{full_text:"Quoted text"},full_text:"Own text"}`;
    expect(parseXPost(nestedFirst, "2101459900169892038")).toMatchObject({ text: "Own text", details: { completeness: "verified" } });
    const nestedOnly = `${root} {__id:"client:${key}:details",quoted:{full_text:"Quoted text"}}`;
    expect(() => parseXPost(nestedOnly, "2101459900169892038")).toThrow("text was unavailable");
  });

  test("X field boundaries ignore escaped quotes, braces and fake field names in strings", () => {
    const key = btoa("Tweet:2101459900169892038");
    const misleading = 'brace } and ,full_text:"Fake" and \\ slash';
    const own = 'Own { } [ ] "quote" \\ path';
    const html = `{__id:"${key}",media_entities2:$R[1]={__refs:$R[2]=[]}} {__id:"client:${key}:details",noise:${JSON.stringify(misleading)},quoted:{full_text:"Nested"},full_text:${JSON.stringify(own)}}`;
    expect(parseXPost(html, "2101459900169892038").text).toBe(own);
  });

  test("X reads the full Note Tweet and expands links below the short post", () => {
    const key = btoa("Tweet:2101459900169892038");
    const noteId = "NoteTweet:full";
    const html = [
      `{__id:"${key}",note_tweet:$R[1]={__ref:"client:${key}:note_tweet"},media_entities2:$R[2]={__refs:$R[3]=[]}}`,
      `{__id:"client:${key}:details",full_text:"Short preview…"}`,
      `{__id:"client:${key}:note_tweet",note_tweet_results:$R[4]={__ref:"NoteTweetResults:full"}}`,
      `{__id:"NoteTweetResults:full",result:$R[5]={__ref:"${noteId}"}}`,
      `{__id:"${noteId}",__typename:"NoteTweet",text:"First paragraph\\nLater: https://t.co/abc",id:"${noteId}"}`,
      `{__id:"client:${noteId}:entity_set:urls:0",url:"https://t.co/abc",expanded_url:"https://project.example/app"}`,
    ].join(" ");
    const result = parseXPost(html, "2101459900169892038");
    expect(result.text).toContain("First paragraph\nLater: [project.example](https://project.example/app)");
    expect(result.details.completeness).toBe("verified");
  });

  test("X reads article body instead of its short card URL", () => {
    const key = btoa("Tweet:2101459900169892038");
    const html = [
      `{__id:"${key}",article:$R[1]={__ref:"client:${key}:article"},media_entities2:$R[2]={__refs:$R[3]=[]}}`,
      `{__id:"client:${key}:details",full_text:"https://t.co/card"}`,
      `{__id:"client:${key}:article",article_results:$R[4]={__ref:"ArticleResults:full"}}`,
      `{__id:"ArticleResults:full",result:$R[5]={__ref:"ArticleEntity:full"}}`,
      `{__id:"ArticleEntity:full",__typename:"ArticleEntity",id:"ArticleEntity:full",title:"Projects to try",plain_text:"Intro\\nProject near the end"}`,
      `{__id:"client:ArticleEntity:full:content_state:entity_map:0:value:data",__typename:"DraftJsEntityData",url:"https://project.example/repo"}`,
    ].join(" ");
    const result = parseXPost(html, "2101459900169892038");
    expect(result.title).toBe("Projects to try");
    expect(result.text).toContain("Intro\nProject near the end");
    expect(result.text).toContain("[project.example](https://project.example/repo)");
    expect(result.details.completeness).toBe("verified");
  });

  test("X marks a missing long-form body as incomplete", () => {
    const key = btoa("Tweet:2101459900169892038");
    const html = `{__id:"${key}",note_tweet:$R[1]={__ref:"client:${key}:note_tweet"},media_entities2:$R[2]={__refs:$R[3]=[]}} {__id:"client:${key}:details",full_text:"Short preview…"}`;
    expect(parseXPost(html, "2101459900169892038").details).toMatchObject({
      completeness: "unverified", issues: ["The long-form post text was unavailable."],
    });
  });
});

describe("caption selection", () => {
  const tracks = [
    { languageCode: "ar", languageName: "Arabic", isAutoGenerated: true },
    { languageCode: "en", languageName: "English", isAutoGenerated: true },
    { languageCode: "en-US", languageName: "English (US)", isAutoGenerated: false },
  ];
  test("prefers the original author track over the first track", () => {
    expect(selectCaptionTrack(tracks, "en-US")).toMatchObject({ track: tracks[2], reason: "original" });
  });
  test("uses English with a reason when original is absent or unknown", () => {
    expect(selectCaptionTrack(tracks, "pt").reason).toBe("english-fallback");
    expect(selectCaptionTrack(tracks, null).reason).toBe("english-original-unknown");
  });
  test("honors a manual track and does not guess when English is absent", () => {
    expect(selectCaptionTrack(tracks, "en-US", "ar")).toMatchObject({ track: tracks[0], reason: "manual" });
    expect(selectCaptionTrack([tracks[0]!], "pt")).toMatchObject({ track: null, reason: "needs-selection" });
    expect(selectCaptionTrack([], null).reason).toBe("unavailable");
  });
  test("falls back to English if listed original captions fail or are empty", async () => {
    for (const empty of [false, true]) {
      const result = await resolveCaption(tracks, "ar", undefined, async (track) => {
        if (track.languageCode === "ar") {
          if (empty) return { text: "", title: "Video" };
          throw new Error("Original track unavailable");
        }
        return { text: "[0:00] English text", title: "Video" };
      });
      expect(result.selected.reason).toBe("english-fallback");
      expect(result.selected.track?.languageCode).toBe("en-US");
      expect(result.text).toContain("English text");
      expect(result.issues.some((issue) => issue.includes("Original-language"))).toBe(true);
    }
  });
  test("does not replace a failed manual choice without permission", async () => {
    const result = await resolveCaption(tracks, "ar", "ar", async () => { throw new Error("Chosen track unavailable"); });
    expect(result.selected.reason).toBe("manual");
    expect(result.text).toBe("");
  });
  test("offers one menu choice per language and states the author preference", () => {
    expect(captionMenuTracks([
      { languageCode: "en", languageName: "English", isAutoGenerated: true },
      { languageCode: "ar", languageName: "Arabic", isAutoGenerated: true },
      { languageCode: "en", languageName: "English", isAutoGenerated: false },
    ])).toEqual([
      { languageCode: "en", languageName: "English", isAutoGenerated: false },
      { languageCode: "ar", languageName: "Arabic", isAutoGenerated: true },
    ]);
  });
});

test("composition retains good OCR and identifies an individual failure", () => {
  const discovered = { source: "instagram-post", title: "Post", text: "Own caption", media: [], details: { type: "instagram-post" as const, completeness: "verified" as const, issues: [] } };
  const media: MediaItem[] = [
    { media_key: "a", position: 0, kind: "image", url: "https://scontent.cdninstagram.com/a.jpg", preview_url: null, ocr_state: "done", ocr_text: "Olá mundo", ocr_error: null, ocr_model: "gemma" },
    { media_key: "b", position: 1, kind: "image", url: "https://scontent.cdninstagram.com/b.jpg", preview_url: null, ocr_state: "failed", ocr_text: null, ocr_error: "HTTP 403", ocr_model: "gemma" },
  ];
  const result = composeSocial(discovered, media);
  expect(result.state).toBe("partial");
  expect(result.markdown).toContain("Olá mundo");
  expect(result.markdown).toContain("Image 2: HTTP 403");
});

test("video previews receive OCR and remain distinct from video content", () => {
  const discovered = { source: "instagram-reel", title: "Reel", text: "Caption", media: [], details: { type: "instagram-reel" as const, completeness: "verified" as const, issues: [] } };
  const video: MediaItem = { media_key: "v", position: 0, kind: "video", url: "https://scontent.cdninstagram.com/v.jpg", preview_url: "https://scontent.cdninstagram.com/v.jpg", ocr_state: "done", ocr_text: "Words on cover", ocr_error: null, ocr_model: "gemma" };
  const result = composeSocial(discovered, [video]);
  expect(result.state).toBe("ready");
  expect(result.markdown).toContain("Visible text in video preview (OCR):\n\nWords on cover");
  expect(result.markdown).toContain("video motion and audio were not analyzed");
  expect(composeSocial(discovered, [{ ...video, ocr_state: "failed", ocr_text: null, ocr_error: "HTTP 403" }]).state).toBe("partial");
  expect(composeSocial(discovered, [{ ...video, ocr_state: "no_text", ocr_text: null }]).state).toBe("ready");
});

test("signed URL refreshes retain OCR while a changed asset path invalidates it", () => {
  expect(mediaAssetIdentity("https://scontent.cdninstagram.com/cover.jpg?sig=old"))
    .toBe(mediaAssetIdentity("https://scontent.cdninstagram.com/cover.jpg?sig=new"));
  expect(mediaAssetIdentity("https://scontent.cdninstagram.com/cover.jpg?sig=old"))
    .not.toBe(mediaAssetIdentity("https://scontent.cdninstagram.com/new-cover.jpg?sig=new"));
  const db = new Database(":memory:");
  db.exec("CREATE TABLE media_items(link_id TEXT,media_key TEXT,position INTEGER,kind TEXT,url TEXT,preview_url TEXT,ocr_state TEXT,ocr_text TEXT,ocr_error TEXT,ocr_model TEXT,updated_at TEXT,PRIMARY KEY(link_id,media_key))");
  db.query("INSERT INTO media_items VALUES('link','cover',0,'video','https://scontent.cdninstagram.com/cover.jpg?sig=old',NULL,'done','Old words',NULL,'gemma','now')").run();
  const upsert = db.query(MEDIA_UPSERT_SQL);
  upsert.run("link","cover",0,"video","https://scontent.cdninstagram.com/cover.jpg?sig=new",null,"pending","now",0,0,0,0);
  expect(db.query("SELECT ocr_state,ocr_text FROM media_items").get()).toEqual({ ocr_state: "done", ocr_text: "Old words" });
  upsert.run("link","cover",0,"video","https://scontent.cdninstagram.com/new-cover.jpg",null,"pending","now",1,1,1,1);
  expect(db.query("SELECT ocr_state,ocr_text FROM media_items").get()).toEqual({ ocr_state: "pending", ocr_text: null });
  db.close();
});

test("failed and cancelled retries retain a prior partial state", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE links(content_key TEXT, content_details TEXT, content_state TEXT, content_error TEXT, content_source TEXT)");
  db.query("INSERT INTO links VALUES(?,?,?,NULL,'x-post')").run("old.md", JSON.stringify({ completeness: "verified", issues: ["Image 2 failed"] }), "queued");
  db.exec(`UPDATE links SET content_state=${preservedContentStateSql("failed")},content_error='New extraction failed'`);
  expect(db.query("SELECT content_state,content_error FROM links").get()).toEqual({ content_state: "partial", content_error: "New extraction failed" });
  db.exec("UPDATE links SET content_state='queued'");
  db.exec(`UPDATE links SET content_state=${preservedContentStateSql("missing")},content_error=NULL`);
  expect(db.query("SELECT content_state FROM links").get()).toEqual({ content_state: "partial" });
  db.close();
});

test("a failed image acquisition records its own attempt without calling AI", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const env = { DB: { prepare(sql: string) { return { bind(...params: unknown[]) { return { async run() { calls.push({ sql, params }); } }; } }; } } } as unknown as Env;
  await expect(transcribeImage(env, { id: "job", batch_id: "batch", link_id: "link" }, "media", "https://example.com/image.jpg")).rejects.toThrow("allowed public platform asset");
  expect(calls).toHaveLength(2);
  expect(calls[0]?.params).toContain("image-fetch");
  expect(calls[1]?.params).toContain("failed");
});
