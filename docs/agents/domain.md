# Domain docs

## Layout and reading rules

Use a single-context layout: `GLOSSARY.md` at the repository root and architectural decision records in `docs/adr/`.

Before exploring the codebase, read the glossary and ADRs relevant to the work. If a root `GLOSSARY-MAP.md` exists later, follow its pointers to the relevant context glossaries and check context-scoped ADRs too.

If these files do not exist, proceed silently. The `domain-modeling` skill creates them lazily when terms or decisions are resolved.

## Vocabulary and decisions

Use glossary terms in issue titles, proposals, hypotheses, and tests. If a needed concept is absent, reconsider whether the project uses it; note a real vocabulary gap for `domain-modeling`.

If a proposal contradicts an existing ADR, identify that ADR and explain why the decision should be reopened.
