use crate::{
    AppState,
    error::{ApiError, Result},
    repo::{CommitError, Committed, Message, Op},
    wiki::{self, Page, Snapshot},
};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::LazyLock;

fn page_path(key: &str) -> String {
    format!("wiki/{key}.md")
}

fn checked_key(key: &str) -> Result<String> {
    let key = wiki::normalize(key);
    if wiki::valid_key(&key) {
        Ok(key)
    } else {
        Err(ApiError::bad(
            "Page paths use lowercase kebab-case folders and names, like entities/home-network.",
        ))
    }
}

/// The commit subject: the client's when given, otherwise `fallback`, which
/// Hermes may then improve in the background.
fn message(given: Option<&str>, fallback: String) -> Result<Message> {
    let Some(given) = given.map(str::trim).filter(|m| !m.is_empty()) else {
        return Ok(Message {
            subject: fallback,
            generate: true,
        });
    };
    let subject = given.lines().next().unwrap_or("");
    if subject.chars().count() > 120 || given.len() > 4000 {
        return Err(ApiError::bad(
            "Keep the commit subject under 120 characters.",
        ));
    }
    Ok(Message {
        subject: given.to_string(),
        generate: false,
    })
}

/// `docs(<area>)` uses the page's file name, as the wiki's history does.
fn area(key: &str) -> &str {
    match key.rsplit('/').next().unwrap_or(key) {
        "index" => "wiki",
        name => name,
    }
}

fn title_of(text: &str, key: &str) -> String {
    let (_, body) = wiki::split_frontmatter(text);
    body.lines()
        .find_map(|line| line.trim().strip_prefix("# "))
        .map(|title| title.trim().to_string())
        .unwrap_or_else(|| key.to_string())
}

fn checked_rev(rev: &str) -> Result<&str> {
    static REV: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^[0-9a-f]{7,40}$").unwrap());
    if REV.is_match(rev) {
        Ok(rev)
    } else {
        Err(ApiError::bad("Unknown revision."))
    }
}

