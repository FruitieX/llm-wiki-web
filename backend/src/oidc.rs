//! Owner sign-in through an OpenID Connect provider (Pocket ID): authorization
//! code flow with PKCE, ending in the app's own sliding session cookie. Any
//! member of an allowed group is the owner, so there are no accounts to link.

use crate::{AppState, auth};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Mutex};

pub const STATE_COOKIE: &str = "llm_wiki_oidc";
const STATE_SECONDS: i64 = 600;
const MAX_PENDING: usize = 64;

pub struct OidcConfig {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    /// Where the provider sends the browser back to (`…/auth/callback`).
    pub redirect_url: String,
    /// Sign-in needs membership in one of these groups; empty allows anyone the provider lets through.
    pub allowed_groups: Vec<String>,
}

#[derive(Clone, Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
}

/// A sign-in between `/auth/login` and the callback. Kept in memory, keyed by
/// `state`; the browser holds `state` in a cookie so the callback is bound to
/// the browser that started it.
struct Pending {
    nonce: String,
    verifier: String,
    next: String,
    expires: i64,
}

pub struct Oidc {
    config: OidcConfig,
    http: reqwest::Client,
    discovery: tokio::sync::Mutex<Option<Discovery>>,
    pending: Mutex<HashMap<String, Pending>>,
}

/// Who signed in, after the claim checks.
#[derive(Debug, PartialEq)]
pub struct Identity {
    pub sub: String,
    pub name: String,
}

#[derive(Deserialize)]
struct IdClaims {
    iss: String,
    sub: String,
    aud: Audience,
    exp: i64,
    nonce: Option<String>,
    name: Option<String>,
    preferred_username: Option<String>,
    #[serde(default)]
    groups: Vec<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}

impl Audience {
    fn contains(&self, id: &str) -> bool {
        match self {
            Audience::One(aud) => aud == id,
            Audience::Many(auds) => auds.iter().any(|aud| aud == id),
        }
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn form_encode(pairs: &[(&str, &str)]) -> String {
    fn encode(s: &str) -> String {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect()
    }
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Only same-site paths, so the login can't be used as an open redirect.
fn safe_next(next: Option<&str>) -> String {
    match next {
        Some(next)
            if next.starts_with('/')
                && !next.starts_with("//")
                && !next.starts_with("/\\")
                && !next.starts_with("/auth/")
                && !next.chars().any(char::is_control) =>
        {
            next.to_string()
        }
        _ => "/".into(),
    }
}

impl Oidc {
    pub fn new(config: OidcConfig) -> Self {
        Self {
            config,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("HTTP client"),
            discovery: tokio::sync::Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Fetches the provider's metadata once and caches it.
    async fn discovery(&self) -> Result<Discovery, String> {
        let mut cached = self.discovery.lock().await;
        if let Some(discovery) = cached.clone() {
            return Ok(discovery);
        }
        let url = format!(
            "{}/.well-known/openid-configuration",
            self.config.issuer.trim_end_matches('/')
        );
        let discovery: Discovery = self
            .http
            .get(&url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("fetching {url}: {e}"))?
            .json()
            .await
            .map_err(|e| format!("reading {url}: {e}"))?;
        *cached = Some(discovery.clone());
        Ok(discovery)
    }

    /// The provider URL to send the browser to, and the `state` to bind to it.
    pub async fn start(&self, next: Option<&str>) -> Result<(String, String), String> {
        let discovery = self.discovery().await?;
        let state = auth::token();
        let pending = Pending {
            nonce: auth::token(),
            verifier: auth::token(),
            next: safe_next(next),
            expires: now() + STATE_SECONDS,
        };
        let challenge = pkce_challenge(&pending.verifier);
        let query = form_encode(&[
            ("response_type", "code"),
            ("client_id", &self.config.client_id),
            ("redirect_uri", &self.config.redirect_url),
            ("scope", "openid profile email groups"),
            ("state", &state),
            ("nonce", &pending.nonce),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
        ]);
        let separator = if discovery.authorization_endpoint.contains('?') {
            '&'
        } else {
            '?'
        };
        let url = format!("{}{separator}{query}", discovery.authorization_endpoint);
        let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let at = now();
        map.retain(|_, p| p.expires > at);
        if map.len() >= MAX_PENDING
            && let Some(oldest) = map
                .iter()
                .min_by_key(|(_, p)| p.expires)
                .map(|(k, _)| k.clone())
        {
            map.remove(&oldest);
        }
        map.insert(state.clone(), pending);
        Ok((url, state))
    }

    /// Takes the pending sign-in for `state` (once), if it hasn't expired.
    fn take(&self, state: &str) -> Option<Pending> {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(state)
            .filter(|p| p.expires > now())
    }

    /// Redeems the authorization code and checks who signed in.
    async fn finish(&self, pending: &Pending, code: &str) -> Result<Identity, String> {
        let discovery = self.discovery().await?;
        #[derive(Deserialize)]
        struct TokenResponse {
            id_token: String,
        }
        let body = form_encode(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &self.config.redirect_url),
            ("client_id", &self.config.client_id),
            ("client_secret", &self.config.client_secret),
            ("code_verifier", &pending.verifier),
        ]);
        let tokens: TokenResponse = self
            .http
            .post(&discovery.token_endpoint)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("redeeming the authorization code: {e}"))?
            .json()
            .await
            .map_err(|e| format!("reading the token response: {e}"))?;
        self.check_id_token(&discovery, &pending.nonce, &tokens.id_token)
    }

    /// The ID token comes straight from the token endpoint over TLS, so its
    /// signature need not be checked (OpenID Connect Core 3.1.3.7); the
    /// claims still are.
    fn check_id_token(
        &self,
        discovery: &Discovery,
        nonce: &str,
        id_token: &str,
    ) -> Result<Identity, String> {
        let payload = id_token.split('.').nth(1).ok_or("malformed ID token")?;
        let bytes = URL_SAFE_NO_PAD
            .decode(payload.trim_end_matches('='))
            .map_err(|e| format!("malformed ID token: {e}"))?;
        let claims: IdClaims =
            serde_json::from_slice(&bytes).map_err(|e| format!("reading ID token claims: {e}"))?;
        if claims.iss != discovery.issuer {
            return Err(format!("ID token from unexpected issuer {}", claims.iss));
        }
        if !claims.aud.contains(&self.config.client_id) {
            return Err("ID token is for another client".into());
        }
        if claims.exp <= now() {
            return Err("ID token has expired".into());
        }
        if claims.nonce.as_deref() != Some(nonce) {
            return Err("ID token nonce does not match".into());
        }
        let allowed = &self.config.allowed_groups;
        if !allowed.is_empty() && !claims.groups.iter().any(|g| allowed.contains(g)) {
            return Err(format!(
                "{} ({}) is not in an allowed group",
                claims.preferred_username.as_deref().unwrap_or("?"),
                claims.sub
            ));
        }
        Ok(Identity {
            name: claims
                .name
                .filter(|n| !n.trim().is_empty())
                .or(claims.preferred_username)
                .unwrap_or_else(|| claims.sub.clone()),
            sub: claims.sub,
        })
    }
}

fn state_cookie(value: &str, max_age: i64, secure: bool) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{STATE_COOKIE}={value}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age={max_age}{}",
        if secure { "; Secure" } else { "" }
    ))
    .expect("cookie header")
}

