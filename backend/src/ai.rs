//! Commit subjects written by the owner's Hermes agent through its
//! OpenAI-compatible API. Optional: without it, or when it is slow or
//! answers oddly, saves keep their deterministic subject.

use regex::Regex;
use serde_json::{Value, json};
use std::{sync::LazyLock, time::Duration};

pub struct Ai {
    client: reqwest::Client,
    url: String,
    key: Option<String>,
    model: String,
}

const MAX_DIFF: usize = 12_000;

const SYSTEM: &str = "You write git commit subjects for llm-wiki, a Markdown knowledge base. \
Reply with exactly one line and nothing else: a Conventional Commit subject `docs(<area>): <summary>`. \
The summary is a lowercase imperative phrase that says what changed in the content, at most 72 characters \
in total, with no trailing period. Use the suggested area unless the diff clearly spans many pages, then use `wiki`.";

impl Ai {
    pub fn new(url: String, key: Option<String>, model: String) -> reqwest::Result<Self> {
        Ok(Ai {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(45))
                .build()?,
            url: url.trim_end_matches('/').to_string(),
            key,
            model,
        })
    }

    pub async fn commit_subject(
        &self,
        area: &str,
        diff: &str,
        examples: &[String],
    ) -> Option<String> {
        let mut diff = diff.to_string();
        if diff.len() > MAX_DIFF {
            let mut cut = MAX_DIFF;
            while !diff.is_char_boundary(cut) {
                cut -= 1;
            }
            diff.truncate(cut);
            diff.push_str("\n… (diff truncated)");
        }
        let examples: String = examples
            .iter()
            .map(|subject| format!("- {subject}\n"))
            .collect();
        let prompt = format!(
            "Recent subjects in this repository, for style:\n{examples}\nSuggested area: {area}\n\nDiff:\n```diff\n{diff}\n```"
        );
        let mut request = self
            .client
            .post(format!("{}/chat/completions", self.url))
            .json(&json!({
                "model": self.model,
                "messages": [
                    { "role": "system", "content": SYSTEM },
                    { "role": "user", "content": prompt },
                ],
            }));
        if let Some(key) = &self.key {
            request = request.bearer_auth(key);
        }
        let started = std::time::Instant::now();
        let response = match request.send().await.and_then(|r| r.error_for_status()) {
            Ok(response) => response,
            Err(error) => {
                tracing::warn!("Commit subject request failed: {}", error.without_url());
                return None;
            }
        };
        let body: Value = response.json().await.ok()?;
        let subject = sanitize(body["choices"][0]["message"]["content"].as_str()?);
        tracing::info!(
            "Commit subject {} in {} ms",
            if subject.is_some() {
                "generated"
            } else {
                "rejected"
            },
            started.elapsed().as_millis()
        );
        subject
    }
}

/// Accepts one Conventional Commit subject line, or nothing.
pub fn sanitize(reply: &str) -> Option<String> {
    static SUBJECT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[a-z]+(\([a-z0-9._/-]+\))?!?: \S.*$").unwrap());
    let line = reply.lines().map(str::trim).find(|line| !line.is_empty())?;
    let line = line
        .trim_start_matches("Subject:")
        .trim()
        .trim_matches(['`', '"', '\'', '*'])
        .trim()
        .trim_end_matches('.');
    (line.chars().count() <= 100 && SUBJECT.is_match(line)).then(|| line.to_string())
}

#[cfg(test)]
mod tests {
    use super::sanitize;

    #[test]
    fn keeps_only_conventional_subjects() {
        assert_eq!(
            sanitize("`docs(homelab): set flux interval to 30m.`\n").as_deref(),
            Some("docs(homelab): set flux interval to 30m")
        );
        assert_eq!(
            sanitize("\nSubject: docs(wiki): tidy links").as_deref(),
            Some("docs(wiki): tidy links")
        );
        assert_eq!(sanitize("Sure! Here is a subject:"), None);
        assert_eq!(sanitize(&format!("docs(x): {}", "a".repeat(120))), None);
    }
}
