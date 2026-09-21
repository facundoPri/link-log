// Integration check against an already-running local D1 worker. Removes only its own records.
import { strict as assert } from "node:assert";
const base = "http://127.0.0.1:8787/api";
const suffix = crypto.randomUUID().slice(0, 8);
const url = `https://example.com/?qa=${suffix}`;
let ids: string[] = [];
let tagIds: string[] = [];
async function request(path: string, method = "GET", body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await r.json()) as any;
  return { status: r.status, data };
}
try {
  const [a, b] = await Promise.all([
    request("/links", "POST", { url, tags: [`qa-${suffix}`] }),
    request("/links", "POST", { url, tags: [`qa-${suffix}`] }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(a.data.id, b.data.id);
  ids.push(a.data.id);
  tagIds = a.data.tags
    .filter((t: any) => t.name === `qa-${suffix}`)
    .map((t: any) => t.id);
  let state = await request("/library");
  assert.equal(
    state.data.links.filter((l: any) => l.original_url === url).length,
    1,
  );
  await request(`/tags/${tagIds[0]}`, "PATCH", { name: `renamed-${suffix}` });
  state = await request("/library");
  assert.equal(
    state.data.links.find((l: any) => l.id === ids[0]).tags[0].name,
    `renamed-${suffix}`,
  );
  for(let i=0;i<80;i++){
    state=await request('/library');
    if(!state.data.batches.some((b:any)=>b.active))break;
    await Bun.sleep(500);
  }
  const patch=await request(`/links/${ids[0]}`, "PATCH", { tags: [] });
  assert.equal(patch.status,200);
  state = await request("/library");
  assert.equal(
    state.data.links.find((l: any) => l.id === ids[0]).tags.length,
    0,
  );
  const invalid = await request("/links", "POST", {
    url: "javascript:alert(1)",
    tags: [],
  });
  assert.equal(invalid.status, 400);
  const origin = await fetch(base + "/links", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://unrelated.example",
    },
    body: JSON.stringify({ url }),
  });
  assert.equal(origin.status, 403);
  console.log(
    "PASS: concurrent dedupe, D1 persistence, tag rename/unassign, invalid URL and origin validation",
  );
} finally {
  for (const id of ids) await request(`/links/${id}`, "DELETE", {});
  for (const id of tagIds) await request(`/tags/${id}`, "DELETE", {});
}
