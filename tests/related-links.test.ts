import { expect, test } from "bun:test";
import { relatedLinks } from "../src/lib/related-links";

test("finds project links in Markdown and bare text without saving media or duplicates", () => {
  const links = relatedLinks([
    "# Recommendations",
    "[Project Alpha](https://alpha.example/?utm_source=x)",
    "Also https://beta.example/path. And [Alpha again](https://alpha.example/).",
    "![cover](https://images.example/cover.jpg)",
    "[Open image preview](https://pbs.twimg.com/media/abc.jpg)",
    "https://source.example/post#section",
  ].join("\n"), "https://source.example/post");
  expect(links).toEqual([
    { url: "https://alpha.example/", domain: "alpha.example", label: "Project Alpha" },
    { url: "https://beta.example/path", domain: "beta.example", label: "beta.example" },
  ]);
});

test("resolves relative links from the saved page", () => {
  expect(relatedLinks("[Docs](/docs/start)", "https://project.example/article")).toEqual([
    { url: "https://project.example/docs/start", domain: "project.example", label: "Docs" },
  ]);
});

test("recognizes project domains printed without a scheme in X articles", () => {
  expect(relatedLinks("Try github.com/acme/project and Revoke.cash.", "https://x.com/user/status/1").map((link) => link.url)).toEqual([
    "https://github.com/acme/project",
    "https://revoke.cash/",
  ]);
});

test("omits X media and the source post with tracking parameters", () => {
  expect(relatedLinks("https://x.com/user/status/1?s=20 https://x.com/user/status/1/photo/1 https://project.example/", "https://x.com/user/status/1").map((link) => link.url)).toEqual(["https://project.example/"]);
});
