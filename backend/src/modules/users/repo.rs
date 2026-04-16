use sqlx::PgPool;
use uuid::Uuid;

use crate::errors::AppResult;
use crate::modules::auth::models::UserRow;

pub struct UsersRepo;

impl UsersRepo {
    pub async fn find_by_username(pool: &PgPool, username: &str) -> AppResult<Option<UserRow>> {
        let user = sqlx::query_as::<_, UserRow>(
            "SELECT * FROM users WHERE username = $1",
        )
        .bind(username)
        .fetch_optional(pool)
        .await?;
        Ok(user)
    }

    pub async fn update_profile(
        pool: &PgPool,
        user_id: Uuid,
        display_name: Option<&str>,
        bio: Option<&str>,
        avatar_url: Option<&str>,
    ) -> AppResult<UserRow> {
        let user = sqlx::query_as::<_, UserRow>(
            r#"
            UPDATE users
            SET display_name = COALESCE($2, display_name),
                bio = COALESCE($3, bio),
                avatar_url = COALESCE($4, avatar_url),
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
            "#,
        )
        .bind(user_id)
        .bind(display_name)
        .bind(bio)
        .bind(avatar_url)
        .fetch_one(pool)
        .await?;
        Ok(user)
    }

    pub async fn follow(pool: &PgPool, follower_id: Uuid, following_id: Uuid) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(follower_id)
        .bind(following_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn unfollow(pool: &PgPool, follower_id: Uuid, following_id: Uuid) -> AppResult<()> {
        sqlx::query("DELETE FROM follows WHERE follower_id = $1 AND following_id = $2")
            .bind(follower_id)
            .bind(following_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn is_following(pool: &PgPool, follower_id: Uuid, following_id: Uuid) -> AppResult<bool> {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2)",
        )
        .bind(follower_id)
        .bind(following_id)
        .fetch_one(pool)
        .await?;
        Ok(exists)
    }

    pub async fn followers_count(pool: &PgPool, user_id: Uuid) -> AppResult<i64> {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM follows WHERE following_id = $1",
        )
        .bind(user_id)
        .fetch_one(pool)
        .await?;
        Ok(count)
    }

    pub async fn following_count(pool: &PgPool, user_id: Uuid) -> AppResult<i64> {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM follows WHERE follower_id = $1",
        )
        .bind(user_id)
        .fetch_one(pool)
        .await?;
        Ok(count)
    }

    pub async fn get_followers(
        pool: &PgPool,
        user_id: Uuid,
        offset: i64,
        limit: i64,
    ) -> AppResult<Vec<UserRow>> {
        let users = sqlx::query_as::<_, UserRow>(
            r#"
            SELECT u.* FROM users u
            JOIN follows f ON f.follower_id = u.id
            WHERE f.following_id = $1
            ORDER BY f.created_at DESC
            OFFSET $2 LIMIT $3
            "#,
        )
        .bind(user_id)
        .bind(offset)
        .bind(limit)
        .fetch_all(pool)
        .await?;
        Ok(users)
    }

    pub async fn get_following(
        pool: &PgPool,
        user_id: Uuid,
        offset: i64,
        limit: i64,
    ) -> AppResult<Vec<UserRow>> {
        let users = sqlx::query_as::<_, UserRow>(
            r#"
            SELECT u.* FROM users u
            JOIN follows f ON f.following_id = u.id
            WHERE f.follower_id = $1
            ORDER BY f.created_at DESC
            OFFSET $2 LIMIT $3
            "#,
        )
        .bind(user_id)
        .bind(offset)
        .bind(limit)
        .fetch_all(pool)
        .await?;
        Ok(users)
    }
}
