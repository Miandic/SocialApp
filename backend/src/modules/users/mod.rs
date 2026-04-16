pub mod handlers;
pub mod models;
pub mod repo;

use axum::{
    routing::{get, patch, post, delete},
    Router,
};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/{username}", get(handlers::get_profile))
        .route("/profile", patch(handlers::update_profile))
        .route("/{username}/follow", post(handlers::follow))
        .route("/{username}/follow", delete(handlers::unfollow))
        .route("/{username}/followers", get(handlers::get_followers))
        .route("/{username}/following", get(handlers::get_following))
}
