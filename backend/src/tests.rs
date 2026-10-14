//! End-to-end tests against real git repositories: a bare "GitHub" remote,
//! the app's clone, and a second clone standing in for an agent.

use crate::{
    AppState, app, auth,
    git::Git,
    repo::{CommitError, Message, Op, Repo},
};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::{path::Path, process::Command, sync::Arc};
use tower::ServiceExt;

const CHECKER: &str = r#"const fs = require('fs'), path = require('path');
const wiki = path.join(__dirname, '..', 'wiki');
const pages = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const f = path.join(d, e.name);
  return e.isDirectory() ? pages(f) : e.name.endsWith('.md') ? [f] : [];
});
const files = pages(wiki);
const keys = new Set(files.map(f => path.relative(wiki, f).slice(0, -3)));
let errors = 0, warnings = 0;
for (const f of files) {
  const rel = path.relative(wiki, f), t = fs.readFileSync(f, 'utf8');
  if (!t.startsWith('---\n')) { console.log(`ERROR ${rel}: missing frontmatter`); errors++; }
  for (const m of t.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g))
    if (!keys.has(m[1].trim())) { console.log(`ERROR ${rel}: broken wiki link [[${m[1].trim()}]]`); errors++; }
  if (t.length > 2000) { console.log(`WARN  large page: ${rel}`); warnings++; }
}
console.log(`Checked ${files.length} pages: ${errors} error(s), ${warnings} warning(s)`);
process.exitCode = errors ? 1 : 0;
"#;

fn page(title: &str, body: &str) -> String {
    format!("---\ntype: entity\nstatus: active\nupdated: 2026-10-14\n---\n\n# {title}\n\n{body}\n")
}

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "user.name=Agent",
            "-c",
            "user.email=agent@example.org",
        ])
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn write(dir: &Path, path: &str, text: &str) {
    let file = dir.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

struct Fixture {
    _temp: tempfile::TempDir,
    remote: std::path::PathBuf,
    agent: std::path::PathBuf,
    repo: Arc<Repo>,
}

impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let remote = temp.path().join("remote.git");
        let seed = temp.path().join("seed");
        std::fs::create_dir_all(&seed).unwrap();
        sh(
            temp.path(),
            &[
                "init",
                "--quiet",
                "--bare",
                "-b",
                "main",
                remote.to_str().unwrap(),
            ],
        );
        sh(
            temp.path(),
            &["init", "--quiet", "-b", "main", seed.to_str().unwrap()],
        );
        write(&seed, "tools/wiki_check.js", CHECKER);
        write(
            &seed,
            "wiki/index.md",
            &page(
                "Wiki index",
                "## Entities\n\n- [[entities/alpha]] — Alpha.\n- [[entities/beta]] — Beta.",
            ),
        );
        write(
            &seed,
            "wiki/entities/alpha.md",
            &page(
                "Alpha",
                "Alpha links to [[entities/beta]].\n\nSecond paragraph.\n\nThird paragraph.",
            ),
        );
        write(
            &seed,
            "wiki/entities/beta.md",
            &page("Beta", "Beta links to [[entities/alpha|the first]]."),
        );
        write(
            &seed,
            "raw/sources/evidence-2026-10-14.md",
            "captured output\n",
        );
        write(
            &seed,
            "templates/entity.md",
            &page("Entity name", "One paragraph."),
        );
        sh(&seed, &["add", "-A"]);
        sh(&seed, &["commit", "--quiet", "-m", "init"]);
        sh(
            &seed,
            &["push", "--quiet", remote.to_str().unwrap(), "main"],
        );
        let agent = temp.path().join("agent");
        sh(
            temp.path(),
            &[
                "clone",
                "--quiet",
                remote.to_str().unwrap(),
                agent.to_str().unwrap(),
            ],
        );
        let scratch = temp.path().join("scratch");
        std::fs::create_dir_all(&scratch).unwrap();
        let git = Git {
            dir: temp.path().join("data/repo"),
            ssh_command: None,
            author_name: "Owner".into(),
            author_email: "owner@example.org".into(),
        };
        std::fs::create_dir_all(temp.path().join("data")).unwrap();
        let repo = Arc::new(Repo::new(
            git,
            remote.to_string_lossy().into(),
            "main".into(),
            scratch,
            "node".into(),
            None,
        ));
        repo.open().await.unwrap();
        Fixture {
            _temp: temp,
            remote,
            agent,
            repo,
        }
    }

    /// An agent commits and pushes a change straight to the remote.
    fn agent_commit(&self, path: &str, text: &str, message: &str) {
        sh(&self.agent, &["pull", "--quiet", "--ff-only"]);
        write(&self.agent, path, text);
        sh(&self.agent, &["add", "-A"]);
        sh(&self.agent, &["commit", "--quiet", "-m", message]);
        sh(&self.agent, &["push", "--quiet"]);
    }

    fn remote_file(&self, path: &str) -> String {
        sh(&self.remote, &["show", &format!("main:{path}")])
    }

    fn blob(&self, key: &str) -> String {
        self.repo.snapshot().pages[key].blob.clone()
    }

    async fn save(
        &self,
        key: &str,
        text: &str,
        base: &str,
    ) -> Result<crate::repo::Committed, CommitError> {
        let path = format!("wiki/{key}.md");
        let (text, base) = (text.to_string(), base.to_string());
        let message = Message {
            subject: "docs(test): edit".into(),
            generate: false,
        };
        let result = self
            .repo
            .commit(message, move |_| {
                Ok((
                    vec![Op::Write {
                        path: path.clone(),
                        text,
                    }],
                    vec![(path, Some(base))],
                ))
            })
            .await;
        // Saves push in the background; wait for that before inspecting.
        self.repo.settled().await;
        result
    }
}

