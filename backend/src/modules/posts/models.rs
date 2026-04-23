use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use validator::Validate;

#[derive(Debug, Deserialize, Validate)]
pub struct CreatePostRequest {
    #[validate(length(min = 1, max = 5000, message = "Post content must be 1-5000 characters"))]
    pub content: String,
    // Validated in the handler: each URL is checked individually, max 20 items.
    pub media_urls: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct PostResponse {
    pub id: Uuid,
    pub author: PostAuthor,
    pub content: String,
    pub media_urls: Vec<String>,
    pub like_count: i32,
    pub repost_count: i32, // reserved — repost functionality not yet implemented
    pub is_liked: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct PostAuthor {
    pub id: Uuid,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[allow(dead_code)] // updated_at needed for full row deserialization; not read in handlers
#[derive(Debug, sqlx::FromRow)]
pub struct PostRow {
    pub id: Uuid,
    pub author_id: Uuid,
    pub content: String,
    pub media_urls: Option<Vec<String>>,
    pub like_count: i32,
    pub repost_count: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct FeedParams {
    pub before: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
}

impl FeedParams {
    pub fn limit(&self) -> i64 {
        self.limit.unwrap_or(20).clamp(1, 50)
    }
}
