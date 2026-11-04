---
status: accepted
---

# Jev jobs run in their own queue, not in Workflows

Jev jobs (lens, auto-tag, query, and the Browser lens and autogroup evaluations) run directly in the consumer of a dedicated `linklog-jev` Queue, and the Queue's `max_batch_size × max_concurrency` is the ceiling on simultaneous Jev calls. This replaces one Workflow per job holding a slot in the D1 `provider_leases` pool, which waited blindly in 2-second retries and capped throughput far below Jev's rate limit. Extraction jobs stay in Workflows, because their many durable steps need it (FAC-180).

## Considered Options

- **Raise the D1 lease pool and order it FIFO.** Smallest change, but it keeps the polling wait and its extra Workflow steps.
- **A Durable Object as gatekeeper.** Exact ordering, instant hand-off and per-user fair share, at the cost of a new component. Deferred until measured slot waits justify it; it would also serve Browser capacity (FAC-167).

## Consequences

- No fair share between users: a small batch can wait behind a large one.
- Queue delivery is at-least-once and there are no durable steps, so the D1 `jev_call` claim is what prevents a second, billed call for the same job.
- A 429 from Jev is retried with `message.retry` honoring `Retry-After`. It is the one exception to FAC-54's rule that a sent call is never retried automatically.