#[tokio::test]
async fn saves_commit_as_the_owner_and_push() {
    let f = Fixture::new().await;
    let base = f.blob("entities/alpha");
    let text = page("Alpha", "Edited by the owner. [[entities/beta]]");
    let done = f.save("entities/alpha", &text, &base).await.unwrap();
    assert!(done.commit.is_some());
    assert_eq!(f.remote_file("wiki/entities/alpha.md"), text);
    let log = sh(&f.remote, &["log", "-1", "--format=%an <%ae>|%s", "main"]);
    assert_eq!(log.trim(), "Owner <owner@example.org>|docs(test): edit");
    assert_ne!(f.blob("entities/alpha"), base);
}

#[tokio::test]
async fn pulls_agent_commits_before_writing() {
    let f = Fixture::new().await;
    f.agent_commit(
        "wiki/entities/beta.md",
        &page("Beta", "Agent rewrote beta. [[entities/alpha]]"),
        "docs(beta): agent",
    );
    // Editing a different page does not conflict, and keeps the agent's work.
    let base = f.blob("entities/alpha");
    f.save(
        "entities/alpha",
        &page("Alpha", "Owner edit. [[entities/beta]]"),
        &base,
    )
    .await
    .unwrap();
    assert!(
        f.remote_file("wiki/entities/beta.md")
            .contains("Agent rewrote beta")
    );
    assert!(
        f.remote_file("wiki/entities/alpha.md")
            .contains("Owner edit")
    );
}

