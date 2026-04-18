use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use validator::Validate;

// ─── WebSocket protocol messages ───

/// Client → Server messages
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsClientMessage {
    /// Send an E2E encrypted message
    SendMessage {
        chat_id: Uuid,
        encrypted_content: String, // base64-encoded ciphertext
        nonce: String,             // base64-encoded nonce
        message_type: Option<String>,
    },
    /// Mark messages as read
    MarkRead {
        chat_id: Uuid,
        message_id: Uuid,
    },
    /// Typing indicator
    Typing {
        chat_id: Uuid,
    },
    /// Upload pre-keys for E2E key exchange
    UploadPreKeys {
        identity_key: String,
        signed_pre_key: String,
        signed_pre_key_signature: String,
        one_time_pre_keys: Vec<String>,
    },
    /// Request someone's key bundle for starting an E2E session
    RequestKeyBundle {
        user_id: Uuid,
    },
    /// Delete a message (only sender can delete their own)
    DeleteMessage {
        chat_id: Uuid,
        message_id: Uuid,
    },
}

/// Server → Client messages
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsServerMessage {
    /// New message received
    NewMessage {
        id: Uuid,
        chat_id: Uuid,
        sender_id: Uuid,
        sender_username: String,
        encrypted_content: String,
        nonce: String,
        message_type: String,
        created_at: DateTime<Utc>,
    },
    /// Someone is typing
    Typing {
        chat_id: Uuid,
        user_id: Uuid,
        username: String,
    },
    /// Messages read receipt
    MessagesRead {
        chat_id: Uuid,
        user_id: Uuid,
        last_read_message_id: Uuid,
    },
    /// Key bundle response
    KeyBundle {
        user_id: Uuid,
        identity_key: String,
        signed_pre_key: String,
        signed_pre_key_signature: String,
        one_time_pre_key: Option<String>,
    },
    /// A message was deleted
    MessageDeleted {
        chat_id: Uuid,
        message_id: Uuid,
    },
    /// Error
    Error {
        message: String,
    },
}

// ─── REST API models ───

#[derive(Debug, Deserialize, Validate)]
pub struct CreateChatRequest {
    #[validate(length(min = 1, message = "At least one member required"))]
    pub member_ids: Vec<Uuid>,
    pub name: Option<String>, // required for group chats
    pub is_group: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct ChatResponse {
    pub id: Uuid,
    pub name: Option<String>,
    pub is_group: bool,
    pub members: Vec<ChatMember>,
    pub last_message: Option<MessageResponse>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct ChatMember {
    pub user_id: Uuid,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub role: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct MessageResponse {
    pub id: Uuid,
    pub chat_id: Uuid,
    pub sender_id: Uuid,
    pub sender_username: String,
    pub encrypted_content: String,
    pub nonce: String,
    pub message_type: String,
    pub created_at: DateTime<Utc>,
}

// ─── DB rows ───

#[derive(Debug, sqlx::FromRow)]
pub struct ChatRow {
    pub id: Uuid,
    pub name: Option<String>,
    pub is_group: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct ChatMemberRow {
    pub chat_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
    pub joined_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct MessageRow {
    pub id: Uuid,
    pub chat_id: Uuid,
    pub sender_id: Uuid,
    pub encrypted_content: String,
    pub nonce: String,
    pub message_type: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct KeyBundleRow {
    pub user_id: Uuid,
    pub identity_key: String,
    pub signed_pre_key: String,
    pub signed_pre_key_signature: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct OneTimePreKeyRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub key_data: String,
    pub used: bool,
}

#[derive(Debug, Deserialize)]
pub struct MessagesQuery {
    pub before: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
}

impl MessagesQuery {
    pub fn limit(&self) -> i64 {
        self.limit.unwrap_or(50).clamp(1, 100)
    }
}
