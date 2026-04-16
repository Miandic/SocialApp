use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub redis_url: String,
    pub s3_endpoint: String,
    pub s3_bucket: String,
    pub s3_access_key: String,
    pub s3_secret_key: String,
    pub elasticsearch_url: String,
    pub jwt_secret: String,
    pub jwt_access_ttl_secs: u64,
    pub jwt_refresh_ttl_secs: u64,
    pub server_host: String,
    pub server_port: u16,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            database_url: env("DATABASE_URL"),
            redis_url: env("REDIS_URL"),
            s3_endpoint: env("S3_ENDPOINT"),
            s3_bucket: env("S3_BUCKET"),
            s3_access_key: env("S3_ACCESS_KEY"),
            s3_secret_key: env("S3_SECRET_KEY"),
            elasticsearch_url: env("ELASTICSEARCH_URL"),
            jwt_secret: env("JWT_SECRET"),
            jwt_access_ttl_secs: env("JWT_ACCESS_TTL_SECS").parse().expect("JWT_ACCESS_TTL_SECS must be u64"),
            jwt_refresh_ttl_secs: env("JWT_REFRESH_TTL_SECS").parse().expect("JWT_REFRESH_TTL_SECS must be u64"),
            server_host: env::var("SERVER_HOST").unwrap_or_else(|_| "0.0.0.0".into()),
            server_port: env::var("SERVER_PORT")
                .unwrap_or_else(|_| "3000".into())
                .parse()
                .expect("SERVER_PORT must be u16"),
        }
    }

    pub fn server_addr(&self) -> String {
        format!("{}:{}", self.server_host, self.server_port)
    }
}

fn env(key: &str) -> String {
    env::var(key).unwrap_or_else(|_| panic!("{key} must be set"))
}
