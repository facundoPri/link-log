// api-submit-text (FAC-158): POST /api/v1/links takes every http(s) URL out of the strings it
// receives. Text with several URLs saves each once, strings without a valid URL come back in
// `rejected` (and are never stored), zero valid URLs and more than 100 URLs after extraction are 400.
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, fixture, step, check, note }) => {
  const origin = new URL(page.url()).origin;
  const { key: secret } = await api.send("POST", "/auth/api-key/create", { name: `Text ${Date.now() % 100000}` });
  const submit = (urls: unknown) =>
    fetch(`${origin}/api/v1/links`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ urls }) });
  const [a, b, c] = [fixture("pool", "1"), fixture("pool", "2"), fixture("pool", "3")];

  await step("Text with several URLs, a repeat, trailing punctuation and a rejected string");
  const text = `Read this: [page](${a}) and <${b}>, again ${a}.`;
  const res = await submit([text, c, "call me maybe", "ftp://files.example/x"]);
  const body = await res.json();
  await note("01-mixed-response", { status: res.status, body });
  await check("API: 202, each URL once with the text as input", () =>
    res.status === 202 &&
    body.results.length === 3 &&
    body.results.slice(0, 2).every((r: { input: string }) => r.input === text) &&
    body.results.every((r: { status: string }) => r.status === "created") &&
    body.batchId);
  await check("API: the two non-URL strings are rejected with a reason", () =>
    body.rejected.map((r: { input: string }) => r.input).join("|") === "call me maybe|ftp://files.example/x" && body.rejected.every((r: { error: string }) => r.error));
  await check("API: the library holds exactly the three URLs and no rejected text", async () => {
    const lib = await api.library();
    return lib.links.length === 3 && !JSON.stringify(lib).includes("call me maybe");
  });

  await step("Zero valid URLs is 400");
  const none = await submit(["nothing here", "ftp://files.example/x"]);
  const noneBody = await none.json();
  await note("02-zero-valid-response", { status: none.status, body: noneBody });
  await check("API: 400 with the message and the rejected list", () => none.status === 400 && noneBody.error === "No valid http or https link found." && noneBody.rejected.length === 2);

  await step("More than 100 URLs after extraction is 400 and saves nothing; 100 is accepted");
  const many = Array.from({ length: 101 }, (_, i) => fixture("pool", `many-${i}`));
  const tooMany = await submit([many.slice(0, 50).join(" "), many.slice(50).join("\n")]);
  const tooManyBody = await tooMany.json();
  await note("03-over-limit-response", { status: tooMany.status, body: tooManyBody });
  await check("API: 400 explaining the limit", () => tooMany.status === 400 && tooManyBody.error === "Send at most 100 links per request.");
  await check("API: nothing was saved", async () => (await api.library()).links.length === 3);
  const fits = await submit([many.slice(0, 50).join(" "), many.slice(50, 100).join("\n")]);
  const fitsBody = await fits.json();
  await check("API: 100 URLs in two strings are accepted", () => fits.status === 202 && fitsBody.results.length === 100);
  await note("04-at-limit-summary", { status: fits.status, results: fitsBody.results.length, batchId: fitsBody.batchId });
}) satisfies Journey;
