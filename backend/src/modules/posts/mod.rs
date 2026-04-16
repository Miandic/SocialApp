pub mod handlers;
pub mod models;
pub mod repo;

use axum::{
    routing::{delete, get, post},
    Router,
};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", post(handlers::create_post))
        .route("/feed", get(handlers::feed))
        .route("/{id}", get(handlers::get_post))
        .route("/{id}", delete(handlers::delete_post))
        .route("/{id}/like", post(handlers::like_post))
        .route("/{id}/like", delete(handlers::unlike_post))
}
