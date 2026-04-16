use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use chrono::{Duration, Utc};
use jsonwebtoken::{encode, EncodingKey, Header};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::errors::{AppError, AppResult};
use crate::middleware::auth::{Claims, TokenType};

use super::models::{AuthResponse, LoginRequest, RefreshRequest, RegisterRequest, UserInfo};
use super::repo::AuthRepo;

pub struct AuthService;

impl AuthService {
    pub async fn register(
        pool: &PgPool,
        config: &Config,
        req: RegisterRequest,
    ) -> AppResult<AuthResponse> {
        let password_hash = hash_password(&req.password)?;

        let user = AuthRepo::create_user(
            pool,
            &req.username,
            &req.email,
            &password_hash,
            req.display_name.as_deref(),
        )
        .await?;

        let user_info = UserInfo::from(&user);
        let (access_token, refresh_token) =
            generate_token_pair(config, user.id, &user.username)?;

        store_refresh_token(pool, user.id, &refresh_token, config.jwt_refresh_ttl_secs).await?;

        Ok(AuthResponse {
            access_token,
            refresh_token,
            user: user_info,
        })
    }

    pub async fn login(
        pool: &PgPool,
        config: &Config,
        req: LoginRequest,
    ) -> AppResult<AuthResponse> {
        let user = AuthRepo::find_by_login(pool, &req.login)
            .await?
            .ok_or_else(|| AppError::Unauthorized("Invalid credentials".into()))?;

        verify_password(&req.password, &user.password_hash)?;

        let user_info = UserInfo::from(&user);
        let (access_token, refresh_token) =
            generate_token_pair(config, user.id, &user.username)?;

        store_refresh_token(pool, user.id, &refresh_token, config.jwt_refresh_ttl_secs).await?;

        Ok(AuthResponse {
            access_token,
            refresh_token,
            user: user_info,
        })
    }

    pub async fn refresh(
        pool: &PgPool,
        config: &Config,
        req: RefreshRequest,
    ) -> AppResult<AuthResponse> {
        let token_hash = hash_token(&req.refresh_token);

        let stored = AuthRepo::find_refresh_token(pool, &token_hash)
            .await?
            .ok_or_else(|| AppError::Unauthorized("Invalid or expired refresh token".into()))?;

        // Rotate: delete old token
        AuthRepo::delete_refresh_token(pool, &token_hash).await?;

        let user = AuthRepo::find_by_id(pool, stored.user_id)
            .await?
            .ok_or_else(|| AppError::Unauthorized("User not found".into()))?;

        let user_info = UserInfo::from(&user);
        let (access_token, new_refresh_token) =
            generate_token_pair(config, user.id, &user.username)?;

        store_refresh_token(pool, user.id, &new_refresh_token, config.jwt_refresh_ttl_secs)
            .await?;

        Ok(AuthResponse {
            access_token,
            refresh_token: new_refresh_token,
            user: user_info,
        })
    }

    pub async fn logout(pool: &PgPool, user_id: Uuid) -> AppResult<()> {
        AuthRepo::delete_user_refresh_tokens(pool, user_id).await
    }
}

// ─── Helpers ───

fn hash_password(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| AppError::BadRequest(format!("Password hashing failed: {e}")))?;
    Ok(hash.to_string())
}

fn verify_password(password: &str, hash: &str) -> AppResult<()> {
    let parsed_hash =
        PasswordHash::new(hash).map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .map_err(|_| AppError::Unauthorized("Invalid credentials".into()))
}

fn generate_token_pair(
    config: &Config,
    user_id: Uuid,
    username: &str,
) -> AppResult<(String, String)> {
    let now = Utc::now().timestamp() as u64;

    let access_claims = Claims {
        sub: user_id,
        username: username.to_string(),
        iat: now,
        exp: now + config.jwt_access_ttl_secs,
        token_type: TokenType::Access,
    };

    let refresh_claims = Claims {
        sub: user_id,
        username: username.to_string(),
        iat: now,
        exp: now + config.jwt_refresh_ttl_secs,
        token_type: TokenType::Refresh,
    };

    let key = EncodingKey::from_secret(config.jwt_secret.as_bytes());

    let access_token = encode(&Header::default(), &access_claims, &key)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("JWT encode failed: {e}")))?;

    let refresh_token = encode(&Header::default(), &refresh_claims, &key)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("JWT encode failed: {e}")))?;

    Ok((access_token, refresh_token))
}

fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

async fn store_refresh_token(
    pool: &PgPool,
    user_id: Uuid,
    refresh_token: &str,
    ttl_secs: u64,
) -> AppResult<()> {
    let token_hash = hash_token(refresh_token);
    let expires_at = Utc::now() + Duration::seconds(ttl_secs as i64);
    AuthRepo::store_refresh_token(pool, user_id, &token_hash, expires_at).await
}
