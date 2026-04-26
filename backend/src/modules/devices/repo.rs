use sqlx::PgPool;
use uuid::Uuid;

use crate::errors::AppResult;

use super::models::*;

pub struct DevicesRepo;

impl DevicesRepo {
    pub async fn create_device(
        pool: &PgPool,
        user_id: Uuid,
        device_name: &str,
        identity_key: &str,
        signed_pre_key: &str,
        signed_pre_key_signature: &str,
        is_verified: bool,
    ) -> AppResult<DeviceRow> {
        let device = sqlx::query_as::<_, DeviceRow>(
            r#"
            INSERT INTO user_devices
                (user_id, device_name, identity_key, signed_pre_key, signed_pre_key_signature, is_verified)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            "#,
        )
        .bind(user_id)
        .bind(device_name)
        .bind(identity_key)
        .bind(signed_pre_key)
        .bind(signed_pre_key_signature)
        .bind(is_verified)
        .fetch_one(pool)
        .await?;
        Ok(device)
    }

    /// Returns true if the user already has a *verified* device with this exact
    /// identity_key public key.  Used to auto-verify recovery-code re-registrations.
    pub async fn has_verified_device_with_key(
        pool: &PgPool,
        user_id: Uuid,
        identity_key: &str,
    ) -> AppResult<bool> {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM user_devices \
             WHERE user_id = $1 AND identity_key = $2 AND is_verified = TRUE)",
        )
        .bind(user_id)
        .bind(identity_key)
        .fetch_one(pool)
        .await?;
        Ok(exists)
    }

    pub async fn user_has_verified_devices(pool: &PgPool, user_id: Uuid) -> AppResult<bool> {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM user_devices WHERE user_id = $1 AND is_verified = TRUE)",
        )
        .bind(user_id)
        .fetch_one(pool)
        .await?;
        Ok(exists)
    }

    pub async fn list_devices(pool: &PgPool, user_id: Uuid) -> AppResult<Vec<DeviceRow>> {
        let devices = sqlx::query_as::<_, DeviceRow>(
            "SELECT * FROM user_devices WHERE user_id = $1 ORDER BY created_at ASC",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?;
        Ok(devices)
    }

    /// Mark a device as verified. Returns false if device was not found or already verified.
    pub async fn approve_device(
        pool: &PgPool,
        user_id: Uuid,
        device_id: Uuid,
    ) -> AppResult<bool> {
        let result = sqlx::query(
            "UPDATE user_devices SET is_verified = TRUE \
             WHERE id = $1 AND user_id = $2 AND is_verified = FALSE",
        )
        .bind(device_id)
        .bind(user_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn delete_device(
        pool: &PgPool,
        user_id: Uuid,
        device_id: Uuid,
    ) -> AppResult<bool> {
        let result = sqlx::query(
            "DELETE FROM user_devices WHERE id = $1 AND user_id = $2",
        )
        .bind(device_id)
        .bind(user_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn device_belongs_to_user(
        pool: &PgPool,
        device_id: Uuid,
        user_id: Uuid,
    ) -> AppResult<bool> {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM user_devices WHERE id = $1 AND user_id = $2)",
        )
        .bind(device_id)
        .bind(user_id)
        .fetch_one(pool)
        .await?;
        Ok(exists)
    }

    pub async fn add_one_time_pre_keys(
        pool: &PgPool,
        device_id: Uuid,
        keys: &[String],
    ) -> AppResult<()> {
        for key in keys {
            sqlx::query(
                "INSERT INTO one_time_pre_keys (device_id, key_data) VALUES ($1, $2)",
            )
            .bind(device_id)
            .bind(key)
            .execute(pool)
            .await?;
        }
        Ok(())
    }

    /// Fetch key bundles for all verified devices of a user, claiming one OTPK per device.
    pub async fn get_user_device_bundles(
        pool: &PgPool,
        user_id: Uuid,
    ) -> AppResult<Vec<DeviceKeyBundle>> {
        let devices = sqlx::query_as::<_, DeviceRow>(
            "SELECT * FROM user_devices WHERE user_id = $1 AND is_verified = TRUE ORDER BY created_at ASC",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?;

        let mut bundles = Vec::with_capacity(devices.len());
        for device in devices {
            let otpk = Self::claim_one_time_pre_key(pool, device.id).await?;
            bundles.push(DeviceKeyBundle {
                device_id: device.id,
                identity_key: device.identity_key,
                signed_pre_key: device.signed_pre_key,
                signed_pre_key_signature: device.signed_pre_key_signature,
                one_time_pre_key: otpk,
            });
        }
        Ok(bundles)
    }

    pub async fn claim_one_time_pre_key(
        pool: &PgPool,
        device_id: Uuid,
    ) -> AppResult<Option<String>> {
        let key: Option<(String,)> = sqlx::query_as(
            r#"
            UPDATE one_time_pre_keys
            SET used = TRUE
            WHERE id = (
                SELECT id FROM one_time_pre_keys
                WHERE device_id = $1 AND used = FALSE
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            )
            RETURNING key_data
            "#,
        )
        .bind(device_id)
        .fetch_optional(pool)
        .await?;
        Ok(key.map(|(k,)| k))
    }

    /// Store a history sync package, replacing any existing one for that recipient device.
    pub async fn store_history_package(
        pool: &PgPool,
        user_id: Uuid,
        sender_device_id: Uuid,
        recipient_device_id: Uuid,
        ciphertext: &str,
        nonce: &str,
    ) -> AppResult<()> {
        sqlx::query(
            r#"
            INSERT INTO history_sync_packages
                (user_id, sender_device_id, recipient_device_id, ciphertext, nonce)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (recipient_device_id) DO UPDATE
            SET sender_device_id = EXCLUDED.sender_device_id,
                ciphertext = EXCLUDED.ciphertext,
                nonce = EXCLUDED.nonce,
                created_at = NOW(),
                expires_at = NOW() + INTERVAL '7 days'
            "#,
        )
        .bind(user_id)
        .bind(sender_device_id)
        .bind(recipient_device_id)
        .bind(ciphertext)
        .bind(nonce)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn get_history_package(
        pool: &PgPool,
        recipient_device_id: Uuid,
    ) -> AppResult<Option<HistoryPackageRow>> {
        let pkg = sqlx::query_as::<_, HistoryPackageRow>(
            "SELECT * FROM history_sync_packages \
             WHERE recipient_device_id = $1 AND expires_at > NOW()",
        )
        .bind(recipient_device_id)
        .fetch_optional(pool)
        .await?;
        Ok(pkg)
    }

    pub async fn delete_history_package(
        pool: &PgPool,
        recipient_device_id: Uuid,
    ) -> AppResult<()> {
        sqlx::query(
            "DELETE FROM history_sync_packages WHERE recipient_device_id = $1",
        )
        .bind(recipient_device_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Fetch the raw identity public key for a single device.
    pub async fn get_device_identity_key(pool: &PgPool, device_id: Uuid) -> AppResult<String> {
        let key: String = sqlx::query_scalar(
            "SELECT identity_key FROM user_devices WHERE id = $1",
        )
        .bind(device_id)
        .fetch_one(pool)
        .await?;
        Ok(key)
    }

    pub async fn touch_last_seen(pool: &PgPool, device_id: Uuid) -> AppResult<()> {
        sqlx::query("UPDATE user_devices SET last_seen_at = NOW() WHERE id = $1")
            .bind(device_id)
            .execute(pool)
            .await?;
        Ok(())
    }
}
