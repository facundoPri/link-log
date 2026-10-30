---
name: react-doctor
description: Scan Linklog's React code with react-doctor for correctness, performance, accessibility and maintainability findings, locally and read-only. Use after changing React code in src/ or apps/extension/src/, when the user says "run react doctor" or asks to check React code health. Advisory only; never a merge or commit gate.
---

# React Doctor

[react-doctor](https://www.react.doctor/) is a static scanner for React code. It runs on demand through `npx`; nothing is added to `package.json`, CI or git hooks. Findings are hypotheses: read the code before fixing or suppressing one.

## Run it

From the repo root:

```sh
export REACT_DOCTOR_NO_TELEMETRY=1
npx react-doctor@latest -y --no-telemetry --no-supply-chain --verbose --scope changed --base origin/main
```

- `--scope changed --base origin/main` reports only findings your branch introduced. Use `origin/main`, not a local `main` that may be stale. Drop both flags for a full scan.
- `--json --json-out /tmp/react-doctor.json` writes a machine-readable report. Add `--blocking none` so the exit code is always 0.
- `npx react-doctor@latest design --verbose` runs only the UI design rules.
- `npx react-doctor@latest why src/App.tsx:42` explains why a rule fired there. `npx react-doctor@latest rules explain <rule>` explains a rule.

`doctor.config.json` excludes `qa/`, `.agents/`, `planning/`, `scripts/`, `tests/` and `worker/`. The Worker is not React: its `rules-of-hooks` errors flag the D1 helper `usePreviewStatement`, which is not a hook.

## Do not

- Do not run `react-doctor install`, `install --yes` or `ci install`. They write skill files for 17 agents, a `doctor` script, a devDependency, a git hook and a GitHub Actions workflow, and the owner rejected an automated gate. The scan prints a "not installed in this project, run `npx react-doctor install --yes`" notice; ignore it.
- Do not drop `--no-telemetry` or `--no-supply-chain`. Without `--no-telemetry` the CLI sends the findings to `www.react.doctor/api/score`: rule, message, file path and line, plus the repo name and commit SHA. It sends no source code. This repo is private, so that upload needs the owner's approval. The score is computed only on that server, so local runs report `score: null`; judge by finding counts. Without `--no-supply-chain` it also sends dependency names to Socket.dev.
- Do not fail a task or block a commit because of a finding. Fix what your change introduced, and mention the rest.
