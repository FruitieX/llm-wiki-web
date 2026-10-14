# llm-wiki-web

A private reading and editing app for [FruitieX/llm-wiki](https://github.com/FruitieX/llm-wiki), at
**https://llm-wiki.fruitiex.org** (LAN/VPN only, through the private Envoy gateway).

One Rust process (axum) serves the API and a Vite + React 19 + Tailwind v4 + Radix build, with CodeMirror 6 as the
editor. It has no database: **storage is git**.

## How it works

- **Clone.** On start the app clones `LLM_WIKI_REPO_URL` (branch `LLM_WIKI_BRANCH`) into `$LLM_WIKI_DATA_DIR/repo`,
  using the deploy key in `LLM_WIKI_SSH_KEY_FILE`, over `ssh.github.com:443` (port 22 from the cluster intermittently timed out). GitHub's host keys are pinned in `backend/src/git.rs`.
- **Sync.** It fetches and fast-forwards every `LLM_WIKI_SYNC_SECONDS` (60) seconds and before every write. The clone
  never holds unpushed work: a failed push is reset away, and the client keeps the edit as a draft. If the remote is
  rewritten, the clone follows it.
- **Saves.** Each save is one commit (`docs(<area>): …`) authored as `LLM_WIKI_GIT_NAME <LLM_WIKI_GIT_EMAIL>`, then a
  push. A rejected push is rebased onto the remote and retried.
- **Concurrent edits.** The editor remembers the blob it started from. If the page changed upstream, the save returns
  409 with the upstream text and a `git merge-file` three-way merge. The owner reviews it in a CodeMirror merge view
  (accept or reject each chunk) and saves again. Nothing is overwritten silently.
- **Validation.** Saves run the wiki's own `tools/wiki_check.js` (with Node) on a scratch copy of the wiki with the
  change applied. Errors that the change introduces block the save. Errors already present elsewhere, and all
  warnings, are shown but do not block. The rules therefore always match the wiki repository.
- **Renames** rewrite every `[[link]]` to the page, keeping anchors and labels, in the same commit. **New pages** start
  from `templates/` and can add their `wiki/index.md` line.
- **Sign-in.** One owner password (argon2) set on first visit with `LLM_WIKI_SETUP_TOKEN`; 90-day HttpOnly session
  cookies; `auth.json` on the data volume. Writes need the `x-llm-wiki: 1` header and, when set, a matching
  `LLM_WIKI_ORIGIN`.

## Development

```sh
nix develop
npm ci
npm run dev                  # Vite on :3102, proxies /api to :3002
# in another shell, against a scratch clone (never the real wiki):
git clone --bare git@github.com:FruitieX/llm-wiki.git /tmp/wiki.git
LLM_WIKI_REPO_URL=/tmp/wiki.git LLM_WIKI_DATA_DIR=/tmp/llm-wiki-data \
  LLM_WIKI_SETUP_TOKEN=local-setup-token-123456 cargo run --manifest-path backend/Cargo.toml
```

Checks: `npm run typecheck`, `npm run format:check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (real
git repos: concurrent edits, push rejection and retry, rewritten remotes, validation, rename, auth). `npm run test:ui`
drives the built app in Chromium (see the header of `scripts/verify-ui.mjs`), including an agent commit landing
mid-edit, and writes screenshots to `test-results/`.

## Deployment

CI (`.github/workflows/build.yml`) tests, builds the Nix image `ghcr.io/fruitiex/llm-wiki-web`, smoke-tests it and
dispatches `image-update` to `FruitieX/homelab`, which pins the digest in `apps/llm-wiki-web/deployment.yaml`.

The deploy key (write access to `FruitieX/llm-wiki`) lives in 1Password (Agents vault, `llm-wiki-web deploy key`) and,
SOPS-encrypted, in `homelab/apps/llm-wiki-web/secret.sops.yaml` with the setup token.
