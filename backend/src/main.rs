mod api;
mod auth;
mod check;
mod error;
mod git;
mod repo;
#[cfg(test)]
mod tests;
mod wiki;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use error::{ApiError, Result};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};

#[derive(Clone)]
pub struct AppState {
    pub repo: Arc<repo::Repo>,
    pub auth: Arc<auth::Auth>,
    pub origin: Option<String>,
}

pub fn app(state: AppState, static_dir: Option<&str>) -> Router {
    let router = Router::new()
        .route(
            "/api/health",
            get(|| async { Json(json!({ "status": "ok", "service": "llm-wiki-web" })) }),
        )
        .route("/api/ready", get(ready))
        .route("/api/auth/status", get(auth::status))
        .route("/api/auth/setup", post(auth::setup))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/password", post(auth::change_password))
        .route("/api/wiki", get(api::wiki))
        .route("/api/page", get(api::page).put(api::save).post(api::create))
        .route("/api/page/move", post(api::rename))
        .route("/api/raw", get(api::raw))
        .route("/api/search", get(api::search))
        .route("/api/recent", get(api::recent))
        .route("/api/history", get(api::history))
        .route("/api/diff", get(api::diff))
        .route("/api/check", post(api::check))
        .route("/api/status", get(api::status))
        .route("/api/sync", post(api::sync))
        .route(
            "/api/{*path}",
            axum::routing::any(|| async { ApiError::not_found("Unknown API route.") }),
        )
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), protect))
        .layer(tower_http::catch_panic::CatchPanicLayer::custom(
            panic_response,
        ))
        .with_state(state);
    match static_dir {
        Some(directory) => router
            .fallback_service(tower_http::services::ServeDir::new(directory).fallback(
                tower_http::services::ServeFile::new(PathBuf::from(directory).join("index.html")),
            ))
            .layer(middleware::from_fn(static_cache)),
        None => router,
    }
}

fn panic_response(panic: Box<dyn std::any::Any + Send + 'static>) -> Response {
    let detail = panic
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| panic.downcast_ref::<&str>().copied())
        .unwrap_or("unknown panic");
    ApiError::internal(format!("request handler panicked: {detail}")).into_response()
}

async fn static_cache(mut request: Request, next: Next) -> Response {
    let path = request.uri().path().to_string();
    let api = path.starts_with("/api/");
    let immutable = path.starts_with("/assets/");
    if !api && !immutable {
        // Nix gives files fixed mtimes, which cannot identify a new release.
        request.headers_mut().remove("if-modified-since");
    }
    let mut response = next.run(request).await;
    if !api {
        let policy = if immutable && response.status().is_success() {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        response
            .headers_mut()
            .insert("cache-control", HeaderValue::from_static(policy));
    }
    response
}

async fn ready(State(state): State<AppState>) -> Result<Json<serde_json::Value>> {
    if state.repo.snapshot().head.is_empty() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "The wiki is still loading.",
        ));
    }
    Ok(Json(json!({ "status": "ready" })))
}

const PUBLIC: &[&str] = &[
    "/api/health",
    "/api/ready",
    "/api/auth/status",
    "/api/auth/setup",
    "/api/auth/login",
    "/api/auth/logout",
];

