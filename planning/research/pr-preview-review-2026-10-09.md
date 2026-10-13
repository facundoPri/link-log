# Independent PR preview review — 2026-10-09

**Final disposition: no remaining concrete merge blocker found in the reviewed implementation after two lifecycle fixes. This is local code/documentation approval, not deployment or hosted acceptance.** The initial destructive stale-deploy behavior and short-page discovery bug were reported to the implementer, fixed by that worker, and independently rechecked. No implementation or application files were edited by this reviewer.

Reviewed `.github/workflows/pr-preview.yml`, `scripts/preview/*.ts`, `tests/preview.test.ts`, the implementation report, and relevant installed Wrangler 4.136.1 code. Final suite: **14 tests pass, 0 fail, 82 assertions**. Additional probes exercised the real API wrapper and settlement function, plus the unchanged artifact-validation block with in-memory filesystem adapters. No Cloudflare/GitHub mutations, remote migration/deployment, demo access, commit or push occurred.

## Findings resolved during review

### R1 — P2: a push during deployment destroyed persistent preview data — fixed

The original `run.ts` post-deploy check called full `cleanup` whenever the current SHA differed from the artifact SHA, even if the PR was still open and labeled. Since D1/R2 names are per PR, that branch deleted accounts/content belonging to the continuing preview, rather than merely superseding code. A normal synchronize can hit this branch between upload and the post-check.

