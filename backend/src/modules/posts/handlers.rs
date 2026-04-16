use axum::{
    extract::{Path, Query, State},
    Json,
};
use uuid::Uuid;
use validator::Validate;

use crate::errors::{AppError, AppResult};
use crate::middleware::auth::AuthUser;
use crate::modules::auth::models::UserRow;
use crate::state::AppState;

use super::models::{CreatePostRequest, FeedParams, PostAuthor, PostResponse, PostRow};
use super::repo::PostsRepo;

pub async fn create_post(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreatePostRequest>,
) -> AppResult<Json<PostResponse>> {
    req.validate()
        .map_err(|e| AppError::Validation(e.to_string()))?;

    let media_urls = req.media_urls.unwrap_or_default();
    let post = PostsRepo::create(&state.db, user.user_id, &req.content, &media_urls).await?;

    let response = build_post_response(&state, &post, Some(user.user_id)).await?;
    Ok(Json(response))
}

pub async fn get_post(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<PostResponse>> {
    let post = PostsRepo::find_by_id(&state.db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("Post not found".into()))?;

    let response = build_post_response(&state, &post, None).await?;
    Ok(Json(response))
}

pub async fn delete_post(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let deleted = PostsRepo::delete(&state.db, id, user.user_id).await?;
    if !deleted {
        return Err(AppError::NotFound("Post not found or not owned by you".into()));
    }
    Ok(Json(serde_json::json!({ "message": "Deleted" })))
}

pub async fn like_post(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    PostsRepo::like(&state.db, user.user_id, id).await?;
    Ok(Json(serde_json::json!({ "message": "Liked" })))
}

pub async fn unlike_post(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    PostsRepo::unlike(&state.db, user.user_id, id).await?;
    Ok(Json(serde_json::json!({ "message": "Unliked" })))
}

pub async fn feed(
    State(state): State<AppState>,
    user: AuthUser,
    Query(params): Query<FeedParams>,
) -> AppResult<Json<Vec<PostResponse>>> {
    let posts = PostsRepo::feed(&state.db, user.user_id, params.before, params.limit()).await?;

    let mut responses = Vec::with_capacity(posts.len());
    for post in &posts {
        responses.push(build_post_response(&state, post, Some(user.user_id)).await?);
    }
    Ok(Json(responses))
}

// ─── Helpers ───

async fn build_post_response(
    state: &AppState,
    post: &PostRow,
    viewer_id: Option<Uuid>,
) -> AppResult<PostResponse> {
    let author_row = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(post.author_id)
        .fetch_one(&state.db)
        .await?;

    let is_liked = match viewer_id {
        Some(uid) => PostsRepo::is_liked(&state.db, uid, post.id).await?,
        None => false,
    };

    Ok(PostResponse {
        id: post.id,
        author: PostAuthor {
            id: author_row.id,
            username: author_row.username,
            display_name: author_row.display_name,
            avatar_url: author_row.avatar_url,
        },
        content: post.content.clone(),
        media_urls: post.media_urls.clone().unwrap_or_default(),
        like_count: post.like_count,
        repost_count: post.repost_count,
        is_liked,
        created_at: post.created_at,
    })
}
