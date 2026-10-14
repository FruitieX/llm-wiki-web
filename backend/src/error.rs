use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

/// An error answered as JSON: `{"message": …}` plus optional details that the
/// client uses (validation results, the upstream version of a conflicting page).
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
    pub details: Option<Value>,
}
pub type Result<T> = std::result::Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            details: None,
        }
    }
    pub fn with(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "Please sign in to continue.")
    }
    pub fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!("Internal operation failed: {error}");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The operation could not be completed. Please try again.",
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({ "message": self.message });
        if let Some(details) = self.details {
            body["details"] = details;
        }
        (self.status, Json(body)).into_response()
    }
}
impl From<std::io::Error> for ApiError {
    fn from(value: std::io::Error) -> Self {
        Self::internal(value)
    }
}
impl From<serde_json::Error> for ApiError {
    fn from(value: serde_json::Error) -> Self {
        Self::bad(format!("Invalid data: {value}"))
    }
}