async fn protect(State(state): State<AppState>, request: Request, next: Next) -> Result<Response> {
    let path = request.uri().path();
    let api = path.starts_with("/api/");
    if api
        && !matches!(
            *request.method(),
            Method::GET | Method::HEAD | Method::OPTIONS
        )
    {
        if request
            .headers()
            .get("x-llm-wiki")
            .and_then(|v| v.to_str().ok())
            != Some("1")
        {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "The request is missing its same-origin protection header.",
            ));
        }
        if let (Some(origin), Some(expected)) = (request.headers().get("origin"), &state.origin)
            && origin.to_str().ok() != Some(expected.as_str())
        {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "Requests must come from the configured application origin.",
            ));
        }
    }
    if api && !PUBLIC.contains(&path) && !state.auth.signed_in(request.headers()).await {
        return Err(ApiError::unauthorized());
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    if api {
        headers.insert("cache-control", HeaderValue::from_static("no-store"));
    }
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("same-origin"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    Ok(response)
}

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "llm_wiki_web=info,tower_http=info".into()),
        )
        .init();
    let data_dir = PathBuf::from(env("LLM_WIKI_DATA_DIR").unwrap_or_else(|| "./data".into()));
    std::fs::create_dir_all(&data_dir)?;
    let data_dir = data_dir.canonicalize()?;
    let scratch = PathBuf::from(env("LLM_WIKI_SCRATCH_DIR").unwrap_or_else(|| {
        std::env::temp_dir()
            .join("llm-wiki-web")
            .to_string_lossy()
            .into_owned()
    }));
    std::fs::create_dir_all(&scratch)?;
    let url = env("LLM_WIKI_REPO_URL").ok_or("LLM_WIKI_REPO_URL is required")?;
    let branch = env("LLM_WIKI_BRANCH").unwrap_or_else(|| "main".into());
    let origin = env("LLM_WIKI_ORIGIN").map(|origin| origin.trim_end_matches('/').to_string());
    let secure_cookie = origin
        .as_deref()
        .is_some_and(|origin| origin.starts_with("https://"));

    let ssh_command = match env("LLM_WIKI_SSH_KEY_FILE") {
        Some(key) => {
            // ssh insists on a private, owner-only key file; secret mounts are
            // group-readable, so keep a private copy on scratch storage.
            let ssh_dir = scratch.join("ssh");
            std::fs::create_dir_all(&ssh_dir)?;
            let copy = ssh_dir.join("id");
            let known_hosts = ssh_dir.join("known_hosts");
            let mut material = std::fs::read_to_string(&key)?;
            if !material.ends_with('\n') {
                material.push('\n');
            }
            std::fs::write(&copy, material)?;
            std::fs::write(&known_hosts, git::GITHUB_KNOWN_HOSTS)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&ssh_dir, std::fs::Permissions::from_mode(0o700))?;
                std::fs::set_permissions(&copy, std::fs::Permissions::from_mode(0o600))?;
            }
            Some(format!(
                "ssh -i {} -o IdentitiesOnly=yes -o UserKnownHostsFile={} -o StrictHostKeyChecking=yes -o BatchMode=yes",
                copy.display(),
                known_hosts.display()
            ))
        }
        None => None,
    };
    let git = git::Git {
        dir: data_dir.join("repo"),
        ssh_command,
        author_name: env("LLM_WIKI_GIT_NAME").unwrap_or_else(|| "llm-wiki-web".into()),
        author_email: env("LLM_WIKI_GIT_EMAIL").unwrap_or_else(|| "llm-wiki-web@localhost".into()),
    };
    let node = env("LLM_WIKI_NODE").unwrap_or_else(|| "node".into());
    let repo = Arc::new(repo::Repo::new(git, url, branch, scratch, node));
    let setup_token = env("LLM_WIKI_SETUP_TOKEN");
    if setup_token.as_ref().is_some_and(|token| token.len() < 16) {
        return Err("LLM_WIKI_SETUP_TOKEN needs at least 16 characters".into());
    }
    let auth = Arc::new(auth::Auth::load(
        data_dir.join("auth.json"),
        setup_token,
        secure_cookie,
    )?);
    let state = AppState {
        repo: repo.clone(),
        auth,
        origin,
    };

    // Clone (or catch up) before serving; retry while GitHub is unreachable.
    let mut delay = 2;
    while let Err(error) = repo.open().await {
        tracing::error!("Could not open the wiki repository: {error}");
        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
        delay = (delay * 2).min(60);
    }
    tracing::info!(
        "Wiki at {} ({} pages)",
        repo.snapshot().head,
        repo.snapshot().pages.len()
    );

    let interval = env("LLM_WIKI_SYNC_SECONDS")
        .and_then(|v| v.parse().ok())
        .unwrap_or(60u64);
    let syncing = repo.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(interval));
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Err(error) = syncing.pull().await {
                tracing::warn!("Periodic sync failed: {error}");
            }
        }
    });

    let bind = env("LLM_WIKI_BIND").unwrap_or_else(|| "127.0.0.1:3002".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("llm-wiki-web listening on {bind}");
    let static_dir = env("LLM_WIKI_STATIC_DIR");
    axum::serve(listener, app(state, static_dir.as_deref()))
        .with_graceful_shutdown(async {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("termination signal handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
        })
        .await?;
    Ok(())
}
