//! An in-memory snapshot of the wiki at one commit: parsed pages, links,
//! backlinks and a small full-text search.

use regex::Regex;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
    sync::LazyLock,
};

pub static LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    // Same pattern as tools/wiki_check.js.
    Regex::new(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]").unwrap()
});
static FRONT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)\A---\n(.*?)\n---\n").unwrap());
static RAW_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`(raw/[^`\s]+)`").unwrap());
static PAGE_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$").unwrap()
});

pub fn normalize(target: &str) -> String {
    let target = target.trim();
    let target = target.strip_prefix('/').unwrap_or(target);
    target.strip_suffix(".md").unwrap_or(target).to_string()
}

/// Page keys are paths below `wiki/` without `.md`, in lowercase kebab-case.
pub fn valid_key(key: &str) -> bool {
    key.len() <= 160 && PAGE_PATH_RE.is_match(key)
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Frontmatter {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub status: Option<String>,
    pub updated: Option<String>,
    pub extra: BTreeMap<String, String>,
}

pub fn split_frontmatter(text: &str) -> (Option<Frontmatter>, &str) {
    let Some(found) = FRONT_RE.captures(text) else {
        return (None, text);
    };
    let mut front = Frontmatter::default();
    for line in found[1].lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim().to_string());
        match key {
            "type" => front.kind = Some(value),
            "status" => front.status = Some(value),
            "updated" => front.updated = Some(value),
            _ => {
                front.extra.insert(key.into(), value);
            }
        }
    }
    (Some(front), &text[found.get(0).unwrap().end()..])
}

#[derive(Clone, Debug, Serialize)]
pub struct Page {
    pub key: String,
    pub path: String,
    pub blob: String,
    pub title: String,
    pub summary: String,
    pub front: Option<Frontmatter>,
    #[serde(skip)]
    pub text: String,
    #[serde(skip)]
    pub links: Vec<String>,
    #[serde(skip)]
    pub raw_citations: Vec<String>,
}

fn title_case(key: &str) -> String {
    let last = key.rsplit('/').next().unwrap_or(key);
    let mut words: Vec<String> = last.split('-').map(str::to_string).collect();
    if let Some(first) = words.first_mut() {
        let mut chars = first.chars();
        if let Some(c) = chars.next() {
            *first = c.to_uppercase().chain(chars).collect();
        }
    }
    words.join(" ")
}

/// Strips Markdown decoration well enough for summaries and search snippets.
pub fn plain(text: &str) -> String {
    static MD_LINK: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\[([^\]]+)\]\([^)]*\)").unwrap());
    static WIKI: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]").unwrap());
    let text = WIKI.replace_all(text, |c: &regex::Captures| {
        c.get(2)
            .map_or_else(|| c[1].to_string(), |m| m.as_str().to_string())
    });
    let text = MD_LINK.replace_all(&text, "$1");
    text.replace("**", "").replace('`', "").replace("__", "")
}

