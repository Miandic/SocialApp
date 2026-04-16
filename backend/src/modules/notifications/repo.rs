use sqlx::PgPool;
use uuid::Uuid;

use crate::errors::AppResult;
use super::models::NotificationRow;

pub struct NotificationsRepo;

impl NotificationsRepo {
    pub async fn create(
        pool: &PgPool,
        user_id: Uuid,
        notification_type: &str,
        data: &serde_json::Value,
    ) -> AppResult<NotificationRow> {
        let n = sqlx::query_as::<_, NotificationRow>(
            r#"
            INSERT INTO notifications (user_id, notification_type, data)
            VALUES ($1, $2, $3)
            RETURNING *
            "#,
        )
        .bind(user_id)
        .bind(notification_type)
        .bind(data)
        .fetch_one(pool)
        .await?;
        Ok(n)
    }

    pub async fn get_for_user(
        pool: &PgPool,
        user_id: Uuid,
        unread_only: bool,
        offset: i64,
        limit: i64,
    ) -> AppResult<Vec<NotificationRow>> {
        let notifications = if unread_only {
            sqlx::query_as::<_, NotificationRow>(
                r#"
                SELECT * FROM notifications
                WHERE user_id = $1 AND is_read = FALSE
                ORDER BY created_at DESC
                OFFSET $2 LIMIT $3
                "#,
            )
            .bind(user_id)
            .bind(offset)
            .bind(limit)
            .fetch_all(pool)
            .await?
        } else {
            sqlx::query_as::<_, NotificationRow>(
                r#"
                SELECT * FROM notifications
                WHERE user_id = $1
                ORDER BY created_at DESC
                OFFSET $2 LIMIT $3
                "#,
            )
            .bind(user_id)
            .bind(offset)
            .bind(limit)
            .fetch_all(pool)
            .await?
        };
        Ok(notifications)
    }

    pub async fn mark_read(pool: &PgPool, id: Uuid, user_id: Uuid) -> AppResult<()> {
        sqlx::query("UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn mark_all_read(pool: &PgPool, user_id: Uuid) -> AppResult<()> {
        sqlx::query("UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE")
            .bind(user_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn unread_count(pool: &PgPool, user_id: Uuid) -> AppResult<i64> {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = FALSE",
        )
        .bind(user_id)
        .fetch_one(pool)
        .await?;
        Ok(count)
    }
}
