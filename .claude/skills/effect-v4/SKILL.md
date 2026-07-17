---
name: effect-v4
description: >-
  Use when writing, debugging, or reviewing Effect-TS v4 (4.0.0-beta) code in this
  repo — resolving an Effect API, verifying a signature/error shape, or finding
  idiomatic usage. v4 is a fast-moving beta whose web docs are outdated; this skill
  points you at the vendored Effect source (repos/effect) so you read real
  implementations instead of guessing or applying stale v3 patterns. Trigger on any
  uncertainty about an `effect` import, module, type, or `effect/unstable/*` API.
---

# Effect v4 source reference

This repo runs **Effect v4 (`4.0.0-beta.70`)**. Public docs lag the real APIs, and v3
patterns frequently do **not** apply. The complete Effect v4 source is vendored at
**`repos/effect`** (a `git subtree` of **`Effect-TS/effect-smol`**, the v4 dev repo,
pinned to the `effect@4.0.0-beta.70` tag — it matches the installed version exactly).
v4 lives in `effect-smol`, NOT `Effect-TS/effect` (still v3). Treat it as the
authoritative reference — read it instead of guessing or trusting web search.

## Golden rule

**Don't assume — read the source.** If you are about to write an Effect v4 API call
and you are not 100% certain of its current shape, look it up in `repos/effect` first.
The cost of a grep is far lower than the cost of a wrong v3-flavored guess.

## Where things live

All under `repos/effect/packages/effect/src/`. Module name maps 1:1 to the import:

| Import | Source |
|--------|--------|
| `effect` (e.g. `Context`, `Effect`, `Layer`, `Schema`, `Data`, `DateTime`) | `src/<Module>.ts` |
| `effect/unstable/http` | `src/unstable/http/` |
| `effect/unstable/httpapi` | `src/unstable/httpapi/` |
| `effect/unstable/rpc` | `src/unstable/rpc/` |
| `effect/unstable/sql` | `src/unstable/sql/` |
| `effect/unstable/reactivity` (Atom) | `src/unstable/reactivity/` |

`@effect/sql-pg` and `@effect/atom-react` live under `repos/effect/packages/`.

## How to use it

- **Resolve / verify an API:** open `repos/effect/packages/effect/src/<Module>.ts` and
  read the exported `declare const` / class / interface. Grep for the symbol:
  `rg "export (declare const|class|interface) <Name>" repos/effect/packages/effect/src`
- **Find idiomatic usage:** search tests and examples —
  `rg "<api>" repos/effect/packages/effect/test repos/effect/packages/effect/examples`
- **Confirm an error/option shape** before constructing it (constructors changed a lot
  between betas).

## Hard rules

- `repos/effect` is **read-only reference material**. Never edit it, never import from
  it, never copy its files into `packages/` or `apps/`.
- App/package code depends on the **published `effect` package** via the
  `pnpm-workspace.yaml` catalog — not the vendored tree.
- It's excluded from search/auto-import/watching (`.vscode/settings.json`) and from the
  pnpm / tsc / vitest workspaces, so it won't interfere with builds.
- To refresh it:
  `git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect-smol.git effect@4.0.0-beta.70 --squash`
  (re-pin the tag to whatever version the catalog uses; use `main` for the latest)

## Known v4 deltas (verify against source if in doubt)

- **`ServiceMap` → `Context`**: the module was renamed back to `Context`. Use
  `Context.Service<Self, Shape>()("Id")`, `Context.Reference<T>("Id", { defaultValue })`,
  `Context.make(key, value)`, `Context.add`, `Context.get`.
- **`SqlError`** wraps a structured reason:
  `new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause }) })` (the `cause`
  field is now derived, not a constructor arg).
- Service keys are yieldable directly: `const db = yield* Database` (no `FiberRef.get`).
- See `CLAUDE.md` → "Effect v4 — Vendored Source Reference" for the project-level summary.
