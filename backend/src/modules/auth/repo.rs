use sqlx::PgPool;
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use super::models::{UserRow, RefreshTokenRow};

pub struct AuthRepo;

impl AuthRepo {
    pub async fn create_user(
        pool: &PgPool,
        username: &str,
        email: &str,
        password_hash: &str,
        display_name: Option<&str>,
    ) -> AppResult<UserRow> {
        sqlx::query_as::<_, UserRow>(
            r#"
            INSERT INTO users (username, email, password_hash, display_name)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            "#,
        )
        .bind(username)
        .bind(email)
        .bind(password_hash)
        .bind(display_name)
        .fetch_one(pool)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(db_err) if db_err.constraint() == Some("users_username_key") => {
                AppError::Conflict("Username already taken".into())
            }
            sqlx::Error::Database(db_err) if db_err.constraint() == Some("users_email_key") => {
                AppError::Conflict("Email already registered".into())
            }
            _ => AppError::Database(e),
        })
    }

    pub async fn find_by_login(pool: &PgPool, login: &str) -> AppResult<Option<UserRow>> {
        let user = sqlx::query_as::<_, UserRow>(
            "SELECT * FROM users WHERE username = $1 OR email = $1",
        )
        .bind(login)
        .fetch_optional(pool)
        .await?;

        Ok(user)
    }

    pub async fn find_by_id(pool: &PgPool, id: Uuid) -> AppResult<Option<UserRow>> {
        let user = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?;

        Ok(user)
    }

    pub async fn store_refresh_token(
        pool: &PgPool,
        user_id: Uuid,
        token_hash: &str,
        expires_at: chrono::DateTime<chrono::Utc>,
    ) -> AppResult<()> {
        sqlx::query(
            r#"
            INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
            VALUES ($1, $2, $3)
            "#,
        )
        .bind(user_id)
        .bind(token_hash)
        .bind(expires_at)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn find_refresh_token(
        pool: &PgPool,
        token_hash: &str,
    ) -> AppResult<Option<RefreshTokenRow>> {
        let row = sqlx::query_as::<_, RefreshTokenRow>(
            "SELECT * FROM refresh_tokens WHERE token_hash = $1 AND expires_at > NOW()",
        )
        .bind(token_hash)
        .fetch_optional(pool)
        .await?;

        Ok(row)
    }

    pub async fn delete_refresh_token(pool: &PgPool, token_hash: &str) -> AppResult<()> {
        sqlx::query("DELETE FROM refresh_tokens WHERE token_hash = $1")
            .bind(token_hash)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn delete_user_refresh_tokens(pool: &PgPool, user_id: Uuid) -> AppResult<()> {
        sqlx::query("DELETE FROM refresh_tokens WHERE user_id = $1")
            .bind(user_id)
            .execute(pool)
            .await?;
        Ok(())
    }
}
