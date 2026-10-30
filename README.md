# llm-wiki-web

A self-hosted reading and editing app for an LLM-maintained wiki: a Git repository of Markdown pages (configured via
`LLM_WIKI_REPO_URL`). It is meant to run behind a private reverse proxy.

One Rust process (axum) serves the API and a Vite + React 19 + Tailwind v4 + Radix build, with CodeMirror 6 as the
editor. It has no database: **storage is git**.

## How it works

- **Clone.** On start the app clones `LLM_WIKI_REPO_URL` (branch `LLM_WIKI_BRANCH`) into `$LLM_WIKI_DATA_DIR/repo`,
  using the deploy key in `LLM_WIKI_SSH_KEY_FILE`, over `ssh.github.com:443` (port 22 from the cluster intermittently timed out). GitHub's host keys are pinned in `backend/src/git.rs`.
- **Sync.** It fetches and fast-forwards every `LLM_WIKI_SYNC_SECONDS` (60) seconds and before every write. The clone
  never holds unpushed work: a failed push is reset away, and the client keeps the edit as a draft. If the remote is
  rewritten, the clone follows it.
- **Saves.** One tap. The server pulls, checks for conflicts, validates and commits locally, then answers (about a
  second). A background task, still holding the repository lock, asks the owner's Hermes agent
  (`LLM_WIKI_AI_URL`, an OpenAI-compatible endpoint; `LLM_WIKI_AI_KEY`, `LLM_WIKI_AI_MODEL`) for a `docs(<area>): …`
  subject, amends the unpushed commit with it, and pushes. A rejected push is rebased onto the remote and retried. A
  push that still fails is reset away, and the client, which keeps the draft until the push is confirmed in
  `/api/status`, offers to reopen the edit. Without Hermes, or when it is slow or answers oddly, saves keep the subject
  `docs(<area>): update <title>`. Commits are authored as `LLM_WIKI_GIT_NAME <LLM_WIKI_GIT_EMAIL>`.
- **Checkboxes** on a page are live: ticking one saves at once with the subject `docs(<area>): check "<item>"`.
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
- **Passkey sign-in** (optional) through Pocket ID: OIDC authorization code flow with PKCE at `/auth/login` →
  `/auth/callback` (`backend/src/oidc.rs`). Any member of an allowed group is the owner. It then issues the app's own
  session, which lasts 365 days and slides (renewed at most daily on use). When configured, the sign-in screen leads
  with "Sign in with passkey"; the password stays as a fallback. Pending sign-ins live in memory for 10 minutes, so a
  restart mid-sign-in only means tapping the button again. Configure with all of:

  | Variable | Meaning |
  | --- | --- |
  | `LLM_WIKI_OIDC_ISSUER` | e.g. `https://id.fruitiex.org` |
  | `LLM_WIKI_OIDC_CLIENT_ID` | e.g. `llm-wiki-web` |
  | `LLM_WIKI_OIDC_CLIENT_SECRET` | the client secret |
  | `LLM_WIKI_OIDC_ALLOWED_GROUPS` | comma-separated; empty allows anyone the provider admits |
  | `LLM_WIKI_OIDC_REDIRECT_URL` | optional; defaults to `$LLM_WIKI_ORIGIN/auth/callback` |

## Development

```sh
nix develop
npm ci
npm run dev                  # Vite on :3102, proxies /api to :3002
# in another shell, against a scratch clone (never the real wiki):
git clone --bare <your wiki repository URL> /tmp/wiki.git
LLM_WIKI_REPO_URL=/tmp/wiki.git LLM_WIKI_DATA_DIR=/tmp/llm-wiki-data \
  LLM_WIKI_SETUP_TOKEN=local-setup-token-123456 cargo run --manifest-path backend/Cargo.toml
```

Checks: `npm run typecheck`, `npm run format:check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (real
git repos: concurrent edits, push rejection and retry, rewritten remotes, validation, rename, auth). `npm run test:ui`
drives the built app in Chromium (see the header of `scripts/verify-ui.mjs`), including an agent commit landing
mid-edit, and writes screenshots to `test-results/`. With `LLM_WIKI_MOCK_OIDC_PORT` it serves a mock OpenID provider
and signs in with the passkey flow instead.

## Deployment

CI (`.github/workflows/build.yml`) tests, builds the Nix image `ghcr.io/fruitiex/llm-wiki-web`, smoke-tests it and
dispatches `image-update` to `FruitieX/homelab`, which pins the digest in `apps/llm-wiki-web/deployment.yaml`.

The deploy key (write access to the wiki repository) is stored, SOPS-encrypted, in the homelab repository's
`apps/llm-wiki-web/secret.sops.yaml` together with the setup token.
