use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Typed notification categories — used for serialization and future filtered queries.
/// The Display impl produces the snake_case string stored in the DB.
#[allow(dead_code)] // variants will be used when backend triggers notifications on events
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum NotificationType {
    Follow,
    Like,
    Repost,
    Mention,
    Message,
}

impl std::fmt::Display for NotificationType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NotificationType::Follow => write!(f, "follow"),
            NotificationType::Like => write!(f, "like"),
            NotificationType::Repost => write!(f, "repost"),
            NotificationType::Mention => write!(f, "mention"),
            NotificationType::Message => write!(f, "message"),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct NotificationResponse {
    pub id: Uuid,
    pub notification_type: String,
    pub data: serde_json::Value,
    pub is_read: bool,
    pub created_at: DateTime<Utc>,
}

/// All columns required for sqlx to deserialize the full DB row.
#[allow(dead_code)]
#[derive(Debug, sqlx::FromRow)]
pub struct NotificationRow {
    pub id: Uuid,
    pub user_id: Uuid, // owner — checked in handlers, not re-read after query
    pub notification_type: String,
    pub data: serde_json::Value,
    pub is_read: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct NotificationsQuery {
    pub offset: Option<i64>,
    pub limit: Option<i64>,
    pub unread_only: Option<bool>,
}

impl NotificationsQuery {
    pub fn offset(&self) -> i64 {
        self.offset.unwrap_or(0).max(0)
    }
    pub fn limit(&self) -> i64 {
        self.limit.unwrap_or(20).clamp(1, 50)
    }
}