#[tokio::test]
async fn reports_a_failed_push_and_keeps_the_clone_clean() {
    let f = Fixture::new().await;
    let hook = f.repo.git.dir.join(".git/hooks/pre-push");
    std::fs::write(&hook, "#!/bin/sh\necho 'remote: offline' >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let start = sh(&f.remote, &["rev-parse", "main"]);
    let base = f.blob("entities/alpha");
    let done = f
        .save(
            "entities/alpha",
            &page("Alpha", "Lost? [[entities/beta]]"),
            &base,
        )
        .await
        .unwrap();
    let save = f
        .repo
        .status()
        .saves
        .into_iter()
        .find(|s| Some(s.id) == done.save)
        .unwrap();
    assert_eq!(save.state, "failed");
    assert!(save.error.is_some());
    // The local commit was reset away; the clone mirrors the remote again.
    assert_eq!(f.repo.git.rev("HEAD").await.unwrap(), start.trim());
    assert_eq!(f.blob("entities/alpha"), base);
}

#[tokio::test]
async fn follows_a_rewritten_remote() {
    let f = Fixture::new().await;
    let start = sh(&f.remote, &["rev-parse", "main"]);
    let base = f.blob("entities/alpha");
    f.save(
        "entities/alpha",
        &page("Alpha", "Owner edit. [[entities/beta]]"),
        &base,
    )
    .await
    .unwrap();
    // Someone force-pushes main back to the first commit.
    sh(&f.remote, &["update-ref", "refs/heads/main", start.trim()]);
    f.repo.pull().await.unwrap();
    assert_eq!(f.repo.git.rev("HEAD").await.unwrap(), start.trim());
    assert_eq!(f.blob("entities/alpha"), base);
}

#[tokio::test]
async fn detects_an_upstream_change_to_the_edited_page() {
    let f = Fixture::new().await;
    let base = f.blob("entities/alpha");
    let upstream = page(
        "Alpha",
        "Alpha links to [[entities/beta]].\n\nSecond paragraph.\n\nThird paragraph, extended by an agent.",
    );
    f.agent_commit("wiki/entities/alpha.md", &upstream, "docs(alpha): agent");
    let mine = page(
        "Alpha",
        "Alpha links to [[entities/beta]] (owner).\n\nSecond paragraph.\n\nThird paragraph.",
    );
    match f.save("entities/alpha", &mine, &base).await {
        Err(CommitError::Conflict { path, text, blob }) => {
            assert_eq!(path, "wiki/entities/alpha.md");
            assert_eq!(text.as_deref(), Some(upstream.as_str()));
            assert!(blob.is_some());
        }
        other => panic!("expected a conflict, got {other:?}"),
    }
    // Nothing was overwritten.
    assert_eq!(f.remote_file("wiki/entities/alpha.md"), upstream);
    // The two edits touch different lines, so a three-way merge is clean.
    let base_text = f.repo.git.blob(&base).await.unwrap();
    let (merged, conflicts) = f
        .repo
        .git
        .merge_texts(&f.repo.scratch, &mine, &base_text, &upstream)
        .await
        .unwrap();
    assert!(!conflicts);
    assert!(merged.contains("(owner)") && merged.contains("extended by an agent"));
}

#[tokio::test]
async fn rebases_and_retries_when_the_push_is_rejected() {
    let f = Fixture::new().await;
    // A pre-push hook lands an agent commit after the app's pull, exactly once,
    // so the first push is rejected as non-fast-forward.
    let hook = f.repo.git.dir.join(".git/hooks/pre-push");
    let marker = f.agent.join("raced");
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\n[ -e '{marker}' ] && exit 0\ntouch '{marker}'\ncd '{agent}' && unset GIT_DIR GIT_INDEX_FILE && git pull -q --ff-only && printf '%s\\n' '{text}' > wiki/entities/beta.md && git add -A && git -c user.name=Agent -c user.email=a@b commit -qm 'docs(beta): race' && git push -q\n",
            marker = marker.display(),
            agent = f.agent.display(),
            text = page("Beta", "Raced in. [[entities/alpha]]").replace('\n', "\\n"),
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let base = f.blob("entities/alpha");
    f.save(
        "entities/alpha",
        &page("Alpha", "After the race. [[entities/beta]]"),
        &base,
    )
    .await
    .unwrap();
    assert!(marker.exists(), "the race hook ran");
    assert!(
        f.remote_file("wiki/entities/alpha.md")
            .contains("After the race")
    );
    assert!(f.remote_file("wiki/entities/beta.md").contains("Raced in"));
    let subjects = sh(&f.remote, &["log", "--format=%s", "-3", "main"]);
    assert_eq!(
        subjects.lines().collect::<Vec<_>>(),
        ["docs(test): edit", "docs(beta): race", "init"]
    );
    let local = f.repo.git.rev("HEAD").await.unwrap();
    assert_eq!(local, sh(&f.remote, &["rev-parse", "main"]).trim());
}

#[tokio::test]
async fn blocks_new_checker_errors_but_not_existing_ones() {
    let f = Fixture::new().await;
    let base = f.blob("entities/alpha");
    match f
        .save(
            "entities/alpha",
            &page("Alpha", "Now links to [[entities/missing]]."),
            &base,
        )
        .await
    {
        Err(CommitError::Invalid(delta)) => {
            assert_eq!(
                delta.errors,
                ["entities/alpha.md: broken wiki link [[entities/missing]]"]
            );
        }
        other => panic!("expected invalid, got {other:?}"),
    }
    // An agent leaves a broken link elsewhere; the owner can still save.
    f.agent_commit(
        "wiki/entities/beta.md",
        &page("Beta", "[[entities/gone]] [[entities/alpha]]"),
        "docs(beta): broken",
    );
    let done = f
        .save(
            "entities/alpha",
            &page("Alpha", "Fine. [[entities/beta]]"),
            &base,
        )
        .await
        .unwrap();
    assert!(done.commit.is_some());
    // Warnings about the edited page are reported but never block.
    let delta = f
        .repo
        .dry_run(&[Op::Write {
            path: "wiki/entities/alpha.md".into(),
            text: page("Alpha", &"long text [[entities/beta]] ".repeat(100)),
        }])
        .await
        .unwrap();
    assert!(delta.errors.is_empty());
    assert_eq!(delta.warnings, ["large page: entities/alpha.md"]);
    assert_eq!(delta.existing_errors.len(), 1);
}

async fn call(
    router: &axum::Router,
    method: &str,
    uri: &str,
    cookie: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value, Option<String>) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("x-llm-wiki", "1");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    let request = match body {
        Some(body) => request
            .header("content-type", "application/json")
            .body(Body::from(body.to_string())),
        None => request.body(Body::empty()),
    }
    .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let set_cookie = response
        .headers()
        .get("set-cookie")
        .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        set_cookie,
    )
}

