<!-- nodeterm:get-linked-context:start -->
# Nodeterm linked context

When `NODETERM_NODE_ID` is set and linked-node context is needed, first read
`/Users/facundopri/.codex/references/nodeterm.md`, section "Reading linked nodeterm nodes".
It preserves the commands, session checks and sandbox retry rules. Outside a
nodeterm session, these commands do not apply.
<!-- nodeterm:get-linked-context:end -->

<!-- nodeterm:manage-canvas:start -->
# Nodeterm canvas

When running in a nodeterm node and the user requests canvas/session control,
node delegation, browser control or media display on that canvas, first read
`/Users/facundopri/.codex/references/nodeterm.md`, section "Managing the nodeterm canvas".
Use its ownership, authorization, dry-run, queued-session and retry rules before
acting. Ordinary repository work does not need the canvas manual.
<!-- nodeterm:manage-canvas:end -->

## Agent skills

### Issue tracker

Track Linklog issues and specs in the existing Linear project. Before reading, creating, or updating tickets, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. Before triaging or changing triage labels, read `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout. Before exploring domain concepts or proposing architectural changes, read `docs/agents/domain.md`.

### Model roles

For multi-step agent work, the coordinator reads [the model profile](.agents/pstack-models.md): the shared sections, then the section for its harness (Codex or Claude Code). These choices override the user-level `~/.agents/pstack-models.md` and bundled pstack defaults.

### Verification

To prove web UI or API behavior in a running app, use the `verify-linklog` skill. It starts an isolated instance with fixture external services and records evidence.

### Browser and extension

Before touching Browser, the Chrome extension, or `packages/browser-protocol`, read `docs/browser-feature-plan.md` (product spec) and `docs/browser-implementation-handoff.md` (how it's actually built: monorepo map, commands, decisions, known limits). `docs/browser-validation.md` holds the evidence.
