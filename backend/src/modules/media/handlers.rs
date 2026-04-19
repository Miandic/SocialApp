use axum::{
    extract::{Multipart, State},
    Json,
};

use crate::errors::{AppError, AppResult};
use crate::middleware::auth::AuthUser;
use crate::state::AppState;

use super::models::UploadResponse;
use super::service::MediaService;

const MAX_FILE_SIZE: usize = 200 * 1024 * 1024; // 200MB

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

        let data: bytes::Bytes = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(format!("Failed to read file: {e}")))?;

        if data.len() > MAX_FILE_SIZE {
            return Err(AppError::BadRequest("File too large (max 200MB)".into()));
        }

        let (url, key) = MediaService::upload(
            &state.s3_client,
            &state.config.s3_endpoint,
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
