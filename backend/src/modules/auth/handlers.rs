use axum::{extract::State, Json};
use validator::Validate;

use crate::errors::{AppError, AppResult};
use crate::middleware::auth::AuthUser;
use crate::state::AppState;

use super::models::{AuthResponse, LoginRequest, RefreshRequest, RegisterRequest};
use super::service::AuthService;

pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> AppResult<Json<AuthResponse>> {
    req.validate()
        .map_err(|e| AppError::Validation(e.to_string()))?;

    let response = AuthService::register(&state.db, &state.config, req).await?;
    Ok(Json(response))
}

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> AppResult<Json<AuthResponse>> {
    let response = AuthService::login(&state.db, &state.config, req).await?;
    Ok(Json(response))
}

pub async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> AppResult<Json<AuthResponse>> {
    let response = AuthService::refresh(&state.db, &state.config, req).await?;
    Ok(Json(response))
}

pub async fn logout(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    AuthService::logout(&state.db, user.user_id).await?;
    Ok(Json(serde_json::json!({ "message": "Logged out" })))
}

pub async fn me(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<super::models::UserInfo>> {
    let row = super::repo::AuthRepo::find_by_id(&state.db, user.user_id)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".into()))?;

    Ok(Json(super::models::UserInfo::from(&row)))
}