Final [settleDeployment](../../scripts/preview/lifecycle.ts#L4) reserves destructive cleanup for `state.action === "cleanup"`. A different live SHA causes only:

```text
POST /accounts/<account>/workers/scripts/llpr-12345-5/subdomain
{"enabled":false,"previews_enabled":false}
```

My independent invocation with expected SHA `aaaa…` and live SHA `bbbb…` returned `false`, recorded exactly that one POST, and recorded **zero DELETEs**. The new unit test covers this branch and same-head no-op behavior. The subsequent generated config explicitly sets `workers_dev: true`. This POST/path/body agrees with the official [script subdomain API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/).

This is suppression of the stale public endpoint, not a rollback or stop of its scheduled/queued work. It preserves data until the next serialized successful deployment; the implementation report accurately leaves cloud failure/manual-cancellation recovery to a rerun.

### R2 — P2: discovery missed resources after a short first page — fixed

Original `Cloudflare.named` terminated when `result.length < 100`, even when `result_info.total_pages` declared more pages. Independent offline reproduction returned 20 unrelated queues on page 1 with `{per_page:20,total_pages:2}`, and the desired queue on page 2: **original result `null`, requests `1`**. That could make cleanup miss an existing queue or provisioning try to recreate its name. The Queue API documents a paginated 20-item response, while its current reference does not promise the requested `per_page=100` will be honored; installed Wrangler's queue lookup uses `page`/`name`. [Official Queue list](https://developers.cloudflare.com/api/resources/queues/methods/list/).

Final [discovery](../../scripts/preview/cloudflare.ts#L18) uses explicit total-page metadata or continues until an empty page. The identical independent probe now returns the desired queue after **2 requests**. The regression test passes. The 1000-page bound still fails closed rather than assuming absence.

The implementer also removed the unrelated-label skip: otherwise a skipped latest workflow could replace a queued cleanup under GitHub concurrency. The final plan reconciles every same-repository label event against live PR state.

## Trust boundary and isolation checks

- `pull_request_target` control checkout uses `github.sha`, never the PR head. Only the separate build job checks out the immutable head SHA. It has read-only GitHub permissions, no preview environment/secrets, no shared cache, and `persist-credentials: false`. Build scripts remain untrusted executable code, confined to that job. The artifact is downloaded by exact current run/attempt name. This addresses the unsafe checkout pattern described in [GitHub's event/security documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target).
- The secret-bearing runner executes trusted scripts, generates its own Wrangler config and passes `--no-bundle`. It does not run the PR's package installation/build/config hooks. Installed Wrangler's no-bundle path reads module files rather than executing the Worker; the module root is the `worker` directory. The artifact gate allows only the expected root directories/files and only `index.js`, its map and README under `worker`.
- The artifact guard accepted the valid contract and rejected all six adverse inputs tested: a symlink, FIFO/special file, root `.env`, extra `worker/plugin.js`, `../secret.sql` migration entry, and wrong manifest SHA. These were **in-memory filesystem adapter probes of the unchanged guard block**, not a real malicious ZIP/download-action extraction test. Its recursive `lstat` check covers nested artifact entries; uploaded paths are then handled by pinned GitHub artifact actions. No secret-exfiltration/code-execution path was demonstrated.
- Resource identities originate only from validated numeric repository/PR IDs, generated config, and exact-name API lookup. No branch name, artifact config, production binding ID, route or command is trusted. A foreign Queue consumer fails before cleanup deletes anything. The `llpr-*` namespace must remain reserved for this automation, as documented; this is not a proof of account-wide ownership tagging.
- HTTPS origin is generated from the fixed Worker name and validated account subdomain, verified against the selected account. HMAC derivation keeps the preview auth secret stable across redeploys and distinct across PRs/repositories. Only the derived secret goes into the mode-0600 temporary secrets file; the seed is not in config/artifact. [Wrangler documents atomic secret upload with deployment](https://developers.cloudflare.com/workers/configuration/secrets/).
- Preview runtime code necessarily receives its own auth secret and bound preview data/services. The security claim is separation from the CI Cloudflare token/master seed and other resource names, not distrust of an authorized preview's access to its own bindings. AI/Browser/Email account services and billing are shared with the selected account, as the implementation report states.

## Cloudflare API review

Checked current official documentation on this date; no Cloudflare API call was made by this review.

| Resource | Implementation | Official reference/result |
| --- | --- | --- |
| D1 | List/create `/d1/database`, delete `/d1/database/:uuid` | [Create](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/), [list](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/list/), [database methods including delete](https://developers.cloudflare.com/api/go/resources/d1/subresources/database/): paths and name/UUID shape agree |
| R2 bucket | POST `/r2/buckets`, GET/DELETE `/r2/buckets/:name` | [Create](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/), [bucket methods](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/): name/result shape agrees |
| R2 objects | GET `.../objects?per_page=1000`, DELETE `.../objects/:encodedKey` | [List](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/), [object methods](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/): these REST endpoints **are now documented**; list returns an array and allows up to 1000 |
| Queues | List/create `/queues`, detail/delete `/queues/:id`, consumer delete `.../consumers/:id` | [Create](https://developers.cloudflare.com/api/resources/queues/methods/create/), [delete](https://developers.cloudflare.com/api/resources/queues/methods/delete/), [consumer delete](https://developers.cloudflare.com/api/resources/queues/subresources/consumers/methods/delete/): paths agree; short-page handling was corrected |
| Workflows | Wrangler deployment config establishes the named Workflow; cleanup DELETE `/workflows/:name` | [Workflow methods](https://developers.cloudflare.com/api/resources/workflows/), [delete semantics](https://developers.cloudflare.com/api/resources/workflows/methods/delete/): create/modify is PUT, deletion is separate from Worker deletion |

R2 cleanup repeatedly reads the first page after deleting its contents; without a delimiter this does not skip surviving keys through a shifting cursor. The tests exercise multiple pages and encoded slash/query/hash/`../` keys. Dot-only keys deliberately fail with manual recovery guidance. Destructive cleanup order is consumer → Workflow → Worker → Queue → bucket contents/bucket → D1; failures propagate rather than masquerading as absence. API contract/mock verification does not establish live completion of in-flight invocations or remote error behavior.

## Migration/redeploy and bootstrap boundaries

The controller reuses the same per-PR D1 and applies SQL before deploying the new Worker. This preserves ordinary preview state and stops publication on a migration failure. **It is not an atomic code/schema switch:** old code may continue serving while migrations run, and a newly superseded head may already have applied migrations before the second state check. The implementation report expressly requires backward-compatible forward migrations; this review accepts that bounded preview contract, not arbitrary destructive schema changes or rollback safety. The implementer's successful bundle/no-bundle dry runs and all 14 local migrations are attributed evidence; I did not rerun those filesystem-producing commands.

**The bootstrap gap is real and remains an operational prerequisite.** Live read-only GitHub checks returned PR **#5 open**, base **main** at `32fc90f40c6f136e8038aafa0a143404e531d0f4`, head `eb98062d2166c2a9a3ad7628fe0c35b11754e6e4`, labels `[]`; fetching `.github/workflows/pr-preview.yml` on `main` returned **404**. GitHub runs `pull_request_target` from the trusted default/base repository context, not this unmerged workflow. Adding the label now cannot activate it. The implementation report correctly requires a separate reviewed infrastructure bootstrap on main, then environment/account/sender setup and labeling the intended pushed app head. No manual hosted bootstrap was implemented or run. [GitHub trigger semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target).

Remaining acceptance is hosted: GitHub Actions execution with configured scoped credentials, resource provisioning, remote migrations, real Email Service delivery, HTTPS cookies/auth, Queue/Workflow/Browser/AI extraction, state preservation across synchronize, and actual label/close cleanup. Those are not claimed by the passing offline suite.

## Reproduction and reviewed snapshot

Repeat the durable regressions with:

```sh
bun test tests/preview.test.ts
```

The short-page independent probe (no network) is:

```sh
bun - <<'TS'
import { Cloudflare } from './scripts/preview/cloudflare';
let calls = 0;
const cf = new Cloudflare('a'.repeat(32), 'fake', (async () => {
  calls++;
  return Response.json({ success: true,
    result: calls === 1
      ? Array.from({ length: 20 }, (_, i) => ({ queue_name: `other-${i}` }))
      : [{ queue_name: 'wanted', queue_id: 'b'.repeat(32) }],
    result_info: { page: calls, per_page: 20, total_pages: 2 },
  });
}) as typeof fetch);
console.log({ found: await cf.named('/queues', 'queue_name', 'wanted'), calls });
TS
```

Reviewed SHA-256 identities (working-tree files, not a claim they are committed):

| File | SHA-256 |
| --- | --- |
| `.github/workflows/pr-preview.yml` | `2ca9c5d5f66ae036c65c5e5adbaf017e5015c5818b65a63886bd19b969c328c4` |
| `scripts/preview/run.ts` | `e473f6a819153ab1b8969a6447bbd7346ffb2f245e60ba08e9b60b1c36209d48` |
| `scripts/preview/lifecycle.ts` | `bc34e16bea8b9b6b802d2cb5c59fd3a3da5a78088a711dd1a5eff4d5d44c07f8` |
| `scripts/preview/cloudflare.ts` | `a093258b372a0e8e55f55cbaecff228b4bdea814e117d566d4abc0f33526d3eb` |
| `scripts/preview/model.ts` | `308e2b46e9b06edc6094099e5c4a30c767d8c9498c1443bf4c8955a561e78ac2` |
| `scripts/preview/build.ts` | `b272aec6c47a3ecac68b75b3bbe9a26ae631b99665bf5e5d4421efdaa1f2f4b8` |
| `scripts/preview/github.ts` | `7ed51dc1c4862681f5d21f0320cdd090d683206b221fc808634664f44260fcb5` |
| `tests/preview.test.ts` | `ae93e434b55c2795a8ca4c21fad90373234ebd227690a7f5cc837b6d21aadd78` |
