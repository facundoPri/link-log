# Project pstack model profile

This file overrides the user-level `~/.agents/pstack-models.md` and the bundled pstack
defaults in this repository. Budget: medium, meaning high reasoning effort for every
role. Codex's Luna is the one exception: it has an explicit `xhigh` override.
The profile selects delegated roles. It cannot change the active chat's model.

Read the shared sections, then only your harness's section: [Codex](#codex) or
[Claude Code](#claude-code). Role names are the same in both sections. A role line
from the other harness's section never applies, because its models are not
available to you.

## Bounded-work contract

This applies to Luna in Codex and Haiku in Claude Code.

Give exact files, acceptance criteria and a bounded report. Suitable work includes
an explicit replacement, locating call sites, removing redundant narration in
comments, checking links, collecting test failures, or running the checks
(`bun run typecheck`, `bun test`, and `verify-linklog` for UI and API behavior).
Prefer a script for deterministic transformations. Running checks in the owning
agent is usually cheaper than spawning a new agent just to launch one command.

The bounded model reports evidence and unresolved cases. It does not determine
architecture, diagnose subtle failures, certify security, or issue the final
correctness verdict. When cleaning comments, preserve non-obvious rationale,
constraints, licensing, lint/tool directives, public API documentation and test
fixtures, and flag ambiguity for the owner. Inspect the diff and the appropriate
checks before accepting edits. If the scope expands or a correction still fails,
stop the mechanical task and hand the evidence to the implementation model. Use
the architecture model when the uncertainty is architectural or critical.

Commit work requires authorization for the actual commit, exact allowed paths, a
reviewed diff and passing checks. As part of a mechanical assignment, never use
`git add .`, amend unrelated commits, push, or bypass hooks. A general discussion of
commit roles does not authorize committing the current dirty working tree.

Panels are created only for a consequential unresolved decision. Report any
unsupported model and map it to an available model from your section. Never send
it silently to an upstream Claude or Grok default.

## Codex

Pass exact model IDs without effort suffixes, and set `reasoning_effort` separately.

| Role | Model | Effort |
| --- | --- | --- |
| coordinator (recommended when starting a chat) | gpt-6.1-sol | high |
| implementation, refactoring, diagnosis, broad exploration | gpt-6.1-sol | high |
| architecture, concurrency/security decisions, critical review | gpt-6-astra | high |
| mechanical edits, comment cleanup, narrow inventory | gpt-6-luna | xhigh |
| execute checks, parse logs, verify explicit facts | gpt-6-luna | xhigh |
| prepare authorized commit from explicit paths | gpt-6-luna | xhigh |

# budget: medium (high)
feature, refactoring: gpt-6.1-sol
bug-fix: gpt-6.1-sol
perf-issue: gpt-6.1-sol
hillclimb: gpt-6.1-sol
judgment and prose: gpt-6-astra
hardest tasks: gpt-6-astra
how explorer: gpt-6.1-sol
how explainer: gpt-6-astra
why investigators: gpt-6.1-sol
why synthesizer: gpt-6-astra
reflect tooling: gpt-6.1-sol
reflect judgment, divergent, synthesizer: gpt-6-astra
arena runners: gpt-6-astra, gpt-6.1-sol
arena cross-judge pool: gpt-6-astra, gpt-6.1-sol
swarm workers: gpt-6.1-sol
architect runners: gpt-6-astra, gpt-6.1-sol
interrogate reviewers: gpt-6-astra, gpt-6.1-sol

## Claude Code

In the `Agent` tool, pass the alias below as `model` and `effort: "high"`
separately. The tool accepts only the aliases `opus`, `sonnet` and `haiku`; they
resolve to `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`. Sol work
maps to Sonnet, Astra to Opus, and Luna to Haiku.

| Role | Model | Effort |
| --- | --- | --- |
| coordinator (recommended when starting a chat) | opus | high |
| implementation, refactoring, diagnosis, broad exploration | sonnet | high |
| architecture, concurrency/security decisions, critical review | opus | high |
| mechanical edits, comment cleanup, narrow inventory | haiku | high |
| execute checks, parse logs, verify explicit facts | haiku | high |
| prepare authorized commit from explicit paths | haiku | high |

# budget: medium (high)
feature, refactoring: sonnet
bug-fix: sonnet
perf-issue: sonnet
hillclimb: sonnet
judgment and prose: opus
hardest tasks: opus
how explorer: sonnet
how explainer: opus
why investigators: sonnet
why synthesizer: opus
reflect tooling: sonnet
reflect judgment, divergent, synthesizer: opus
arena runners: opus, sonnet
arena cross-judge pool: opus, sonnet
swarm workers: sonnet
architect runners: opus, sonnet
interrogate reviewers: opus, sonnet
