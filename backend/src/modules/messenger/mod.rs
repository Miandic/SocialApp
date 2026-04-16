pub mod handlers;
pub mod hub;
pub mod models;
pub mod repo;
pub mod ws;

use axum::{
    routing::{get, post},
    Router,
};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/ws", get(ws::ws_handler))
        .route("/chats", post(handlers::create_chat))
        .route("/chats", get(handlers::list_chats))
        .route("/chats/{chat_id}/messages", get(handlers::get_messages))
}
