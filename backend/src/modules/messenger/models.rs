use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use validator::Validate;

use crate::modules::devices::DeviceKeyBundle;

// ─── WebSocket protocol ───

/// One device's share of a message ciphertext. The sender encrypts the message
/// separately for every recipient device and includes all results here.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct DeviceCiphertext {
    pub device_id: Uuid,
    pub encrypted_content: String, // base64url AES-256-GCM ciphertext
    pub nonce: String,             // base64url 12-byte IV
}

/// Client → Server
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsClientMessage {
    /// Send an E2EE message. Includes one ciphertext entry per recipient device
    /// (and the sender's own devices) so each device receives its own decryptable copy.
    SendMessage {
        chat_id: Uuid,
        device_ciphertexts: Vec<DeviceCiphertext>,
        message_type: Option<String>,
    },
    /// Mark messages as read up to this message.
    MarkRead {
        chat_id: Uuid,
        message_id: Uuid,
    },
    /// Typing indicator.
    Typing {
        chat_id: Uuid,
    },
    /// Request key bundles for all verified devices of a user (before first message).
    RequestKeyBundles {
        user_id: Uuid,
    },
    /// Delete a message (sender only).
    DeleteMessage {
        chat_id: Uuid,
        message_id: Uuid,
    },
}

/// Server → Client
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsServerMessage {
    /// Incoming message for this specific device.
    NewMessage {
        id: Uuid,
        chat_id: Uuid,
        sender_id: Uuid,
        sender_device_id: Uuid,
        sender_username: String,
        /// Base64-encoded X25519 identity public key of the sending device.
        /// Recipients use this to derive (or re-derive) the shared session key
        /// without an extra round-trip to the REST API.
        sender_identity_key: String,
        encrypted_content: String,
        nonce: String,
        message_type: String,
        created_at: DateTime<Utc>,
    },
    /// Typing indicator from another participant.
    Typing {
        chat_id: Uuid,
        user_id: Uuid,
        username: String,
    },
    /// Read receipt from another participant.
    MessagesRead {
        chat_id: Uuid,
        user_id: Uuid,
        last_read_message_id: Uuid,
    },
    /// Key bundles for all devices of the requested user.
    KeyBundles {
        user_id: Uuid,
        devices: Vec<DeviceKeyBundle>,
    },
    /// A message was deleted.
    MessageDeleted {
        chat_id: Uuid,
        message_id: Uuid,
    },
    /// A new device on this account is waiting for approval.
    NewDevicePending {
        device_id: Uuid,
        device_name: String,
    },
    /// A device has been approved by another device on this account.
    DeviceApproved {
        device_id: Uuid,
    },
    /// An encrypted history sync package is available for this device to fetch.
    HistorySyncReady {
        sender_device_id: Uuid,
    },
    /// Server-side error.
    Error {
        message: String,
    },
}

// ─── REST API models ───

#[derive(Debug, Deserialize, Validate)]
pub struct CreateChatRequest {
    #[validate(length(min = 1, message = "At least one member required"))]
    pub member_ids: Vec<Uuid>,
    pub name: Option<String>,
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
    pub unread_count: i64,
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
    pub sender_device_id: Option<Uuid>,
    pub sender_username: String,
    pub encrypted_content: String,
    pub nonce: String,
    pub message_type: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct MessagesQuery {
    pub before: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
    /// Device ID — used to pick the device-specific ciphertext from the DB.
    pub device_id: Option<Uuid>,
}

impl MessagesQuery {
    pub fn limit(&self) -> i64 {
        self.limit.unwrap_or(50).clamp(1, 100)
    }
}

// ─── DB rows ───

#[derive(Debug, sqlx::FromRow)]
pub struct ChatRow {
    pub id: Uuid,
    pub name: Option<String>,
    pub is_group: bool,
    pub created_at: DateTime<Utc>,
}

#[allow(dead_code)]
#[derive(Debug, sqlx::FromRow)]
pub struct ChatMemberRow {
    pub chat_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
    pub joined_at: DateTime<Utc>,
    pub last_read_message_id: Option<Uuid>,
    pub last_read_at: Option<DateTime<Utc>>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct MessageRow {
    pub id: Uuid,
    pub chat_id: Uuid,
    pub sender_id: Uuid,
    pub sender_device_id: Option<Uuid>,
    pub encrypted_content: String,
    pub nonce: String,
    pub message_type: String,
    pub created_at: DateTime<Utc>,
}
