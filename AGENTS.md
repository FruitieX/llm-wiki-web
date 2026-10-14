# llm-wiki-web project context

Read `README.md` first. Use the locked Nix environment: `nix develop --command …`. Commit and push task changes after
the relevant checks, as authorized by `/home/rasse/AGENTS.md`.

- Never point a development server at the real wiki or its `main` branch. Use a bare scratch clone as
  `LLM_WIKI_REPO_URL`.
- The clone must never keep unpushed commits; every write path ends with a successful push or a reset to the remote.
  Keep that invariant, along with the blob-hash conflict check, when you change `backend/src/repo.rs`.
- Validation runs the wiki repository's own `tools/wiki_check.js`. Don't port its rules into this app.
- Keep reading fast on a phone: CodeMirror and the editor stay in the lazily loaded `Editor` chunk.
- Take real browser screenshots (`npm run test:ui`) when changing layout or visual direction, at phone and desktop
  sizes, in both themes.
