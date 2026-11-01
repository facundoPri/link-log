import { expect, test } from "bun:test";
import { uploadCurl } from "../src/lib/upload-curl";

test("the curl example posts a URL to the app's own origin with the secret as a Bearer key", () => {
  expect(uploadCurl("https://linklog.example", "lk_abc")).toBe(
    [
      "curl -X POST https://linklog.example/api/v1/links \\",
      '  -H "Authorization: Bearer lk_abc" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '{"urls":["https://example.com"]}'`,
    ].join("\n"),
  );
});
