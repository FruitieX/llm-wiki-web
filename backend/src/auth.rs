//! Single-owner sign-in. The password hash and session digests live in
//! `auth.json` on the data volume; the first password is set with a setup
//! token from the deployment secret.

use crate::{
    AppState,
    error::{ApiError, Result},
};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header::SET_COOKIE},
};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub const COOKIE: &str = "llm_wiki_session";
const SESSION_DAYS: i64 = 90;
/// Sessions from a passkey (OIDC) sign-in last a year and slide: each use
/// after a day pushes the expiry a year out again, so prompts stay rare.
const OIDC_SESSION_DAYS: i64 = 365;
const RENEW_AFTER_SECONDS: i64 = 86400;
const MAX_SESSIONS: usize = 20;

#[derive(Default, Serialize, Deserialize)]
pub struct AuthFile {
    pub password_hash: Option<String>,
    pub sessions: Vec<Session>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    pub digest: String,
    pub created: i64,
    pub expires: i64,
    /// Renewed on use (passkey sign-ins); password sessions keep a fixed expiry.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sliding: bool,
}

pub struct Auth {
    path: PathBuf,
    file: tokio::sync::Mutex<AuthFile>,
    setup_token: Option<String>,
    secure_cookie: bool,
    failures: std::sync::Mutex<Vec<i64>>,
}

pub fn token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all("cookie")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|cookies| cookies.split(';'))
        .map(str::trim)
        .find_map(|cookie| cookie.strip_prefix(COOKIE)?.strip_prefix('='))
}

impl Auth {
    pub fn load(
        path: PathBuf,
        setup_token: Option<String>,
        secure_cookie: bool,
    ) -> std::io::Result<Self> {
        let file = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).map_err(std::io::Error::other)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => AuthFile::default(),
            Err(error) => return Err(error),
        };
        Ok(Auth {
            path,
            file: tokio::sync::Mutex::new(file),
            setup_token,
            secure_cookie,
            failures: std::sync::Mutex::new(Vec::new()),
        })
    }

    async fn save(&self, file: &AuthFile) -> Result<()> {
        let temp = self.path.with_extension("json.tmp");
        tokio::fs::write(&temp, serde_json::to_vec_pretty(file)?).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)).await?;
        }
        tokio::fs::rename(&temp, &self.path).await?;
        Ok(())
    }

    pub fn secure_cookie(&self) -> bool {
        self.secure_cookie
    }

    fn cookie(&self, raw: &str, max_age: i64) -> Result<HeaderValue> {
        format!(
            "{COOKIE}={raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{}",
            if self.secure_cookie { "; Secure" } else { "" }
        )
        .parse()
        .map_err(ApiError::internal)
    }

    /// Checks the session and, for a sliding one last renewed over a day ago,
    /// extends it. `None`: not signed in; `Some(Some(cookie))`: send the
    /// renewed cookie with the response.
    pub async fn check_and_renew(&self, headers: &HeaderMap) -> Option<Option<HeaderValue>> {
        let raw = session_cookie(headers).filter(|raw| raw.len() == 64)?;
        let digest = digest(raw);
        let now = chrono::Utc::now().timestamp();
        let mut file = self.file.lock().await;
        let session = file
            .sessions
            .iter_mut()
            .find(|session| session.digest == digest && session.expires > now)?;
        let lifetime = OIDC_SESSION_DAYS * 86400;
        if !session.sliding || session.expires - now > lifetime - RENEW_AFTER_SECONDS {
            return Some(None);
        }
        session.expires = now + lifetime;
        if let Err(error) = self.save(&file).await {
            tracing::warn!("Could not renew a session: {}", error.message);
            return Some(None);
        }
        Some(self.cookie(raw, lifetime).ok())
    }

    pub async fn signed_in(&self, headers: &HeaderMap) -> bool {
        let Some(raw) = session_cookie(headers) else {
            return false;
        };
        if raw.len() != 64 {
            return false;
        }
        let digest = digest(raw);
        let now = chrono::Utc::now().timestamp();
        self.file
            .lock()
            .await
            .sessions
            .iter()
            .any(|session| session.digest == digest && session.expires > now)
    }

    fn throttle(&self) -> Result<()> {
        let now = chrono::Utc::now().timestamp();
        let mut failures = self.failures.lock().unwrap_or_else(|e| e.into_inner());
        failures.retain(|at| *at > now - 15 * 60);
        if failures.len() >= 10 {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many attempts. Try again in a few minutes.",
            ));
        }
        Ok(())
    }
    fn failed(&self) {
        self.failures
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(chrono::Utc::now().timestamp());
    }

    async fn start_session(&self, file: &mut AuthFile) -> Result<HeaderMap> {
        let cookie = self.new_session(file, false).await?;
        let mut headers = HeaderMap::new();
        headers.insert(SET_COOKIE, cookie);
        Ok(headers)
    }

    /// A year-long sliding session after a passkey sign-in; returns its cookie.
    pub async fn start_oidc_session(&self) -> Result<HeaderValue> {
        let mut file = self.file.lock().await;
        self.new_session(&mut file, true).await
    }

    async fn new_session(&self, file: &mut AuthFile, sliding: bool) -> Result<HeaderValue> {
        let raw = token();
        let now = chrono::Utc::now().timestamp();
        let lifetime = if sliding {
            OIDC_SESSION_DAYS
        } else {
            SESSION_DAYS
        } * 86400;
        file.sessions.retain(|session| session.expires > now);
        file.sessions.push(Session {
            digest: digest(&raw),
            created: now,
            expires: now + lifetime,
            sliding,
        });
        if file.sessions.len() > MAX_SESSIONS {
            let excess = file.sessions.len() - MAX_SESSIONS;
            file.sessions.drain(..excess);
        }
        self.save(file).await?;
        self.cookie(&raw, lifetime)
    }
}

