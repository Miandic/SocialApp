use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::config::Config;

/// Create and return a PostgreSQL connection pool.
pub async fn create_pg_pool(config: &Config) -> PgPool {
    PgPoolOptions::new()
        .max_connections(20)
        .connect(&config.database_url)
        .await
        .expect("Failed to connect to PostgreSQL")
}

/// Create and return a Redis connection manager.
pub async fn create_redis(config: &Config) -> redis::aio::ConnectionManager {
    let client = redis::Client::open(config.redis_url.as_str())
        .expect("Invalid Redis URL");
    client
        .get_connection_manager()
        .await
        .expect("Failed to connect to Redis")
}
