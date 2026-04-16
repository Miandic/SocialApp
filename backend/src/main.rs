mod config;
mod db;
mod errors;
mod middleware;
mod modules;
mod state;

use axum::Router;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::modules::media::service::MediaService;
use crate::modules::messenger::hub::ConnectionHub;
use crate::state::AppState;

#[tokio::main]
async fn main() {
    // Load .env
    dotenvy::dotenv().ok();

    // Init logging
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let config = Config::from_env();

    // Connect to databases
    let db = db::create_pg_pool(&config).await;
    let redis = db::create_redis(&config).await;

    // Run migrations
    tracing::info!("Running database migrations...");
    sqlx::migrate!("./migrations")
        .run(&db)
        .await
        .expect("Failed to run migrations");
    tracing::info!("Migrations complete.");

    // Init S3 client
    let s3_client = MediaService::create_s3_client(&config).await;
    MediaService::ensure_bucket(&s3_client, &config.s3_bucket).await;

    // Init WebSocket hub
    let hub = ConnectionHub::new();

    let state = AppState {
        db,
        redis,
        config: config.clone(),
        s3_client,
        hub,
    };

    // Build router
    let app = Router::new()
        .nest("/api/auth", modules::auth::router())
        .nest("/api/users", modules::users::router())
        .nest("/api/posts", modules::posts::router())
        .nest("/api/messenger", modules::messenger::router())
        .nest("/api/notifications", modules::notifications::router())
        .nest("/api/media", modules::media::router())
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = config.server_addr();
    tracing::info!("Diffract server starting on {addr}");

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind address");

    axum::serve(listener, app)
        .await
        .expect("Server error");
}
