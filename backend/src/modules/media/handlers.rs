use axum::{
    extract::{Multipart, State},
    Json,
};

use crate::errors::{AppError, AppResult};
use crate::middleware::auth::AuthUser;
use crate::state::AppState;

use super::models::UploadResponse;
use super::service::MediaService;

const MAX_FILE_SIZE: usize = 10 * 1024 * 1024; // 10MB

const ALLOWED_TYPES: &[&str] = &[
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "video/mp4",
    "video/webm",
];

pub async fn upload(
    State(state): State<AppState>,
    _user: AuthUser,
    mut multipart: Multipart,
) -> AppResult<Json<Vec<UploadResponse>>> {
    let mut uploads = Vec::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        let content_type: String = field
            .content_type()
            .unwrap_or("application/octet-stream")
            .to_string();

        if !ALLOWED_TYPES.contains(&content_type.as_str()) {
            return Err(AppError::BadRequest(format!(
                "Unsupported file type: {content_type}"
            )));
        }

        let data: bytes::Bytes = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(format!("Failed to read file: {e}")))?;

        if data.len() > MAX_FILE_SIZE {
            return Err(AppError::BadRequest("File too large (max 10MB)".into()));
        }

        let (url, key) = MediaService::upload(
            &state.s3_client,
            &state.config.s3_bucket,
            &content_type,
            data.to_vec(),
        )
        .await?;

        uploads.push(UploadResponse { url, key });
    }

    if uploads.is_empty() {
        return Err(AppError::BadRequest("No files uploaded".into()));
    }

    Ok(Json(uploads))
}