impl Page {
    pub fn parse(key: &str, path: &str, blob: &str, text: String) -> Self {
        let (front, body) = split_frontmatter(&text);
        let mut title = None;
        let mut summary = String::new();
        let mut in_code = false;
        for line in body.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("```") {
                in_code = !in_code;
                continue;
            }
            if in_code {
                continue;
            }
            if let Some(heading) = trimmed.strip_prefix("# ") {
                title.get_or_insert_with(|| heading.trim().to_string());
                continue;
            }
            if summary.is_empty()
                && !trimmed.is_empty()
                && !trimmed.starts_with('#')
                && !trimmed.starts_with('|')
                && !trimmed.starts_with('>')
            {
                let line = trimmed.trim_start_matches(['-', '*', ' ']);
                summary = plain(line);
            }
        }
        if summary.chars().count() > 240 {
            summary = summary
                .chars()
                .take(237)
                .collect::<String>()
                .trim_end()
                .to_string()
                + "…";
        }
        let links = LINK_RE
            .captures_iter(&text)
            .map(|c| normalize(&c[1]))
            .collect();
        let raw_citations = RAW_RE
            .captures_iter(&text)
            .map(|c| c[1].to_string())
            .collect();
        Page {
            key: key.into(),
            path: path.into(),
            blob: blob.into(),
            title: title.unwrap_or_else(|| title_case(key)),
            summary,
            front,
            text,
            links,
            raw_citations,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct RawFile {
    pub path: String,
    pub blob: String,
    pub size: u64,
    #[serde(skip)]
    pub text: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Template {
    pub name: String,
    pub text: String,
}

#[derive(Default)]
pub struct Snapshot {
    pub head: String,
    pub pages: BTreeMap<String, Page>,
    pub raw: BTreeMap<String, RawFile>,
    pub templates: Vec<Template>,
    /// Every file in the tree that the checker reads: `tools/`, plus page texts.
    pub tools: BTreeMap<String, String>,
    pub backlinks: HashMap<String, Vec<String>>,
}

const SEARCHABLE_RAW_BYTES: u64 = 256 * 1024;

impl Snapshot {
    /// Builds a snapshot from the working tree, which matches `HEAD` whenever
    /// this is called (under the repository lock).
    pub fn load(root: &Path, head: String, tree: &[(String, String)]) -> std::io::Result<Self> {
        let mut snapshot = Snapshot {
            head,
            ..Default::default()
        };
        for (path, blob) in tree {
            let file = root.join(path);
            if let Some(rest) = path.strip_prefix("wiki/") {
                if let Some(key) = rest.strip_suffix(".md") {
                    let text = std::fs::read_to_string(&file)?;
                    snapshot
                        .pages
                        .insert(key.into(), Page::parse(key, path, blob, text));
                }
            } else if path.starts_with("raw/") {
                let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
                let text = (size <= SEARCHABLE_RAW_BYTES)
                    .then(|| std::fs::read(&file).ok())
                    .flatten()
                    .and_then(|bytes| String::from_utf8(bytes).ok());
                snapshot.raw.insert(
                    path.clone(),
                    RawFile {
                        path: path.clone(),
                        blob: blob.clone(),
                        size,
                        text,
                    },
                );
            } else if let Some(name) = path.strip_prefix("templates/")
                && let Some(name) = name.strip_suffix(".md")
            {
                snapshot.templates.push(Template {
                    name: name.into(),
                    text: std::fs::read_to_string(&file)?,
                });
            } else if path.starts_with("tools/")
                && let Ok(text) = std::fs::read_to_string(&file)
            {
                snapshot.tools.insert(path.clone(), text);
            }
        }
        snapshot.backlinks = backlinks(&snapshot.pages);
        Ok(snapshot)
    }

    pub fn page_by_path(&self, path: &str) -> Option<&Page> {
        path.strip_prefix("wiki/")
            .and_then(|rest| rest.strip_suffix(".md"))
            .and_then(|key| self.pages.get(key))
    }

    pub fn wiki_files(&self) -> BTreeMap<String, String> {
        self.pages
            .values()
            .map(|page| (page.path.clone(), page.text.clone()))
            .collect()
    }
}

fn backlinks(pages: &BTreeMap<String, Page>) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, BTreeSet<String>> = HashMap::new();
    for page in pages.values() {
        for target in &page.links {
            if target != &page.key && pages.contains_key(target) {
                map.entry(target.clone())
                    .or_default()
                    .insert(page.key.clone());
            }
        }
    }
    map.into_iter()
        .map(|(key, set)| (key, set.into_iter().collect()))
        .collect()
}

#[derive(Serialize)]
pub struct SearchHit {
    pub kind: &'static str,
    pub key: String,
    pub title: String,
    pub snippet: String,
    pub score: u32,
    pub front: Option<Frontmatter>,
}

fn snippet(text: &str, needle: &str) -> String {
    let lower = text.to_lowercase();
    let Some(at) = lower.find(needle) else {
        return String::new();
    };
    // Work on char boundaries of the original text; lowercasing can change
    // byte lengths, so map through char indices.
    let char_at = lower[..at].chars().count();
    let chars: Vec<char> = text.chars().collect();
    let start = char_at.saturating_sub(70);
    let end = (char_at + needle.chars().count() + 110).min(chars.len());
    let mut out: String = chars[start..end].iter().collect();
    out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if start > 0 {
        out.insert(0, '…');
    }
    if end < chars.len() {
        out.push('…');
    }
    out
}

pub fn search(snapshot: &Snapshot, query: &str, limit: usize) -> Vec<SearchHit> {
    let terms: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(str::to_string)
        .filter(|term| !term.is_empty())
        .take(8)
        .collect();
    if terms.is_empty() {
        return Vec::new();
    }
    let score_text = |title: &str, key: &str, body: &str| -> Option<u32> {
        let (title, key, body) = (
            title.to_lowercase(),
            key.to_lowercase(),
            body.to_lowercase(),
        );
        let mut score = 0;
        for term in &terms {
            let in_title = title.contains(term.as_str());
            let in_key = key.contains(term.as_str());
            let in_body = body.matches(term.as_str()).count() as u32;
            if !in_title && !in_key && in_body == 0 {
                return None;
            }
            score += in_title as u32 * 40
                + title
                    .split(|c: char| !c.is_alphanumeric())
                    .any(|w| w == term) as u32
                    * 20
                + in_key as u32 * 15
                + in_body.min(12);
        }
        Some(score)
    };
    let mut hits: Vec<SearchHit> = snapshot
        .pages
        .values()
        .filter_map(|page| {
            let (_, body) = split_frontmatter(&page.text);
            let score = score_text(&page.title, &page.key, body)?;
            let plain_body = plain(body);
            let mut excerpt = snippet(&plain_body, &terms[0]);
            if excerpt.is_empty() {
                excerpt = page.summary.clone();
            }
            Some(SearchHit {
                kind: "page",
                key: page.key.clone(),
                title: page.title.clone(),
                snippet: excerpt,
                score,
                front: page.front.clone(),
            })
        })
        .chain(snapshot.raw.values().filter_map(|raw| {
            let text = raw.text.as_deref().unwrap_or("");
            let name = raw.path.rsplit('/').next().unwrap_or(&raw.path);
            let score = score_text(name, &raw.path, text)? / 2;
            Some(SearchHit {
                kind: "raw",
                key: raw.path.clone(),
                title: name.to_string(),
                snippet: snippet(text, &terms[0]),
                score,
                front: None,
            })
        }))
        .collect();
    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.key.cmp(&b.key)));
    hits.truncate(limit);
    hits
}