fn checked_repo_path(path: &str) -> Result<&str> {
    if path.is_empty()
        || path.starts_with(['-', '/'])
        || path.split('/').any(|part| part == ".." || part.is_empty())
        || !(path.starts_with("wiki/") || path.starts_with("raw/"))
    {
        return Err(ApiError::bad("Unknown file."));
    }
    Ok(path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageSummary<'a> {
    #[serde(flatten)]
    page: &'a Page,
    backlinks: usize,
}

pub async fn wiki(State(state): State<AppState>) -> Json<Value> {
    let snapshot = state.repo.snapshot();
    let pages: Vec<PageSummary> = snapshot
        .pages
        .values()
        .map(|page| PageSummary {
            page,
            backlinks: snapshot.backlinks.get(&page.key).map_or(0, Vec::len),
        })
        .collect();
    let sections = snapshot
        .pages
        .get("index")
        .map(|index| wiki::index_sections(&index.text))
        .unwrap_or_default();
    Json(json!({
        "head": snapshot.head,
        "pages": pages,
        "raw": snapshot.raw.values().collect::<Vec<_>>(),
        "templates": snapshot.templates,
        "sections": sections,
        "status": state.repo.status(),
    }))
}

#[derive(Deserialize)]
pub struct KeyQuery {
    key: String,
}

fn page_json(snapshot: &Snapshot, page: &Page) -> Value {
    let backlinks: Vec<Value> = snapshot
        .backlinks
        .get(&page.key)
        .into_iter()
        .flatten()
        .filter_map(|key| snapshot.pages.get(key))
        .map(|source| json!({ "key": source.key, "title": source.title, "front": source.front }))
        .collect();
    let mut broken: Vec<&String> = page
        .links
        .iter()
        .filter(|target| !snapshot.pages.contains_key(*target))
        .collect();
    broken.dedup();
    let missing_raw: Vec<&String> = page
        .raw_citations
        .iter()
        .filter(|path| !snapshot.raw.contains_key(*path))
        .collect();
    json!({
        "key": page.key,
        "path": page.path,
        "blob": page.blob,
        "title": page.title,
        "front": page.front,
        "text": page.text,
        "backlinks": backlinks,
        "brokenLinks": broken,
        "missingRaw": missing_raw,
        "head": snapshot.head,
    })
}

pub async fn page(
    State(state): State<AppState>,
    Query(query): Query<KeyQuery>,
) -> Result<Json<Value>> {
    let snapshot = state.repo.snapshot();
    let key = wiki::normalize(&query.key);
    let page = snapshot
        .pages
        .get(&key)
        .ok_or_else(|| ApiError::not_found("There is no page at that path."))?;
    Ok(Json(page_json(&snapshot, page)))
}

#[derive(Deserialize)]
pub struct PathQuery {
    path: String,
}

pub async fn raw(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<Value>> {
    let snapshot = state.repo.snapshot();
    let file = snapshot
        .raw
        .get(&query.path)
        .ok_or_else(|| ApiError::not_found("There is no raw file at that path."))?;
    let text = match &file.text {
        Some(text) => Some(text.clone()),
        None if file.size <= 4 * 1024 * 1024 => state.repo.git.blob(&file.blob).await.ok(),
        None => None,
    };
    let citing: Vec<Value> = snapshot
        .pages
        .values()
        .filter(|page| page.raw_citations.contains(&file.path))
        .map(|page| json!({ "key": page.key, "title": page.title, "front": page.front }))
        .collect();
    Ok(Json(json!({
        "path": file.path, "size": file.size, "blob": file.blob,
        "text": text, "citedBy": citing,
    })))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
    limit: Option<usize>,
}
pub async fn search(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> Json<Value> {
    let snapshot = state.repo.snapshot();
    let hits = wiki::search(&snapshot, &query.q, query.limit.unwrap_or(30).min(100));
    Json(json!({ "hits": hits }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    hash: String,
    author: String,
    date: String,
    subject: String,
    files: Vec<FileChange>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    status: String,
    path: String,
    previous_path: Option<String>,
}

fn parse_log(output: &str) -> Vec<LogEntry> {
    output
        .split('\x1e')
        .filter(|record| !record.trim().is_empty())
        .filter_map(|record| {
            let mut lines = record.lines();
            let header = lines.next()?;
            let mut fields = header.split('\x1f');
            let (hash, author, date, subject) = (
                fields.next()?,
                fields.next()?,
                fields.next()?,
                fields.next().unwrap_or(""),
            );
            let files = lines
                .filter(|line| !line.trim().is_empty())
                .filter_map(|line| {
                    let parts: Vec<&str> = line.split('\t').collect();
                    let status = parts.first()?.chars().next()?.to_string();
                    let (previous_path, path) = match parts.as_slice() {
                        [_, from, to] => (Some(from.to_string()), to.to_string()),
                        [_, path] => (None, path.to_string()),
                        _ => return None,
                    };
                    Some(FileChange {
                        status,
                        path,
                        previous_path,
                    })
                })
                .collect();
            Some(LogEntry {
                hash: hash.into(),
                author: author.into(),
                date: date.into(),
                subject: subject.into(),
                files,
            })
        })
        .collect()
}

const LOG_FORMAT: &str = "--format=%x1e%H%x1f%an%x1f%aI%x1f%s";

#[derive(Deserialize)]
pub struct LimitQuery {
    limit: Option<usize>,
}
pub async fn recent(
    State(state): State<AppState>,
    Query(query): Query<LimitQuery>,
) -> Result<Json<Value>> {
    let limit = query.limit.unwrap_or(30).clamp(1, 200).to_string();
    let output = state
        .repo
        .git
        .run(&[
            "log",
            "-n",
            &limit,
            "-M",
            LOG_FORMAT,
            "--name-status",
            "HEAD",
            "--",
            "wiki",
            "raw",
        ])
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "commits": parse_log(&output) })))
}

pub async fn history(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<Value>> {
    let path = checked_repo_path(&query.path)?;
    let output = state
        .repo
        .git
        .run(&[
            "log",
            "-n",
            "200",
            "--follow",
            "-M",
            LOG_FORMAT,
            "--name-status",
            "HEAD",
            "--",
            path,
        ])
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "commits": parse_log(&output) })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffQuery {
    rev: String,
    path: String,
    previous_path: Option<String>,
}
/// The file before and after one commit, for the client to diff.
pub async fn diff(
    State(state): State<AppState>,
    Query(query): Query<DiffQuery>,
) -> Result<Json<Value>> {
    let rev = checked_rev(&query.rev)?;
    let path = checked_repo_path(&query.path)?;
    let previous = match &query.previous_path {
        Some(previous) => checked_repo_path(previous)?,
        None => path,
    };
    let git = &state.repo.git;
    let after = git.show(rev, path).await.map_err(ApiError::internal)?;
    let before = git
        .show(&format!("{rev}^"), previous)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "before": before, "after": after })))
}

