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
            "INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3) \
             ON CONFLICT DO NOTHING",
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

    /// Store a message with per-device ciphertexts in a single transaction.
    /// The `messages` row uses placeholder values; real ciphertexts live in
    /// `message_device_ciphertexts`.
    pub async fn store_message_e2ee(
        pool: &PgPool,
        chat_id: Uuid,
        sender_id: Uuid,
        sender_device_id: Uuid,
        message_type: &str,
        device_ciphertexts: &[DeviceCiphertext],
    ) -> AppResult<MessageRow> {
        let mut tx = pool.begin().await?;

        let msg = sqlx::query_as::<_, MessageRow>(
            r#"
            INSERT INTO messages (chat_id, sender_id, sender_device_id, message_type)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            "#,
        )
        .bind(chat_id)
        .bind(sender_id)
        .bind(sender_device_id)
        .bind(message_type)
        .fetch_one(&mut *tx)
        .await?;

        for dc in device_ciphertexts {
            sqlx::query(
                r#"
                INSERT INTO message_device_ciphertexts (message_id, device_id, encrypted_content, nonce)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (message_id, device_id) DO NOTHING
                "#,
            )
            .bind(msg.id)
            .bind(dc.device_id)
            .bind(&dc.encrypted_content)
            .bind(&dc.nonce)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        Ok(msg)
    }

    /// Fetch message history, attaching the device-specific ciphertext when `device_id`
    /// is supplied.
    pub async fn get_messages(
        pool: &PgPool,
        chat_id: Uuid,
        device_id: Option<Uuid>,
        before: Option<DateTime<Utc>>,
        limit: i64,
    ) -> AppResult<Vec<MessageRow>> {
        let before = before.unwrap_or_else(Utc::now);
        match device_id {
            Some(did) => {
                sqlx::query_as::<_, MessageRow>(
                    r#"
                    SELECT
                        m.id, m.chat_id, m.sender_id, m.sender_device_id, m.message_type, m.created_at,
                        COALESCE(mdc.encrypted_content, m.encrypted_content) AS encrypted_content,
                        COALESCE(mdc.nonce, m.nonce) AS nonce
                    FROM messages m
                    LEFT JOIN message_device_ciphertexts mdc
                        ON mdc.message_id = m.id AND mdc.device_id = $4
                    WHERE m.chat_id = $1 AND m.created_at < $2
                    ORDER BY m.created_at DESC
                    LIMIT $3
                    "#,
                )
                .bind(chat_id)
                .bind(before)
                .bind(limit)
                .bind(did)
                .fetch_all(pool)
                .await
                .map_err(Into::into)
            }
            None => {
                sqlx::query_as::<_, MessageRow>(
                    r#"
                    SELECT id, chat_id, sender_id, sender_device_id, encrypted_content,
                           nonce, message_type, created_at
                    FROM messages
                    WHERE chat_id = $1 AND created_at < $2
                    ORDER BY created_at DESC
                    LIMIT $3
                    "#,
                )
                .bind(chat_id)
                .bind(before)
                .bind(limit)
                .fetch_all(pool)
                .await
                .map_err(Into::into)
            }
        }
    }

    pub async fn update_last_read(
        pool: &PgPool,
        chat_id: Uuid,
        user_id: Uuid,
        message_id: Uuid,
    ) -> AppResult<()> {
        sqlx::query(
            r#"
            UPDATE chat_members
            SET last_read_message_id = $1,
                last_read_at = (SELECT created_at FROM messages WHERE id = $1)
            WHERE chat_id = $2 AND user_id = $3
            "#,
        )
        .bind(message_id)
        .bind(chat_id)
        .bind(user_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn get_unread_count(pool: &PgPool, chat_id: Uuid, user_id: Uuid) -> AppResult<i64> {
        let count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*) FROM messages
            WHERE chat_id = $1
              AND sender_id != $2
              AND created_at > COALESCE(
                  (SELECT last_read_at FROM chat_members WHERE chat_id = $1 AND user_id = $2),
                  '-infinity'::timestamptz
              )
            "#,
        )
        .bind(chat_id)
        .bind(user_id)
        .fetch_one(pool)
        .await?;
        Ok(count)
    }

    pub async fn delete_message(
        pool: &PgPool,
        chat_id: Uuid,
        message_id: Uuid,
        sender_id: Uuid,
    ) -> AppResult<bool> {
        let result = sqlx::query(
            "DELETE FROM messages WHERE id = $1 AND chat_id = $2 AND sender_id = $3",
        )
        .bind(message_id)
        .bind(chat_id)
        .bind(sender_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn get_last_message(
        pool: &PgPool,
        chat_id: Uuid,
        device_id: Option<Uuid>,
    ) -> AppResult<Option<MessageRow>> {
        let msg = match device_id {
            Some(did) => sqlx::query_as::<_, MessageRow>(
                r#"
                SELECT
                    m.id, m.chat_id, m.sender_id, m.sender_device_id, m.message_type, m.created_at,
                    COALESCE(mdc.encrypted_content, m.encrypted_content) AS encrypted_content,
                    COALESCE(mdc.nonce, m.nonce) AS nonce
                FROM messages m
                LEFT JOIN message_device_ciphertexts mdc
                    ON mdc.message_id = m.id AND mdc.device_id = $2
                WHERE m.chat_id = $1
                ORDER BY m.created_at DESC
                LIMIT 1
                "#,
            )
            .bind(chat_id)
            .bind(did)
            .fetch_optional(pool)
            .await?,
            None => sqlx::query_as::<_, MessageRow>(
                "SELECT id, chat_id, sender_id, sender_device_id, encrypted_content, \
                 nonce, message_type, created_at \
                 FROM messages WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 1",
            )
            .bind(chat_id)
            .fetch_optional(pool)
            .await?,
        };
        Ok(msg)
    }
}