/// Rewrites every `[[from…]]` link to point at `to`, keeping anchors and labels.
pub fn rewrite_links(text: &str, from: &str, to: &str) -> String {
    static FULL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\[\[([^\]|#]+)((?:#[^\]|]+)?(?:\|[^\]]+)?)\]\]").unwrap());
    FULL.replace_all(text, |c: &regex::Captures| {
        if normalize(&c[1]) == from {
            format!("[[{to}{}]]", &c[2])
        } else {
            c[0].to_string()
        }
    })
    .into_owned()
}

/// Adds `- [[key]] — description` to the end of the list under `## section`
/// in index.md, creating the section when it is missing.
pub fn add_index_entry(index: &str, section: &str, key: &str, description: &str) -> String {
    let entry = if description.trim().is_empty() {
        format!("- [[{key}]]")
    } else {
        format!("- [[{key}]] — {}", description.trim())
    };
    let lines: Vec<&str> = index.lines().collect();
    let heading = format!("## {}", section.trim());
    let Some(start) = lines.iter().position(|line| line.trim() == heading) else {
        let mut out = index.trim_end().to_string();
        out.push_str(&format!("\n\n{heading}\n\n{entry}\n"));
        return out;
    };
    let end = lines[start + 1..]
        .iter()
        .position(|line| line.starts_with("## ") || line.starts_with("# "))
        .map_or(lines.len(), |offset| start + 1 + offset);
    // Insert after the last list item in the section, or after the heading.
    let insert_at = lines[start + 1..end]
        .iter()
        .rposition(|line| line.starts_with("- "))
        .map_or(start + 1, |offset| start + 2 + offset);
    let mut out: Vec<String> = lines.iter().map(|line| line.to_string()).collect();
    if insert_at == start + 1 {
        out.insert(insert_at, String::new());
        out.insert(insert_at + 1, entry);
    } else {
        out.insert(insert_at, entry);
    }
    let mut text = out.join("\n");
    if index.ends_with('\n') {
        text.push('\n');
    }
    text
}

pub fn index_sections(index: &str) -> Vec<String> {
    index
        .lines()
        .filter_map(|line| line.strip_prefix("## "))
        .map(|line| line.trim().to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pages() {
        let page = Page::parse(
            "entities/homelab",
            "wiki/entities/homelab.md",
            "abc",
            "---\ntype: entity\nstatus: active\nupdated: 2026-10-14\n---\n\n# Homelab\n\nThe [[entities/home-network|network]] and `raw/sources/x.md`.\n".into(),
        );
        assert_eq!(page.title, "Homelab");
        assert_eq!(page.front.as_ref().unwrap().kind.as_deref(), Some("entity"));
        assert_eq!(page.links, vec!["entities/home-network"]);
        assert_eq!(page.raw_citations, vec!["raw/sources/x.md"]);
        assert_eq!(page.summary, "The network and raw/sources/x.md.");
    }

    #[test]
    fn rewrites_links_keeping_labels_and_anchors() {
        let text = "[[a/b]] [[a/b#x|Label]] [[/a/b.md]] [[a/bc]]";
        assert_eq!(
            rewrite_links(text, "a/b", "c/d"),
            "[[c/d]] [[c/d#x|Label]] [[c/d]] [[a/bc]]"
        );
    }

    #[test]
    fn adds_index_entries() {
        let index = "# Wiki index\n\n## Entities\n\n- [[entities/a]] — A.\n\n## Concepts\n\n- [[concepts/b]] — B.\n";
        let out = add_index_entry(index, "Entities", "entities/c", "C.");
        assert_eq!(
            out,
            "# Wiki index\n\n## Entities\n\n- [[entities/a]] — A.\n- [[entities/c]] — C.\n\n## Concepts\n\n- [[concepts/b]] — B.\n"
        );
        let out = add_index_entry(index, "Analyses", "analyses/d", "D.");
        assert!(out.ends_with("## Analyses\n\n- [[analyses/d]] — D.\n"));
    }

    #[test]
    fn validates_keys() {
        assert!(valid_key("entities/home-network"));
        assert!(!valid_key("entities/Home"));
        assert!(!valid_key("../etc"));
        assert!(!valid_key("a//b"));
    }
}