#[derive(Deserialize)]
pub struct Change {
    key: String,
    text: Option<String>,
}
#[derive(Deserialize)]
pub struct CheckRequest {
    changes: Vec<Change>,
}
pub async fn check(
    State(state): State<AppState>,
    Json(body): Json<CheckRequest>,
) -> Result<Json<Value>> {
    let ops = body
        .changes
        .into_iter()
        .take(50)
        .map(|change| {
            let path = page_path(&checked_key(&change.key)?);
            Ok(match change.text {
                Some(text) => Op::Write { path, text },
                None => Op::Delete { path },
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let delta = state.repo.dry_run(&ops).await.map_err(ApiError::internal)?;
    Ok(Json(json!({ "check": delta })))
}

fn committed(result: Committed) -> Json<Value> {
    Json(json!(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    key: String,
    text: String,
    base_blob: String,
    message: Option<String>,
}
pub async fn save(
    State(state): State<AppState>,
    Json(body): Json<SaveRequest>,
) -> Result<Json<Value>> {
    let key = checked_key(&body.key)?;
    let path = page_path(&key);
    let text = normalize_text(&body.text);
    let message = message(
        body.message.as_deref(),
        format!("docs({}): update {}", area(&key), title_of(&text, &key)),
    )?;
    let result = state
        .repo
        .commit(message, |_| {
            Ok((
                vec![Op::Write {
                    path: path.clone(),
                    text: text.clone(),
                }],
                vec![(path.clone(), Some(body.base_blob.clone()))],
            ))
        })
        .await;
    match result {
        Ok(done) => Ok(committed(done)),
        Err(CommitError::Conflict {
            path,
            blob,
            text: theirs,
        }) => Err(conflict(&state, path, blob, theirs, &body.base_blob, &text).await),
        Err(error) => Err(error.into()),
    }
}

/// A 409 carrying the upstream version and, when possible, a three-way merge
/// of the owner's edit onto it for review.
async fn conflict(
    state: &AppState,
    path: String,
    blob: Option<String>,
    theirs: Option<String>,
    base_blob: &str,
    mine: &str,
) -> ApiError {
    let git = &state.repo.git;
    let mut merged = None;
    let mut merged_conflicts = false;
    if let Some(theirs) = &theirs
        && let Ok(base) = git.blob(base_blob).await
        && let Ok((text, conflicts)) = git
            .merge_texts(&state.repo.scratch, mine, &base, theirs)
            .await
    {
        merged = Some(text);
        merged_conflicts = conflicts;
    }
    ApiError::new(
        StatusCode::CONFLICT,
        if theirs.is_some() {
            "This page changed upstream while you were editing. Review the changes and save again."
        } else {
            "This page was moved or deleted upstream while you were editing."
        },
    )
    .with(json!({
        "path": path, "blob": blob, "text": theirs,
        "merged": merged, "mergedConflicts": merged_conflicts,
    }))
}

fn normalize_text(text: &str) -> String {
    let mut text = text.replace("\r\n", "\n");
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

#[derive(Deserialize)]
pub struct CreateRequest {
    key: String,
    text: String,
    section: Option<String>,
    description: Option<String>,
    message: Option<String>,
}
pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateRequest>,
) -> Result<Json<Value>> {
    let key = checked_key(&body.key)?;
    if key == "index" {
        return Err(ApiError::bad("That page already exists."));
    }
    let path = page_path(&key);
    let text = normalize_text(&body.text);
    let message = message(
        body.message.as_deref(),
        format!("docs({}): add {}", area(&key), title_of(&text, &key)),
    )?;
    let result = state
        .repo
        .commit(message, |snapshot| {
            if snapshot.pages.contains_key(&key) {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "A page with that path already exists.",
                )
                .into());
            }
            let mut ops = vec![Op::Write {
                path: path.clone(),
                text: text.clone(),
            }];
            let mut expected = vec![(path.clone(), None)];
            if let Some(section) = body.section.as_deref().filter(|s| !s.trim().is_empty())
                && let Some(index) = snapshot.pages.get("index")
            {
                let description = body.description.as_deref().unwrap_or("");
                ops.push(Op::Write {
                    path: index.path.clone(),
                    text: wiki::add_index_entry(&index.text, section, &key, description),
                });
                expected.push((index.path.clone(), Some(index.blob.clone())));
            }
            Ok((ops, expected))
        })
        .await?;
    Ok(committed(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveRequest {
    from: String,
    to: String,
    base_blob: String,
    message: Option<String>,
}
pub async fn rename(
    State(state): State<AppState>,
    Json(body): Json<MoveRequest>,
) -> Result<Json<Value>> {
    let from = checked_key(&body.from)?;
    let to = checked_key(&body.to)?;
    if from == to {
        return Err(ApiError::bad("Choose a different path."));
    }
    if ["index", "agent-start"].contains(&from.as_str()) {
        return Err(ApiError::bad(
            "The index and agent-start pages keep their paths.",
        ));
    }
    // A move is mechanical; its subject needs no model.
    let mut message = message(
        body.message.as_deref(),
        format!("docs({}): move {from} to {to}", area(&to)),
    )?;
    message.generate = false;
    let result = state
        .repo
        .commit(message, |snapshot| {
            let Some(page) = snapshot.pages.get(&from) else {
                return Err(CommitError::Conflict {
                    path: page_path(&from),
                    blob: None,
                    text: None,
                });
            };
            if snapshot.pages.contains_key(&to) {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "A page with that path already exists.",
                )
                .into());
            }
            let mut ops = vec![
                Op::Delete {
                    path: page.path.clone(),
                },
                Op::Write {
                    path: page_path(&to),
                    text: wiki::rewrite_links(&page.text, &from, &to),
                },
            ];
            let mut expected = vec![
                (page.path.clone(), Some(body.base_blob.clone())),
                (page_path(&to), None),
            ];
            for other in snapshot.pages.values().filter(|other| other.key != from) {
                if other.links.contains(&from) {
                    ops.push(Op::Write {
                        path: other.path.clone(),
                        text: wiki::rewrite_links(&other.text, &from, &to),
                    });
                    expected.push((other.path.clone(), Some(other.blob.clone())));
                }
            }
            Ok((ops, expected))
        })
        .await?;
    Ok(committed(result))
}

pub async fn status(State(state): State<AppState>) -> Json<Value> {
    Json(json!(state.repo.status()))
}

pub async fn sync(State(state): State<AppState>) -> Result<Json<Value>> {
    state.repo.pull().await.map_err(|error| {
        tracing::warn!("{error}");
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Could not reach GitHub to sync the wiki.",
        )
    })?;
    Ok(Json(json!(state.repo.status())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_status_logs() {
        let output = "\x1eabc\x1fRasmus\x1f2026-10-14T10:00:00+03:00\x1fdocs(x): y\n\nM\twiki/a.md\nR087\twiki/b.md\twiki/c.md\n\x1edef\x1fBot\x1f2026-10-13T10:00:00+03:00\x1finit\n\nA\twiki/a.md\n";
        let log = parse_log(output);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].files.len(), 2);
        assert_eq!(log[0].files[1].status, "R");
        assert_eq!(log[0].files[1].previous_path.as_deref(), Some("wiki/b.md"));
        assert_eq!(log[1].subject, "init");
    }

    #[test]
    fn rejects_unsafe_paths() {
        assert!(checked_repo_path("wiki/a.md").is_ok());
        assert!(checked_repo_path("raw/sources/x.md").is_ok());
        assert!(checked_repo_path("wiki/../.git/config").is_err());
        assert!(checked_repo_path("--output=x").is_err());
        assert!(checked_repo_path(".git/config").is_err());
        assert!(checked_rev("HEAD").is_err());
        assert!(checked_rev("abcdef1").is_ok());
    }
}