async fn hash_password(password: String) -> Result<String> {
    if password.chars().count() < 12 || password.len() > 256 {
        return Err(ApiError::bad(
            "Use a password with at least 12 characters (up to 256 bytes).",
        ));
    }
    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|hash| hash.to_string())
            .map_err(ApiError::internal)
    })
    .await
    .map_err(ApiError::internal)?
}

async fn verify_password(password: String, hash: String) -> Result<bool> {
    if password.len() > 256 {
        return Ok(false);
    }
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).is_ok_and(|hash| {
            Argon2::default()
                .verify_password(password.as_bytes(), &hash)
                .is_ok()
        })
    })
    .await
    .map_err(ApiError::internal)
}

pub async fn status(State(state): State<AppState>, headers: HeaderMap) -> Json<Value> {
    let configured = state.auth.file.lock().await.password_hash.is_some();
    Json(json!({
        "configured": configured,
        "signedIn": state.auth.signed_in(&headers).await,
        "setupAvailable": !configured && state.auth.setup_token.is_some(),
        "oidc": state.oidc.is_some(),
    }))
}

#[derive(Deserialize)]
pub struct SetupRequest {
    token: String,
    password: String,
}
pub async fn setup(
    State(state): State<AppState>,
    Json(body): Json<SetupRequest>,
) -> Result<(HeaderMap, Json<Value>)> {
    let auth = &state.auth;
    auth.throttle()?;
    let Some(expected) = &auth.setup_token else {
        return Err(ApiError::bad(
            "No setup token is configured for this deployment.",
        ));
    };
    if digest(body.token.trim()) != digest(expected) {
        auth.failed();
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "That setup token is not valid.",
        ));
    }
    let hash = hash_password(body.password).await?;
    let mut file = auth.file.lock().await;
    if file.password_hash.is_some() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "A password is already set.",
        ));
    }
    file.password_hash = Some(hash);
    file.sessions.clear();
    let headers = auth.start_session(&mut file).await?;
    Ok((headers, Json(json!({ "ok": true }))))
}

#[derive(Deserialize)]
pub struct LoginRequest {
    password: String,
}
pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> Result<(HeaderMap, Json<Value>)> {
    let auth = &state.auth;
    auth.throttle()?;
    let hash = auth.file.lock().await.password_hash.clone();
    let Some(hash) = hash else {
        return Err(ApiError::bad("Set a password first."));
    };
    if !verify_password(body.password, hash).await? {
        auth.failed();
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "That password is not right.",
        ));
    }
    let mut file = auth.file.lock().await;
    let headers = auth.start_session(&mut file).await?;
    Ok((headers, Json(json!({ "ok": true }))))
}

pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<Value>)> {
    if let Some(raw) = session_cookie(&headers) {
        let digest = digest(raw);
        let mut file = state.auth.file.lock().await;
        file.sessions.retain(|session| session.digest != digest);
        state.auth.save(&file).await?;
    }
    let mut out = HeaderMap::new();
    out.insert(
        SET_COOKIE,
        format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
            .parse()
            .map_err(ApiError::internal)?,
    );
    Ok((out, Json(json!({ "ok": true }))))
}

#[derive(Deserialize)]
pub struct PasswordRequest {
    current: String,
    password: String,
}
/// Changes the password and signs out every other session.
pub async fn change_password(
    State(state): State<AppState>,
    Json(body): Json<PasswordRequest>,
) -> Result<(HeaderMap, Json<Value>)> {
    let auth = &state.auth;
    auth.throttle()?;
    let current = auth
        .file
        .lock()
        .await
        .password_hash
        .clone()
        .unwrap_or_default();
    if !verify_password(body.current, current).await? {
        auth.failed();
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "The current password is not right.",
        ));
    }
    let hash = hash_password(body.password).await?;
    let mut file = auth.file.lock().await;
    file.password_hash = Some(hash);
    file.sessions.clear();
    let headers = auth.start_session(&mut file).await?;
    Ok((headers, Json(json!({ "ok": true }))))
}
