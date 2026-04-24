use axum::{
    routing::{delete, get, post},
    Router,
};

use crate::state::AppState;

mod handlers;
pub mod models;
pub mod repo;

pub use models::DeviceKeyBundle;
pub use repo::DevicesRepo;

pub fn router() -> Router<AppState> {
    Router::new()
        // Device registration & listing
        .route("/", post(handlers::register_device).get(handlers::list_devices))
        // Approve / revoke individual device
        .route("/{id}/approve", post(handlers::approve_device))
        .route("/{id}", delete(handlers::revoke_device))
        // Upload additional one-time pre-keys
        .route("/{id}/pre-keys", post(handlers::upload_pre_keys))
        // History sync (encrypted backup sent from one device to another)
        .route("/history-sync", post(handlers::send_history_package))
        .route(
            "/{id}/history-sync",
            get(handlers::get_history_package).delete(handlers::delete_history_package),
        )
        // Key bundle lookup — called before encrypting to a user
        .route(
            "/user-bundles/{user_id}",
            get(handlers::get_user_key_bundles),
        )
}