fn redirect(to: &str) -> Response {
    let mut response = StatusCode::SEE_OTHER.into_response();
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(to).unwrap_or(HeaderValue::from_static("/")),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Back to the sign-in screen, which explains that it didn't work.
fn failed(state: &AppState, reason: impl std::fmt::Display) -> Response {
    tracing::warn!("Passkey sign-in failed: {reason}");
    let mut response = redirect("/?signin=failed");
    response.headers_mut().append(
        header::SET_COOKIE,
        state_cookie("", 0, state.auth.secure_cookie()),
    );
    response
}

#[derive(Deserialize)]
pub struct LoginQuery {
    next: Option<String>,
}

pub async fn login(State(state): State<AppState>, Query(query): Query<LoginQuery>) -> Response {
    let Some(oidc) = &state.oidc else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match oidc.start(query.next.as_deref()).await {
        Ok((url, login_state)) => {
            let mut response = redirect(&url);
            response.headers_mut().append(
                header::SET_COOKIE,
                state_cookie(&login_state, STATE_SECONDS, state.auth.secure_cookie()),
            );
            response
        }
        Err(error) => failed(&state, error),
    }
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|cookies| cookies.split(';'))
        .map(str::trim)
        .find_map(|c| c.strip_prefix(name)?.strip_prefix('='))
}

