// Current authenticated integration contract (2026-10-19). External services are deterministic fixtures.
import { chapter, scenario } from "../recorder";
export default chapter({
  id: "integration", title: "Authenticated recovery and automatic metadata fallback", ticket: "FAC-48 / FAC-52–57", optional: true,
  env: { fastRetries: true, vars: { BROWSER_CONCURRENCY: "1" } },
  summary: ["Real session and private library", "Automatic metadata fallback and truthful provenance", "Retry, waiting cancellation, skipped feedback and valid Activity markup"],
  scenarios: [
    scenario("INT-01", "Automatic fallback, retries and skipped-link feedback", {ticket:"FAC-48", expected:"Useful metadata is used automatically after a final failure; unavailable links are skipped explicitly."}, async ({page, api, expect, click, step, fixture}) => {
      await step("Save a login wall, a transient 503 and an unavailable page", "Only the unavailable page needs attention");
      const urls = [fixture("login-wall","fallback"), fixture("flaky","retry"), fixture("gone","missing")];
      await api.send("POST", "/import", {urls});
      await expect("All three jobs settle", async()=>{const l=(await api.library()).links;return l.length===3&&l.every(x=>!x.processing);},{timeout:45000});
      const fallback = (await api.link(urls[0]!))!, missing=(await api.link(urls[2]!))!;
      await expect("Fallback has usable metadata and no warning", async()=>fallback.content_source==="preview"&&fallback.attention_kind===null);
      await expect("Missing content keeps a warning",async()=>missing.attention_kind==="content");
      await expect("Transient preview recovered on attempt two",async()=>(await api.jobs(urls[1]!))[0].status==="done");
      await page.reload();
      await click(page.getByText(fallback.title,{exact:true}));
      await expect.visible(page.getByText("Metadata available as content",{exact:true}).first());
      await expect("No login-form text is saved",async()=>!(await api.get(`/links/${fallback.id}/content`)).markdown.includes("Password"));
      await click(page.getByRole("button",{name:"Close inspector"}));
      await api.send("POST","/tags",{name:"integration-topic"});
      await page.reload();
      await click(page.getByRole("checkbox",{name:"Select all 3 links"}));
      await click(page.getByRole("button",{name:"Auto-tag",exact:true}));
      await click(page.getByRole("button",{name:"Auto-tag 2 with content"}));
      await expect.visible(page.getByText("Skipped 1 link without content",{exact:true}));
      await expect("Two evaluated links, one skipped, metadata provenance retained",async()=>{const l=(await api.library()).links;return l.filter(x=>x.evaluations.length).length===2&&!!l.find(x=>x.id===fallback.id)?.metadata_evaluated;},{timeout:30000});
      await click(page.getByRole("button",{name:"Activity",exact:true}));
      await expect("Activity has no nested buttons",async()=>await page.locator("button button").count()===0);
      await page.keyboard.press("Escape");
      await api.send("POST",`/links/${missing.id}/dismiss`,{});
      await expect("Dismiss clears only the warning",async()=>{const l=await api.link(urls[2]!);return l?.attention_kind===null&&l?.content_state==="failed";});
    }),
    scenario("INT-02", "Cancel a batch while Browser capacity is occupied", {ticket:"FAC-55",expected:"Waiting jobs and their dependent Jev jobs cancel; committed content survives."},async({page,api,expect,click,step,fixture})=>{
      await step("Occupy one Browser slot and queue more work", "Activity distinguishes running work from waiting for a Browser slot");
      const urls=[fixture("pool","one"),fixture("pool","two"),fixture("pool","three")];
      await api.send("POST","/import",{urls});
      await api.send("POST","/tags",{name:"cancel-topic"});
      const lib=await api.library();
      await api.send("POST","/batches",{kind:"autotag",ids:lib.links.map(l=>l.id)});
      await expect("A workflow waits for a Browser slot",async()=>(await Promise.all(urls.map(u=>api.jobs(u)))).flat().some(j=>j.step==="Waiting for Browser slot"),{timeout:10000});
      await page.reload();
      await expect.visible(page.getByText("Waiting for Browser slot",{exact:true}).first());
      await click(page.getByRole("button",{name:/Activity|Extracting|Auto-tagging/,exact:false}).first());
      await expect("Activity markup remains valid with cancel controls",async()=>await page.locator("button button").count()===0);
      const batch=(await api.library()).batches.find((b:any)=>b.kind==="extract");
      const cancelled=await api.send("DELETE",`/batches/${batch.id}`,{});
      await expect("Batch cancels waiting extractions and dependent Jev work",async()=>cancelled.cancelled>=1&&cancelled.dependents>=1);
      await expect.holds("No cancelled link gets a warning or late content",16000,async()=>{const jobs=(await Promise.all(urls.map(u=>api.jobs(u)))).flat();const links=(await api.library()).links;return jobs.filter(j=>j.kind==="extract"&&j.step==="Cancelled").every(j=>{const l=links.find(x=>x.id===j.link_id)!;return !l.content_key&&l.attention_kind===null;});});
      await page.keyboard.press("Escape");
    }),
  ],
});
