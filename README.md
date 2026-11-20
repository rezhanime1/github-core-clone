# github-core-clone

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/rezhanime1/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/rezhanime1/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in TypeScript, built from scratch for the
[github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01).
Node 22 standard library only — no dependencies, no git binary, no network
at runtime.

## What it serves

- **REST v3** under `/api/v3`: repositories, branches, commits, contents
  (create/update/delete with real git commits), labels, issues, comments and
  pull requests (open, list, files, squash-merge with conflict detection).
- **Git smart HTTP** at `/{owner}/{repo}.git`: `upload-pack` protocol v0
  and v2 (`ls-refs`, `fetch`, shallow/deepen) and `receive-pack` v0 with
  fast-forward enforcement. Packfiles are written and read from scratch
  (`node:zlib`, `node:crypto`); every object is content-addressed by SHA-1.
- **GraphQL v4** at `/api/graphql`: repository/issue/pull-request queries,
  cursor pagination, mutations (create/close issue, create/merge pull
  request, add comment), `node(id:)` with opaque global ids, and `__type`
  / `__schema` introspection.
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP, modern era 2026-07-28
  (`server/discover`) with the legacy `initialize` handshake as a fallback,
  and six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same store
  as REST.

Everything lives in memory (Maps) and is deterministic: no wall clock is
read anywhere — timestamps come from a counter — and ids are sequential.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle: it binds an ephemeral port, registers
it with `$MAKEFUN_ENV_URL`, polls `$MAKEFUN_ENV_URL/done` and exits 0.
`GET /healthz` answers `200 {"ok": true}`. The API surfaces take a bearer
token from `MAKEFUN_SHOP_TOKEN` (accept-all when the variable is empty, for
local testing).

## Layout

- `main.ts` — entry lifecycle (bind, register, wait for done, exit 0).
- `app.ts` — HTTP server and routing.
- `store.ts` — the in-memory store and the git object layer (objects,
  trees, commits, reachability, shallow/deepen fetch sets).
- `pkt.ts` — pkt-line framing and packfile read/write.
- `git.ts` — smart-HTTP handlers (info/refs, upload-pack v0/v2,
  receive-pack v0).
- `rest.ts` — REST v3 routes and the shared domain operations.
- `graphql.ts` — the GraphQL parser, executor and introspection schema.
- `mcp.ts` — the MCP endpoint and its six tools.

## Local conformance

Against the kit's own suite (`sdk/run.ts --perf`):

- **120/120 checks pass** (git 30, repos 15, issues 15, pulls 20,
  graphql 20, mcp 15, protocol 5)
- **Score 974/1000** (feature 600 + agent 200 + perf 174)

## License

MIT — see `LICENSE`.
