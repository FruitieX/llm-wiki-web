//! Validation runs the wiki's own `tools/wiki_check.js` against a scratch copy
//! of the tree, so the rules can never drift from the repository's.

use crate::wiki::Snapshot;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct CheckResult {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// What a change does to the checker's output.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckDelta {
    /// Errors the change introduces. Any of these block a save.
    pub errors: Vec<String>,
    /// Warnings the change introduces, plus existing ones about touched files.
    pub warnings: Vec<String>,
    /// Errors already present before the change; shown, but never blocking.
    pub existing_errors: Vec<String>,
}

pub const CHECKER: &str = "tools/wiki_check.js";

pub async fn run(
    node: &str,
    scratch: &Path,
    repo_root: &Path,
    snapshot: &Snapshot,
    changes: &BTreeMap<String, Option<String>>,
) -> std::io::Result<CheckResult> {
    if !snapshot.tools.contains_key(CHECKER) {
        return Ok(CheckResult::default());
    }
    let dir = tempfile::tempdir_in(scratch)?;
    for (path, text) in &snapshot.tools {
        write(dir.path(), path, text).await?;
    }
    let mut files = snapshot.wiki_files();
    for (path, text) in changes {
        match text {
            Some(text) => files.insert(path.clone(), text.clone()),
            None => files.remove(path),
        };
    }
    tokio::fs::create_dir_all(dir.path().join("wiki")).await?;
    for (path, text) in &files {
        write(dir.path(), path, text).await?;
    }
    // Raw evidence is only checked for existence; link the live directory.
    let raw = repo_root.join("raw");
    if raw.exists() {
        #[cfg(unix)]
        tokio::fs::symlink(&raw, dir.path().join("raw")).await?;
    }
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::process::Command::new(node)
            .arg(CHECKER)
            .current_dir(dir.path())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| std::io::Error::other("the wiki checker timed out"))??;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut result = CheckResult::default();
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("ERROR ") {
            result.errors.push(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("WARN ") {
            result.warnings.push(rest.trim().to_string());
        }
    }
    let finished = stdout.lines().any(|line| line.starts_with("Checked "));
    if !finished || !matches!(output.status.code(), Some(0 | 1)) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = stderr
            .lines()
            .find(|line| line.contains("Error"))
            .unwrap_or(stderr.lines().next().unwrap_or("no output"));
        result.errors.push(format!(
            "the wiki checker could not run on this change: {}",
            reason.trim()
        ));
    }
    Ok(result)
}

async fn write(root: &Path, relative: &str, text: &str) -> std::io::Result<()> {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, text).await
}

pub fn delta(before: &CheckResult, after: &CheckResult, touched: &[String]) -> CheckDelta {
    let old_errors: BTreeSet<&String> = before.errors.iter().collect();
    let old_warnings: BTreeSet<&String> = before.warnings.iter().collect();
    // Messages name files relative to wiki/, e.g. "entities/homelab.md".
    let mentions_touched = |message: &str| {
        touched.iter().any(|path| {
            let rel = path.strip_prefix("wiki/").unwrap_or(path);
            message.contains(rel)
        })
    };
    CheckDelta {
        errors: after
            .errors
            .iter()
            .filter(|error| !old_errors.contains(error))
            .cloned()
            .collect(),
        warnings: after
            .warnings
            .iter()
            .filter(|warning| !old_warnings.contains(warning) || mentions_touched(warning))
            .cloned()
            .collect(),
        existing_errors: after
            .errors
            .iter()
            .filter(|error| old_errors.contains(error))
            .cloned()
            .collect(),
    }
}
