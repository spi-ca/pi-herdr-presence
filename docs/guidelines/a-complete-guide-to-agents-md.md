# AGENTS.md Progressive Disclosure Guide

Use `AGENTS.md` as a small, stable entry point for coding agents. Put details in focused docs that agents can open only when the task needs them.

## Keep AGENTS.md Small

Include only information that is useful for almost every task:

- A short project description.
- Non-default package manager or runtime requirements.
- Essential build, test, and run commands.
- Cross-cutting rules that prevent real project-specific mistakes.
- Links to focused docs for architecture, testing, operations, conventions, and recent memory.

Avoid long file inventories, dependency version lists, generated script catalogs, and broad style advice that belongs in topic docs.

## Prefer Stable Guidance

Documentation loaded into every agent session should not depend on volatile implementation details. Describe capabilities and architectural boundaries before exact paths. When exact paths matter, keep them in the narrowest relevant topic doc and phrase them as current entry points rather than permanent structure.

Stable examples:

- "Persistence uses custom JDBC repositories; see `docs/development-conventions.md`."
- "Frontend route patterns live in `frontend/docs/routing.md`."

Stale-prone examples:

- Exhaustive package trees.
- Complete route inventories.
- Exact dependency patch versions outside lockfiles or package manifests.
- Copied command lists that duplicate `package.json` or Gradle tasks.

## Organize By Scope

Use progressive disclosure by scope:

| Location | Use For |
|----------|---------|
| Root `AGENTS.md` | Backend-wide essentials and links |
| Nested `AGENTS.md` | Area-specific essentials, such as frontend work |
| Topic docs | Architecture, testing, operations, conventions, routing, components |
| Memory docs | Recent decisions and session context, not stable rules |

Nested instruction files are tool-dependent. Keep equivalent files synchronized when a tool uses a different instruction filename.

## Maintenance Checklist

When editing agent-facing docs:

- Remove contradictions instead of adding exceptions.
- Move detailed rules to the most specific topic doc.
- Replace exhaustive structure lists with stable categories when possible.
- Keep recent history in memory files and durable policy in topic docs.
- Delete copied article content, CTAs, and future-post references that do not guide work in this repository.
