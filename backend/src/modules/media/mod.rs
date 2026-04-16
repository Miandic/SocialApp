pub mod handlers;
pub mod models;
pub mod service;

use axum::{routing::post, Router};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/upload", post(handlers::upload))
}
