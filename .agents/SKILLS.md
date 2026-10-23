# Project skills

Installed locally in `.agents/skills/`; `.claude/skills/` contains relative links to the same files.

- [Matt Pocock](https://github.com/mattpocock/skills): 38 skills.
- [Pstack standalone mirror](https://github.com/backnotprop/pstack): 54 skills.
- The existing `typesafe-ai` skill is preserved.

Pstack's `tdd` and `teach` are installed as `pstack-tdd` and `pstack-teach` to keep both collections. Pstack references use those aliases.

`skills-sources.json` records the pinned source commits, original paths, local aliases, and SHA-256 hashes of installed files. It is a provenance manifest, not a skills CLI lockfile. Review these aliases before updating either collection.

Installation does not run setup workflows. Invoke `setup-matt-pocock-skills` or `setup-pstack` when you want to configure their workflows.
