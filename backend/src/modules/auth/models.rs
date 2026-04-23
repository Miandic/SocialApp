use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use validator::Validate;

// ─── Requests ───

#[derive(Debug, Deserialize, Validate)]
pub struct RegisterRequest {
    #[validate(length(min = 3, max = 30, message = "Username must be 3-30 characters"))]
    #[validate(regex(path = *USERNAME_RE, message = "Username: only letters, numbers, underscores"))]
    pub username: String,

    #[validate(email(message = "Invalid email address"))]
    pub email: String,

    #[validate(length(min = 8, max = 128, message = "Password must be 8-128 characters"))]
    pub password: String,

    #[validate(length(max = 100))]
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub login: String, // username or email
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

// ─── Responses ───

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub user: UserInfo,
}

#[derive(Debug, Serialize)]
pub struct UserInfo {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub created_at: DateTime<Utc>,
}

// ─── DB row ───

// sqlx::FromRow structs must match the full DB schema; not all fields are read
// in application code but they must be present for the query macro to compile.
#[allow(dead_code)]
#[derive(Debug, sqlx::FromRow)]
pub struct UserRow {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub password_hash: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
    pub is_verified: bool, // reserved — email verification not yet implemented
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<&UserRow> for UserInfo {
    fn from(row: &UserRow) -> Self {
        UserInfo {
            id: row.id,
            username: row.username.clone(),
            email: row.email.clone(),
            display_name: row.display_name.clone(),
            avatar_url: row.avatar_url.clone(),
            created_at: row.created_at,
        }
    }
}

// ─── Refresh token row ───

#[allow(dead_code)] // fields needed for full row deserialization; validation happens via SQL WHERE
#[derive(Debug, sqlx::FromRow)]
pub struct RefreshTokenRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub token_hash: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

use std::sync::LazyLock;
use regex::Regex;

static USERNAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-zA-Z0-9_]+$").expect("USERNAME_RE is a hardcoded valid regex")
});
