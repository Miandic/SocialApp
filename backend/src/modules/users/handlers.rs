use axum::{
    extract::{Path, Query, State},
    Json,
};
use validator::Validate;

use crate::errors::{AppError, AppResult};
use crate::middleware::auth::{AuthUser, OptionalAuthUser};
use crate::state::AppState;

use super::models::{PaginationParams, ProfileResponse, UpdateProfileRequest, UserListItem};
use super::repo::UsersRepo;

pub async fn get_profile(
    State(state): State<AppState>,
    OptionalAuthUser(auth): OptionalAuthUser,
    Path(username): Path<String>,
) -> AppResult<Json<ProfileResponse>> {
    let user = UsersRepo::find_by_username(&state.db, &username)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".into()))?;

    let followers_count = UsersRepo::followers_count(&state.db, user.id).await?;
    let following_count = UsersRepo::following_count(&state.db, user.id).await?;

    let is_following = match &auth {
        Some(me) if me.user_id != user.id => {
            UsersRepo::is_following(&state.db, me.user_id, user.id).await?
        }
        _ => false,
    };

    Ok(Json(ProfileResponse {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        bio: user.bio,
        avatar_url: user.avatar_url,
        followers_count,
        following_count,
        is_following,
        created_at: user.created_at,
    }))
}

pub async fn update_profile(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<UpdateProfileRequest>,
) -> AppResult<Json<ProfileResponse>> {
    req.validate()
        .map_err(|e| AppError::Validation(e.to_string()))?;

    let updated = UsersRepo::update_profile(
        &state.db,
        user.user_id,
        req.display_name.as_deref(),
        req.bio.as_deref(),
        req.avatar_url.as_deref(),
    )
    .await?;

    let followers_count = UsersRepo::followers_count(&state.db, updated.id).await?;
    let following_count = UsersRepo::following_count(&state.db, updated.id).await?;

    Ok(Json(ProfileResponse {
        id: updated.id,
        username: updated.username,
        display_name: updated.display_name,
        bio: updated.bio,
        avatar_url: updated.avatar_url,
        followers_count,
        following_count,
        is_following: false,
        created_at: updated.created_at,
    }))
}

pub async fn follow(
    State(state): State<AppState>,
    user: AuthUser,
    Path(username): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let target = UsersRepo::find_by_username(&state.db, &username)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".into()))?;

    if target.id == user.user_id {
        return Err(AppError::BadRequest("Cannot follow yourself".into()));
    }

    UsersRepo::follow(&state.db, user.user_id, target.id).await?;
    Ok(Json(serde_json::json!({ "message": "Followed" })))
}

pub async fn unfollow(
    State(state): State<AppState>,
    user: AuthUser,
    Path(username): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let target = UsersRepo::find_by_username(&state.db, &username)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".into()))?;

    UsersRepo::unfollow(&state.db, user.user_id, target.id).await?;
    Ok(Json(serde_json::json!({ "message": "Unfollowed" })))
}

pub async fn get_followers(
    State(state): State<AppState>,
    Path(username): Path<String>,
    Query(pagination): Query<PaginationParams>,
) -> AppResult<Json<Vec<UserListItem>>> {
    let user = UsersRepo::find_by_username(&state.db, &username)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".into()))?;

    let users = UsersRepo::get_followers(
        &state.db,
        user.id,
        pagination.offset(),
        pagination.limit(),
    )
    .await?;

    let items: Vec<UserListItem> = users
        .into_iter()
        .map(|u| UserListItem {
            id: u.id,
            username: u.username,
            display_name: u.display_name,
            avatar_url: u.avatar_url,
        })
        .collect();

    Ok(Json(items))
}

pub async fn get_following(
    State(state): State<AppState>,
    Path(username): Path<String>,
    Query(pagination): Query<PaginationParams>,
) -> AppResult<Json<Vec<UserListItem>>> {
    let user = UsersRepo::find_by_username(&state.db, &username)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".into()))?;

    let users = UsersRepo::get_following(
        &state.db,
        user.id,
        pagination.offset(),
        pagination.limit(),
    )
    .await?;

    let items: Vec<UserListItem> = users
        .into_iter()
        .map(|u| UserListItem {
            id: u.id,
            username: u.username,
            display_name: u.display_name,
            avatar_url: u.avatar_url,
        })
        .collect();

    Ok(Json(items))
}
