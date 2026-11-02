/** The `curl` call shown next to a new API key's secret: submits one URL to the app's own origin. */
export const uploadCurl = (origin: string, secret: string) =>
  [
    `curl -X POST ${origin}/api/v1/links \\`,
    `  -H "Authorization: Bearer ${secret}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"urls":["https://example.com"]}'`,
  ].join("\n");
