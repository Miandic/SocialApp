use aws_sdk_s3::Client as S3Client;
use axum::extract::FromRef;
use sqlx::PgPool;

use crate::config::Config;
use crate::modules::messenger::hub::ConnectionHub;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub redis: redis::aio::ConnectionManager,
    pub config: Config,
    pub s3_client: S3Client,
    pub hub: ConnectionHub,
}

// Allow sub-extractors to pull individual pieces from AppState
impl FromRef<AppState> for PgPool {
    fn from_ref(state: &AppState) -> Self {
        state.db.clone()
    }
}

impl FromRef<AppState> for Config {
    fn from_ref(state: &AppState) -> Self {
        state.config.clone()
    }
}
