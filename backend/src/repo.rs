//! The app's own clone of the wiki. Every read of the working tree that must
//! be consistent, and every write, happens while holding `lock`.
//!
//! A save commits locally and answers at once; a background finisher, still
//! holding the lock, lets Hermes rewrite the commit subject and pushes. Once
//! the lock is free the clone holds no unpushed work again: a failed push is
//! reset away (the client keeps the edit as a draft until the push lands).

use crate::{
    ai::Ai,
    check::{self, CheckDelta, CheckResult},
    error::ApiError,
    git::{Git, GitError},
    wiki::Snapshot,
};
use axum::http::StatusCode;
use serde::Serialize;
use serde_json::json;
use std::{
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
};

pub struct Repo {
    pub git: Git,
    pub url: String,
    pub branch: String,
    pub scratch: PathBuf,
    pub node: String,
    pub ai: Option<Ai>,
    lock: Arc<tokio::sync::Mutex<()>>,
    snapshot: RwLock<Arc<Snapshot>>,
    status: Mutex<SyncStatus>,
    baseline: tokio::sync::Mutex<Option<(String, CheckResult)>>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub head: String,
    pub branch: String,
    pub last_sync: Option<i64>,
    pub last_error: Option<String>,
    /// The most recent saves, newest last, so a client can follow its own.
    pub saves: VecDeque<SaveState>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveState {
    pub id: u64,
    pub paths: Vec<String>,
    /// `pushing`, `pushed` or `failed`.
    pub state: &'static str,
    pub subject: String,
    pub error: Option<String>,
}

/// The commit subject for a save. With `generate`, Hermes may replace it.
pub struct Message {
    pub subject: String,
    pub generate: bool,
}

/// One change to a file below `wiki/`.
#[derive(Clone, Debug)]
pub enum Op {
    Write { path: String, text: String },
    Delete { path: String },
}
impl Op {
    fn path(&self) -> &str {
        match self {
            Op::Write { path, .. } | Op::Delete { path } => path,
        }
    }
}

#[derive(Debug)]
pub enum CommitError {
    /// The file changed upstream since the client loaded `expected`.
    Conflict {
        path: String,
        blob: Option<String>,
        text: Option<String>,
    },
    Invalid(CheckDelta),
    Api(ApiError),
}
impl From<ApiError> for CommitError {
    fn from(value: ApiError) -> Self {
        CommitError::Api(value)
    }
}
impl From<GitError> for CommitError {
    fn from(value: GitError) -> Self {
        CommitError::Api(ApiError::internal(value))
    }
}
impl From<std::io::Error> for CommitError {
    fn from(value: std::io::Error) -> Self {
        CommitError::Api(ApiError::internal(value))
    }
}
impl From<CommitError> for ApiError {
    fn from(value: CommitError) -> Self {
        match value {
            CommitError::Api(error) => error,
            CommitError::Invalid(delta) => ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "The wiki checker found errors in this change.",
            )
            .with(json!({ "check": delta })),
            CommitError::Conflict { path, blob, text } => ApiError::new(
                StatusCode::CONFLICT,
                "This page changed upstream while you were editing.",
            )
            .with(json!({ "path": path, "blob": blob, "text": text })),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Committed {
    pub head: String,
    pub commit: Option<String>,
    pub warnings: Vec<String>,
    /// Follow this id in `SyncStatus::saves` until it is pushed.
    pub save: Option<u64>,
    /// The new blob of each written page, for further edits without a reload.
    pub blobs: BTreeMap<String, String>,
}

fn offline(error: GitError) -> ApiError {
    tracing::warn!("{error}");
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "Could not reach GitHub to sync the wiki. Your edit is kept here; try again shortly.",
    )
}

fn rejected(error: &GitError) -> bool {
    let text = &error.stderr;
    text.contains("[rejected]")
        || text.contains("non-fast-forward")
        || text.contains("fetch first")
        || text.contains("[remote rejected]") && text.contains("cannot lock ref")
}

impl Repo {
    pub fn new(
        git: Git,
        url: String,
        branch: String,
        scratch: PathBuf,
        node: String,
        ai: Option<Ai>,
    ) -> Self {
        Repo {
            git,
            url,
            branch,
            scratch,
            node,
            ai,
            lock: Arc::new(tokio::sync::Mutex::new(())),
            snapshot: RwLock::new(Arc::new(Snapshot::default())),
            status: Mutex::new(SyncStatus::default()),
            baseline: tokio::sync::Mutex::new(None),
        }
    }

    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.snapshot
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn status(&self) -> SyncStatus {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn remote_ref(&self) -> String {
        format!("refs/remotes/origin/{}", self.branch)
    }

    /// Clones on first start; otherwise discards any half-finished local state
    /// and catches up with the remote branch.
    pub async fn open(&self) -> Result<(), GitError> {
        let _guard = self.lock.lock().await;
        if !self.git.dir.join(".git").exists() {
            tracing::info!("Cloning {} ({})", self.url, self.branch);
            if let Err(error) = self.git.clone_from(&self.url, &self.branch).await {
                // A clone killed by the timeout leaves a partial repository
                // behind; remove it so the retry starts clean.
                let _ = tokio::fs::remove_dir_all(&self.git.dir).await;
                return Err(error);
            }
        } else {
            self.git
                .run(&["remote", "set-url", "origin", &self.url])
                .await?;
        }
        // Offline at start-up: serve the last fetched state and retry later.
        let fetched = self.fetch().await;
        if let Err(error) = &fetched {
            tracing::warn!("{error}");
        }
        let remote = self.remote_ref();
        self.git
            .run(&["checkout", "--force", "-B", &self.branch, &remote])
            .await?;
        self.git.run(&["clean", "-fdq"]).await?;
        self.reload().await?;
        self.mark_synced(fetched.err().map(|error| error.to_string()));
        Ok(())
    }

    async fn fetch(&self) -> Result<(), GitError> {
        let refspec = format!("+refs/heads/{0}:refs/remotes/origin/{0}", self.branch);
        let args = ["fetch", "--quiet", "origin", refspec.as_str()];
        // One quick retry absorbs a dropped connection.
        if let Err(error) = self.git.run(&args).await {
            tracing::info!("{error}; retrying once");
            self.git.run(&args).await?;
        }
        Ok(())
    }

    fn mark_synced(&self, error: Option<String>) {
        let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
        status.branch = self.branch.clone();
        status.head = self.snapshot().head.clone();
        if error.is_none() {
            status.last_sync = Some(chrono::Utc::now().timestamp());
        }
        status.last_error = error;
    }

    async fn reload(&self) -> Result<(), GitError> {
        let head = self.git.rev("HEAD").await?;
        if self.snapshot().head == head {
            return Ok(());
        }
        let tree = self.git.tree().await?;
        let root = self.git.dir.clone();
        let snapshot = tokio::task::spawn_blocking(move || Snapshot::load(&root, head, &tree))
            .await
            .map_err(|error| GitError {
                args: "load".into(),
                stderr: error.to_string(),
            })?
            .map_err(|error| GitError {
                args: "load".into(),
                stderr: error.to_string(),
            })?;
        *self.snapshot.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(snapshot);
        Ok(())
    }

    /// `git pull --ff-only` in effect. The clone never holds unpushed work,
    /// so the local branch simply follows the remote; when that is not a
    /// fast-forward, the remote was rewritten and the clone follows it anyway.
    async fn pull_locked(&self) -> Result<(), GitError> {
        self.fetch().await?;
        let remote = self.remote_ref();
        let (head, target) = (self.git.rev("HEAD").await?, self.git.rev(&remote).await?);
        if head != target {
            if self
                .git
                .run(&["merge-base", "--is-ancestor", "HEAD", &remote])
                .await
                .is_err()
            {
                tracing::warn!(
                    "Remote {} was rewritten; resetting the clone to it",
                    self.branch
                );
            }
            self.git
                .run(&["reset", "--hard", "--quiet", &remote])
                .await?;
        }
        self.reload().await
    }

    pub async fn pull(&self) -> Result<(), GitError> {
        let _guard = self.lock.lock().await;
        let result = self.pull_locked().await;
        self.mark_synced(result.as_ref().err().map(|error| error.to_string()));
        result
    }

    async fn baseline(&self, snapshot: &Snapshot) -> std::io::Result<CheckResult> {
        let mut cached = self.baseline.lock().await;
        if let Some((head, result)) = cached.as_ref()
            && *head == snapshot.head
        {
            return Ok(result.clone());
        }
        let result = check::run(
            &self.node,
            &self.scratch,
            &self.git.dir,
            snapshot,
            &BTreeMap::new(),
        )
        .await?;
        *cached = Some((snapshot.head.clone(), result.clone()));
        Ok(result)
    }

    /// Runs the checker on a proposed change without committing anything.
    pub async fn dry_run(&self, ops: &[Op]) -> std::io::Result<CheckDelta> {
        let snapshot = self.snapshot();
        let before = self.baseline(&snapshot).await?;
        let changes = ops
            .iter()
            .map(|op| match op {
                Op::Write { path, text } => (path.clone(), Some(text.clone())),
                Op::Delete { path } => (path.clone(), None),
            })
            .collect();
        let after = check::run(
            &self.node,
            &self.scratch,
            &self.git.dir,
            &snapshot,
            &changes,
        )
        .await?;
        let touched: Vec<String> = ops.iter().map(|op| op.path().to_string()).collect();
        Ok(check::delta(&before, &after, &touched))
    }

    /// Waits until no save is being finished (tests and shutdown).
    pub async fn settled(&self) {
        let _ = self.lock.lock().await;
    }

    fn record_save(&self, save: SaveState) {
        let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = status.saves.iter_mut().find(|s| s.id == save.id) {
            *existing = save;
            return;
        }
        status.saves.push_back(save);
        while status.saves.len() > 20 {
            status.saves.pop_front();
        }
    }

    /// Pulls, verifies that each expected path still has the blob the client
    /// started from, validates and commits locally, then returns while a
    /// background task finishes the commit subject and pushes.
    /// `build` turns the freshly pulled snapshot into the change and the blob
    /// each path must still have (`None`: must not exist).
    pub async fn commit<F>(
        self: &Arc<Self>,
        message: Message,
        build: F,
    ) -> Result<Committed, CommitError>
    where
        F: FnOnce(&Snapshot) -> Result<(Vec<Op>, Vec<(String, Option<String>)>), CommitError>,
    {
        let guard = self.lock.clone().lock_owned().await;
        let started = std::time::Instant::now();
        if let Err(error) = self.pull_locked().await {
            self.mark_synced(Some(error.to_string()));
            return Err(offline(error).into());
        }
        self.mark_synced(None);
        let pulled = started.elapsed();
        let snapshot = self.snapshot();
        let (ops, expected) = build(&snapshot)?;
        for (path, blob) in &expected {
            let current = snapshot.page_by_path(path);
            if current.map(|page| &page.blob) != blob.as_ref() {
                return Err(CommitError::Conflict {
                    path: path.clone(),
                    blob: current.map(|page| page.blob.clone()),
                    text: current.map(|page| page.text.clone()),
                });
            }
        }
        let delta = self.dry_run(&ops).await?;
        if !delta.errors.is_empty() {
            return Err(CommitError::Invalid(delta));
        }
        for op in &ops {
            let file = self.git.dir.join(op.path());
            match op {
                Op::Write { text, .. } => {
                    if let Some(parent) = file.parent() {
                        tokio::fs::create_dir_all(parent).await?;
                    }
                    tokio::fs::write(&file, text).await?;
                }
                Op::Delete { .. } => {
                    if file.exists() {
                        tokio::fs::remove_file(&file).await?;
                    }
                }
            }
        }
        self.git.run(&["add", "-A", "--", "wiki"]).await?;
        if self.git.run(&["diff", "--cached", "--quiet"]).await.is_ok() {
            return Ok(Committed {
                head: snapshot.head.clone(),
                commit: None,
                warnings: delta.warnings,
                save: None,
                blobs: BTreeMap::new(),
            });
        }
        let subject = format!("{}\n", message.subject.trim());
        self.git
            .run_with_input(&["commit", "--quiet", "-F", "-"], subject.as_bytes())
            .await?;
        self.reload().await?;
        let snapshot = self.snapshot();
        let blobs = ops
            .iter()
            .filter_map(|op| match op {
                Op::Write { path, .. } => snapshot
                    .page_by_path(path)
                    .map(|page| (path.clone(), page.blob.clone())),
                Op::Delete { .. } => None,
            })
            .collect();
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let paths: Vec<String> = ops.iter().map(|op| op.path().to_string()).collect();
        self.record_save(SaveState {
            id,
            paths: paths.clone(),
            state: "pushing",
            subject: message.subject.trim().to_string(),
            error: None,
        });
        tracing::info!(
            "Committed save {id} locally in {} ms (pull {} ms)",
            started.elapsed().as_millis(),
            pulled.as_millis()
        );
        let repo = self.clone();
        tokio::spawn(async move {
            repo.finish(guard, id, paths, ops, message.subject, message.generate)
                .await
        });
        Ok(Committed {
            commit: Some(snapshot.head.clone()),
            head: snapshot.head.clone(),
            warnings: delta.warnings,
            save: Some(id),
            blobs,
        })
    }

    /// Runs with the repository lock still held: improve the subject, push,
    /// and leave the clone equal to the remote whatever happens.
    async fn finish(
        self: Arc<Self>,
        _guard: tokio::sync::OwnedMutexGuard<()>,
        id: u64,
        paths: Vec<String>,
        ops: Vec<Op>,
        mut subject: String,
        generate: bool,
    ) {
        let started = std::time::Instant::now();
        if generate && let Some(ai) = &self.ai {
            let area = paths
                .first()
                .and_then(|path| path.rsplit('/').next())
                .and_then(|name| name.strip_suffix(".md"))
                .map(|name| if name == "index" { "wiki" } else { name })
                .unwrap_or("wiki")
                .to_string();
            let diff = self
                .git
                .run(&["show", "--format=", "--unified=2", "HEAD"])
                .await
                .unwrap_or_default();
            let examples: Vec<String> = self
                .git
                .run(&["log", "-12", "--format=%s", "HEAD~1"])
                .await
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect();
            if let Some(better) = ai.commit_subject(&area, &diff, &examples).await {
                let input = format!("{better}\n");
                match self
                    .git
                    .run_with_input(
                        &["commit", "--amend", "--quiet", "-F", "-"],
                        input.as_bytes(),
                    )
                    .await
                {
                    Ok(_) => subject = better,
                    Err(error) => tracing::warn!("{error}"),
                }
            }
        }
        let result = self.push_with_retry(&ops).await;
        let error = match &result {
            Ok(()) => None,
            Err(CommitError::Conflict { .. }) => Some(
                "The page changed upstream at the same time. Open the editor to merge your edit."
                    .to_string(),
            ),
            Err(_) => Some(
                "Could not push to GitHub. Your edit is kept on this device; save it again."
                    .to_string(),
            ),
        };
        if result.is_err() {
            let remote = self.remote_ref();
            let _ = self.git.run(&["rebase", "--abort"]).await;
            let _ = self.git.run(&["reset", "--hard", "--quiet", &remote]).await;
        }
        if let Err(error) = self.reload().await {
            tracing::error!("{error}");
        }
        self.mark_synced(None);
        tracing::info!(
            "Save {id} {} in {} ms: {subject}",
            if error.is_none() { "pushed" } else { "failed" },
            started.elapsed().as_millis()
        );
        self.record_save(SaveState {
            id,
            paths,
            state: if error.is_none() { "pushed" } else { "failed" },
            subject,
            error,
        });
    }

    async fn push_with_retry(&self, ops: &[Op]) -> Result<(), CommitError> {
        let target = format!("HEAD:refs/heads/{}", self.branch);
        for attempt in 1..=4 {
            let error = match self.git.run(&["push", "--quiet", "origin", &target]).await {
                Ok(_) => {
                    // Keep the remote-tracking ref in step without another fetch.
                    let remote = self.remote_ref();
                    self.git.run(&["update-ref", &remote, "HEAD"]).await?;
                    return Ok(());
                }
                Err(error) => error,
            };
            if !rejected(&error) || attempt == 4 {
                return Err(offline(error).into());
            }
            tracing::info!("Push rejected (attempt {attempt}); rebasing onto the remote");
            self.fetch().await.map_err(offline)?;
            let remote = self.remote_ref();
            if self.git.run(&["rebase", "--quiet", &remote]).await.is_err() {
                let _ = self.git.run(&["rebase", "--abort"]).await;
                // Report the first touched file with its new upstream version.
                let path = ops
                    .first()
                    .map(|op| op.path().to_string())
                    .unwrap_or_default();
                let text = self.git.show(&remote, &path).await?;
                let blob = match &text {
                    Some(_) => Some(self.git.rev(&format!("{remote}:{path}")).await?),
                    None => None,
                };
                return Err(CommitError::Conflict { path, blob, text });
            }
        }
        unreachable!()
    }
}
