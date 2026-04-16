use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::errors::AppResult;
use super::models::*;

pub struct MessengerRepo;

impl MessengerRepo {
    // ─── Chats ───

    pub async fn create_chat(
        pool: &PgPool,
        name: Option<&str>,
        is_group: bool,
    ) -> AppResult<ChatRow> {
        let chat = sqlx::query_as::<_, ChatRow>(
            "INSERT INTO chats (name, is_group) VALUES ($1, $2) RETURNING *",
        )
        .bind(name)
        .bind(is_group)
        .fetch_one(pool)
        .await?;
        Ok(chat)
    }

    pub async fn add_chat_member(
        pool: &PgPool,
        chat_id: Uuid,
        user_id: Uuid,
        role: &str,
    ) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        )
        .bind(chat_id)
        .bind(user_id)
        .bind(role)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn get_user_chats(pool: &PgPool, user_id: Uuid) -> AppResult<Vec<ChatRow>> {
        let chats = sqlx::query_as::<_, ChatRow>(
            r#"
            SELECT c.* FROM chats c
            JOIN chat_members cm ON cm.chat_id = c.id
            WHERE cm.user_id = $1
            ORDER BY c.created_at DESC
            "#,
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?;
        Ok(chats)
    }

    pub async fn get_chat_members(pool: &PgPool, chat_id: Uuid) -> AppResult<Vec<ChatMemberRow>> {
        let members = sqlx::query_as::<_, ChatMemberRow>(
            "SELECT * FROM chat_members WHERE chat_id = $1",
        )
        .bind(chat_id)
        .fetch_all(pool)
        .await?;
        Ok(members)
    }

    pub async fn is_chat_member(pool: &PgPool, chat_id: Uuid, user_id: Uuid) -> AppResult<bool> {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2)",
        )
        .bind(chat_id)
        .bind(user_id)
        .fetch_one(pool)
        .await?;
        Ok(exists)
    }

    /// Find existing 1-on-1 chat between two users.
    pub async fn find_dm_chat(
        pool: &PgPool,
        user_a: Uuid,
        user_b: Uuid,
    ) -> AppResult<Option<ChatRow>> {
        let chat = sqlx::query_as::<_, ChatRow>(
            r#"
            SELECT c.* FROM chats c
            WHERE c.is_group = FALSE
              AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = $1)
              AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = $2)
            "#,
        )
        .bind(user_a)
        .bind(user_b)
        .fetch_optional(pool)
        .await?;
        Ok(chat)
    }

    // ─── Messages ───

    pub async fn store_message(
        pool: &PgPool,
        chat_id: Uuid,
        sender_id: Uuid,
        encrypted_content: &str,
        nonce: &str,
        message_type: &str,
    ) -> AppResult<MessageRow> {
        let msg = sqlx::query_as::<_, MessageRow>(
            r#"
            INSERT INTO messages (chat_id, sender_id, encrypted_content, nonce, message_type)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            "#,
        )
        .bind(chat_id)
        .bind(sender_id)
        .bind(encrypted_content)
        .bind(nonce)
        .bind(message_type)
        .fetch_one(pool)
        .await?;
        Ok(msg)
    }

    pub async fn get_messages(
        pool: &PgPool,
        chat_id: Uuid,
        before: Option<DateTime<Utc>>,
        limit: i64,
    ) -> AppResult<Vec<MessageRow>> {
        let before = before.unwrap_or_else(Utc::now);
        let messages = sqlx::query_as::<_, MessageRow>(
            r#"
            SELECT * FROM messages
            WHERE chat_id = $1 AND created_at < $2
            ORDER BY created_at DESC
            LIMIT $3
            "#,
        )
        .bind(chat_id)
        .bind(before)
        .bind(limit)
        .fetch_all(pool)
        .await?;
        Ok(messages)
    }

    pub async fn get_last_message(pool: &PgPool, chat_id: Uuid) -> AppResult<Option<MessageRow>> {
        let msg = sqlx::query_as::<_, MessageRow>(
            "SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 1",
        )
        .bind(chat_id)
        .fetch_optional(pool)
        .await?;
        Ok(msg)
    }

    // ─── E2E Keys ───

    pub async fn upsert_key_bundle(
        pool: &PgPool,
        user_id: Uuid,
        identity_key: &str,
        signed_pre_key: &str,
        signature: &str,
    ) -> AppResult<()> {
        sqlx::query(
            r#"
            INSERT INTO user_key_bundles (user_id, identity_key, signed_pre_key, signed_pre_key_signature)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (user_id) DO UPDATE
            SET identity_key = $2, signed_pre_key = $3, signed_pre_key_signature = $4, updated_at = NOW()
            "#,
        )
        .bind(user_id)
        .bind(identity_key)
        .bind(signed_pre_key)
        .bind(signature)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn add_one_time_pre_keys(
        pool: &PgPool,
        user_id: Uuid,
        keys: &[String],
    ) -> AppResult<()> {
        for key in keys {
            sqlx::query(
                "INSERT INTO one_time_pre_keys (user_id, key_data) VALUES ($1, $2)",
            )
            .bind(user_id)
            .bind(key)
            .execute(pool)
            .await?;
        }
        Ok(())
    }

    pub async fn get_key_bundle(pool: &PgPool, user_id: Uuid) -> AppResult<Option<KeyBundleRow>> {
        let bundle = sqlx::query_as::<_, KeyBundleRow>(
            "SELECT * FROM user_key_bundles WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
        Ok(bundle)
    }

    /// Claim one unused one-time pre-key (and mark it used).
    pub async fn claim_one_time_pre_key(
        pool: &PgPool,
        user_id: Uuid,
    ) -> AppResult<Option<String>> {
        let key: Option<(String,)> = sqlx::query_as(
            r#"
            UPDATE one_time_pre_keys
            SET used = TRUE
            WHERE id = (
                SELECT id FROM one_time_pre_keys
                WHERE user_id = $1 AND used = FALSE
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            )
            RETURNING key_data
            "#,
        )
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
        Ok(key.map(|(k,)| k))
    }
}
