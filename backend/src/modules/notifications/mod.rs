pub mod handlers;
pub mod models;
pub mod repo;

use axum::{
    routing::{get, patch},
    Router,
};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(handlers::list))
        .route("/unread-count", get(handlers::unread_count))
        .route("/read-all", patch(handlers::mark_all_read))
        .route("/{id}/read", patch(handlers::mark_read))
}
