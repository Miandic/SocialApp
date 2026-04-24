use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use validator::Validate;

// ─── REST request / response ───

#[derive(Debug, Deserialize, Validate)]
pub struct RegisterDeviceRequest {
    #[validate(length(min = 1, max = 100))]
    pub device_name: String,
    pub identity_key: String,
    pub signed_pre_key: String,
    pub signed_pre_key_signature: String,
    pub one_time_pre_keys: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RegisterDeviceResponse {
    pub device_id: Uuid,
    pub is_verified: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct DeviceResponse {
    pub id: Uuid,
    pub device_name: String,
    pub is_verified: bool,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
}

/// Key bundle for one device — sent to callers who need to encrypt a message.
#[derive(Debug, Serialize, Clone)]
pub struct DeviceKeyBundle {
    pub device_id: Uuid,
    pub identity_key: String,
    pub signed_pre_key: String,
    pub signed_pre_key_signature: String,
    pub one_time_pre_key: Option<String>,
}

#[derive(Debug, Deserialize, Validate)]
pub struct UploadPreKeysRequest {
    pub one_time_pre_keys: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct SendHistoryRequest {
    pub sender_device_id: Uuid,
    pub recipient_device_id: Uuid,
    pub ciphertext: String,
    pub nonce: String,
}

#[derive(Debug, Serialize)]
pub struct HistoryPackageResponse {
    pub id: Uuid,
    pub sender_device_id: Uuid,
    pub ciphertext: String,
    pub nonce: String,
    pub created_at: DateTime<Utc>,
}

// ─── DB rows ───

#[allow(dead_code)]
#[derive(Debug, sqlx::FromRow)]
pub struct DeviceRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub device_name: String,
    pub identity_key: String,
    pub signed_pre_key: String,
    pub signed_pre_key_signature: String,
    pub is_verified: bool,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
}

#[allow(dead_code)]
#[derive(Debug, sqlx::FromRow)]
pub struct HistoryPackageRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub sender_device_id: Uuid,
    pub recipient_device_id: Uuid,
    pub ciphertext: String,
    pub nonce: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}