pub async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<CallbackQuery>,
) -> Response {
    let Some(oidc) = &state.oidc else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if let Some(error) = query.error {
        return failed(&state, format!("provider returned {error}"));
    }
    let (Some(code), Some(returned)) = (query.code, query.state) else {
        return failed(&state, "callback without code or state");
    };
    if cookie(&headers, STATE_COOKIE) != Some(returned.as_str()) {
        return failed(&state, "state does not match this browser's sign-in");
    }
    let Some(pending) = oidc.take(&returned) else {
        return failed(&state, "missing or expired sign-in state");
    };
    let identity = match oidc.finish(&pending, &code).await {
        Ok(identity) => identity,
        Err(error) => return failed(&state, error),
    };
    let session = match state.auth.start_oidc_session().await {
        Ok(cookie) => cookie,
        Err(error) => return failed(&state, error.message),
    };
    tracing::info!(
        "{} ({}) signed in with a passkey",
        identity.name,
        identity.sub
    );
    let mut response = redirect(&pending.next);
    let out = response.headers_mut();
    out.append(header::SET_COOKIE, session);
    out.append(
        header::SET_COOKIE,
        state_cookie("", 0, state.auth.secure_cookie()),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oidc(groups: &[&str]) -> Oidc {
        Oidc::new(OidcConfig {
            issuer: "https://id.example.org".into(),
            client_id: "llm-wiki-web".into(),
            client_secret: "s".into(),
            redirect_url: "https://wiki.example.org/auth/callback".into(),
            allowed_groups: groups.iter().map(|g| g.to_string()).collect(),
        })
    }

    fn discovery() -> Discovery {
        Discovery {
            issuer: "https://id.example.org".into(),
            authorization_endpoint: "https://id.example.org/authorize".into(),
            token_endpoint: "https://id.example.org/api/oidc/token".into(),
        }
    }

    fn token(claims: serde_json::Value) -> String {
        format!(
            "e30.{}.sig",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
        )
    }

    fn claims() -> serde_json::Value {
        serde_json::json!({
            "iss": "https://id.example.org", "sub": "u1", "aud": "llm-wiki-web",
            "exp": now() + 60, "nonce": "n1", "name": "Owner",
            "preferred_username": "rasse", "groups": ["admins", "family"],
        })
    }

    #[test]
    fn accepts_valid_id_token() {
        let identity = oidc(&["admins"])
            .check_id_token(&discovery(), "n1", &token(claims()))
            .unwrap();
        assert_eq!(
            identity,
            Identity {
                sub: "u1".into(),
                name: "Owner".into()
            }
        );
    }

    #[test]
    fn rejects_bad_claims() {
        let cases = [
            ("iss", serde_json::json!("https://evil.example.org")),
            ("aud", serde_json::json!(["other"])),
            ("exp", serde_json::json!(1)),
            ("nonce", serde_json::json!("n2")),
            ("groups", serde_json::json!(["family"])),
        ];
        for (key, value) in cases {
            let mut claims = claims();
            claims[key] = value;
            assert!(
                oidc(&["admins"])
                    .check_id_token(&discovery(), "n1", &token(claims))
                    .is_err(),
                "{key} should be rejected"
            );
        }
        let mut no_nonce = claims();
        no_nonce.as_object_mut().unwrap().remove("nonce");
        assert!(
            oidc(&[])
                .check_id_token(&discovery(), "n1", &token(no_nonce))
                .is_err()
        );
        assert!(
            oidc(&[])
                .check_id_token(&discovery(), "n1", "not-a-jwt")
                .is_err()
        );
        // Without a group restriction, anyone the provider admits is fine.
        let mut claims = claims();
        claims["groups"] = serde_json::json!([]);
        assert!(
            oidc(&[])
                .check_id_token(&discovery(), "n1", &token(claims))
                .is_ok()
        );
    }

    #[tokio::test]
    async fn start_uses_pkce_and_state_is_single_use() {
        let oidc = oidc(&[]);
        *oidc.discovery.lock().await = Some(discovery());
        let (url, state) = oidc.start(Some("/page/a?x=1")).await.unwrap();
        assert!(url.starts_with("https://id.example.org/authorize?response_type=code&"));
        assert!(url.contains("redirect_uri=https%3A%2F%2Fwiki.example.org%2Fauth%2Fcallback"));
        assert!(url.contains(&format!("state={state}")));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(oidc.take("other").is_none());
        let pending = oidc.take(&state).unwrap();
        assert!(url.contains(&format!(
            "code_challenge={}",
            pkce_challenge(&pending.verifier)
        )));
        assert!(url.contains(&format!("nonce={}", pending.nonce)));
        assert_eq!(pending.next, "/page/a?x=1");
        assert!(oidc.take(&state).is_none(), "state is single-use");
    }

    #[tokio::test]
    async fn expired_state_is_refused() {
        let oidc = oidc(&[]);
        *oidc.discovery.lock().await = Some(discovery());
        let (_, state) = oidc.start(None).await.unwrap();
        oidc.pending
            .lock()
            .unwrap()
            .get_mut(&state)
            .unwrap()
            .expires = now() - 1;
        assert!(oidc.take(&state).is_none());
    }

    #[test]
    fn next_stays_on_this_site() {
        assert_eq!(safe_next(Some("/page/x")), "/page/x");
        for bad in [
            "https://evil.example",
            "//evil.example",
            "/\\evil.example",
            "/auth/login",
            "page",
            "/a\nb",
        ] {
            assert_eq!(safe_next(Some(bad)), "/", "{bad}");
        }
        assert_eq!(safe_next(None), "/");
    }
}
