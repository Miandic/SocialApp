use axum::{
    extract::{Path, Query, State},
    Json,
};
use uuid::Uuid;

use crate::errors::AppResult;
use crate::middleware::auth::AuthUser;
use crate::state::AppState;

use super::models::*;
use super::repo::NotificationsRepo;

pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<NotificationsQuery>,
) -> AppResult<Json<Vec<NotificationResponse>>> {
    let notifications = NotificationsRepo::get_for_user(
        &state.db,
        user.user_id,
        query.unread_only.unwrap_or(false),
        query.offset(),
        query.limit(),
    )
    .await?;

    let responses: Vec<NotificationResponse> = notifications
        .into_iter()
        .map(|n| NotificationResponse {
            id: n.id,
            notification_type: n.notification_type,
            data: n.data,
            is_read: n.is_read,
            created_at: n.created_at,
        })
        .collect();

    Ok(Json(responses))
}

pub async fn mark_read(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    NotificationsRepo::mark_read(&state.db, id, user.user_id).await?;
    Ok(Json(serde_json::json!({ "message": "Marked as read" })))
}

pub async fn mark_all_read(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    NotificationsRepo::mark_all_read(&state.db, user.user_id).await?;
    Ok(Json(serde_json::json!({ "message": "All marked as read" })))
}

pub async fn unread_count(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let count = NotificationsRepo::unread_count(&state.db, user.user_id).await?;
    Ok(Json(serde_json::json!({ "count": count })))
}