#[tokio::test]
async fn api_requires_sign_in_and_handles_page_lifecycle() {
    let f = Fixture::new().await;
    let auth_file = f.repo.scratch.join("auth.json");
    let state = AppState {
        repo: f.repo.clone(),
        auth: Arc::new(
            auth::Auth::load(auth_file, Some("setup-token-0123456789".into()), false).unwrap(),
        ),
        origin: Some("https://wiki.example.org".into()),
    };
    let router = app(state, None);
    let (status, _, _) = call(&router, "GET", "/api/wiki", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = call(
        &router,
        "POST",
        "/api/auth/setup",
        None,
        Some(json!({"token": "wrong-token-000000", "password": "correct horse battery"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, cookie) = call(
        &router,
        "POST",
        "/api/auth/setup",
        None,
        Some(json!({"token": "setup-token-0123456789", "password": "correct horse battery"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let cookie = cookie.unwrap();
    let (status, body, _) = call(&router, "GET", "/api/auth/status", Some(&cookie), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["signedIn"], true);
    // Logging in again works with the password.
    let (status, _, login_cookie) = call(
        &router,
        "POST",
        "/api/auth/login",
        None,
        Some(json!({"password": "correct horse battery"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(login_cookie.is_some());

    let (status, body, _) = call(
        &router,
        "GET",
        "/api/page?key=entities/beta",
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["backlinks"][0]["key"], "entities/alpha");
    assert_eq!(body["front"]["type"], "entity");

    // Create a page from a template; it gets an index entry.
    let (status, body, _) = call(
        &router,
        "POST",
        "/api/page",
        Some(&cookie),
        Some(json!({
            "key": "entities/gamma", "text": page("Gamma", "See [[entities/alpha]]."),
            "section": "Entities", "description": "Gamma.", "message": "docs(gamma): add page"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    f.repo.settled().await;
    assert!(
        f.remote_file("wiki/index.md")
            .contains("- [[entities/beta]] — Beta.\n- [[entities/gamma]] — Gamma.\n")
    );

    // Rename alpha; every link to it is rewritten, labels kept.
    let base = f.blob("entities/alpha");
    let (status, body, _) = call(&router, "POST", "/api/page/move", Some(&cookie), Some(json!({
        "from": "entities/alpha", "to": "concepts/alpha", "baseBlob": base, "message": "docs(alpha): move to concepts"
    }))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    f.repo.settled().await;
    assert!(
        f.remote_file("wiki/entities/beta.md")
            .contains("[[concepts/alpha|the first]]")
    );
    assert!(
        f.remote_file("wiki/entities/gamma.md")
            .contains("[[concepts/alpha]]")
    );
    assert!(
        f.remote_file("wiki/index.md")
            .contains("[[concepts/alpha]]")
    );
    assert!(
        f.remote_file("wiki/concepts/alpha.md")
            .contains("[[entities/beta]]")
    );

    // History follows the rename.
    let (status, body, _) = call(
        &router,
        "GET",
        "/api/history?path=wiki/concepts/alpha.md",
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["commits"].as_array().unwrap().len(), 2);

    // A stale save gets a 409 with a merge proposal.
    let stale = f.blob("entities/beta");
    f.agent_commit(
        "wiki/entities/beta.md",
        &page(
            "Beta",
            "Beta links to [[concepts/alpha|the first]].\n\nAgent addition.",
        ),
        "docs(beta): agent",
    );
    let (status, body, _) = call(
        &router,
        "PUT",
        "/api/page",
        Some(&cookie),
        Some(json!({
            "key": "entities/beta", "baseBlob": stale, "message": "docs(beta): owner",
            "text": page("Beta (owner)", "Beta links to [[concepts/alpha|the first]]."),
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["details"]["mergedConflicts"], false);
    let merged = body["details"]["merged"].as_str().unwrap();
    assert!(merged.contains("# Beta (owner)") && merged.contains("Agent addition."));

    // Cross-origin writes are refused.
    let request = Request::builder()
        .method("POST")
        .uri("/api/sync")
        .header("x-llm-wiki", "1")
        .header("origin", "https://evil.example")
        .header("cookie", &cookie)
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        router.clone().oneshot(request).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );

    // Search finds titles and bodies.
    let (_, body, _) = call(
        &router,
        "GET",
        "/api/search?q=agent%20addition",
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(body["hits"][0]["key"], "entities/beta");
}
