# How it works

llm-wiki-web has no database. The Git repository is the storage, and every
write ends in a push or is thrown away.

## Clone and sync

On start the app clones `LLM_WIKI_REPO_URL` (branch `LLM_WIKI_BRANCH`) into
`$LLM_WIKI_DATA_DIR/repo`. With `LLM_WIKI_SSH_KEY_FILE` set it uses that deploy
key and talks to GitHub over `ssh.github.com:443`, because outbound port 22
from a cluster can be unreliable. GitHub's host keys are pinned in
`backend/src/git.rs`.

It fetches and fast-forwards every `LLM_WIKI_SYNC_SECONDS` (60) seconds and
before every write. The clone never holds unpushed work: a failed push is reset
away and the browser keeps the edit as a draft. If the remote is rewritten, the
clone follows it.

## Saving

A save pulls, checks for conflicts, validates and commits locally, then
answers, which takes about a second. A background task, still holding the
repository lock, then pushes:

1. If `LLM_WIKI_AI_URL` points at an OpenAI-compatible endpoint
   (`LLM_WIKI_AI_KEY`, `LLM_WIKI_AI_MODEL`), it asks for a
   `docs(<area>): …` subject and amends the commit with it. Without one, or
   when it is slow or answers oddly, the subject stays
   `docs(<area>): update <title>`.
2. A rejected push is rebased onto the remote and retried.
3. A push that still fails is reset away. The browser keeps the draft until
   `/api/status` confirms the push, so it can offer to reopen the edit.

Commits are authored as `LLM_WIKI_GIT_NAME <LLM_WIKI_GIT_EMAIL>`.

Checkboxes on a page are live: ticking one saves at once with the subject
`docs(<area>): check "<item>"`.

## Concurrent edits

The editor remembers the blob it started from. If the page changed upstream,
the save returns 409 with the upstream text and a `git merge-file` three-way
merge. You review it in a CodeMirror merge view, accept or reject each chunk,
and save again. Nothing is overwritten silently.

## Validation

Saves run the wiki's own `tools/wiki_check.js` (with Node) on a scratch copy of
the wiki with the change applied. Errors the change introduces block the save.
Errors already present elsewhere, and all warnings, are shown but don't block.
The rules therefore always match the wiki repository, and the app doesn't need
to know them.

## Renames and new pages

A rename rewrites every `[[link]]` to the page, keeping anchors and labels, in
the same commit. New pages start from the repository's `templates/` and can add
their line to `wiki/index.md`.

## Sign-in

There is one owner. The password (argon2) is set on first visit using
`LLM_WIKI_SETUP_TOKEN` and stored in `auth.json` on the data volume. Sessions
are 90-day HttpOnly cookies. Writes need the `x-llm-wiki: 1` header and, when
`LLM_WIKI_ORIGIN` is set, a matching origin.

Passkey sign-in through an OpenID Connect provider is optional: authorization
code flow with PKCE at `/auth/login` → `/auth/callback` (`backend/src/oidc.rs`).
Any member of an allowed group counts as the owner. It then issues the app's own
session, which lasts 365 days and is renewed at most daily on use. When it's
configured, the sign-in screen leads with "Sign in with passkey" and keeps the
password as a fallback. Pending sign-ins live in memory for 10 minutes, so a
restart mid-sign-in only means tapping the button again.

| Variable                       | Meaning                                                  |
| ------------------------------ | -------------------------------------------------------- |
| `LLM_WIKI_OIDC_ISSUER`         | e.g. `https://id.example.com`                            |
| `LLM_WIKI_OIDC_CLIENT_ID`      | e.g. `llm-wiki-web`                                      |
| `LLM_WIKI_OIDC_CLIENT_SECRET`  | the client secret                                        |
| `LLM_WIKI_OIDC_ALLOWED_GROUPS` | comma-separated; empty allows anyone the provider admits |
| `LLM_WIKI_OIDC_REDIRECT_URL`   | optional; defaults to `$LLM_WIKI_ORIGIN/auth/callback`   |
