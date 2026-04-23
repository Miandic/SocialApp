use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::errors::AppResult;
use super::models::PostRow;

pub struct PostsRepo;

impl PostsRepo {
    pub async fn create(
        pool: &PgPool,
        author_id: Uuid,
        content: &str,
        media_urls: &[String],
    ) -> AppResult<PostRow> {
        let post = sqlx::query_as::<_, PostRow>(
            r#"
            INSERT INTO posts (author_id, content, media_urls)
            VALUES ($1, $2, $3)
            RETURNING *
            "#,
        )
        .bind(author_id)
        .bind(content)
        .bind(media_urls)
        .fetch_one(pool)
        .await?;
        Ok(post)
    }

    pub async fn find_by_id(pool: &PgPool, id: Uuid) -> AppResult<Option<PostRow>> {
        let post = sqlx::query_as::<_, PostRow>("SELECT * FROM posts WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
        Ok(post)
    }

    pub async fn delete(pool: &PgPool, id: Uuid, author_id: Uuid) -> AppResult<bool> {
        let result = sqlx::query("DELETE FROM posts WHERE id = $1 AND author_id = $2")
            .bind(id)
            .bind(author_id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn like(pool: &PgPool, user_id: Uuid, post_id: Uuid) -> AppResult<()> {
        let mut tx = pool.begin().await?;

        sqlx::query(
            "INSERT INTO post_likes (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(user_id)
        .bind(post_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "UPDATE posts SET like_count = (SELECT COUNT(*) FROM post_likes WHERE post_id = $1) WHERE id = $1",
        )
        .bind(post_id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }

    pub async fn unlike(pool: &PgPool, user_id: Uuid, post_id: Uuid) -> AppResult<()> {
        let mut tx = pool.begin().await?;

        sqlx::query("DELETE FROM post_likes WHERE user_id = $1 AND post_id = $2")
            .bind(user_id)
            .bind(post_id)
            .execute(&mut *tx)
            .await?;

        sqlx::query(
            "UPDATE posts SET like_count = (SELECT COUNT(*) FROM post_likes WHERE post_id = $1) WHERE id = $1",
        )
        .bind(post_id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }

    pub async fn is_liked(pool: &PgPool, user_id: Uuid, post_id: Uuid) -> AppResult<bool> {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM post_likes WHERE user_id = $1 AND post_id = $2)",
        )
        .bind(user_id)
        .bind(post_id)
        .fetch_one(pool)
        .await?;
        Ok(exists)
    }

    /// Chronological feed: own posts + posts from followed users, cursor-based pagination.
    /// The OR condition is wrapped in parens so the AND created_at < $2 applies to both
    /// branches — without parens, SQL operator precedence (AND > OR) would skip the
    /// date filter for followed-user posts and break pagination.
    pub async fn feed(
        pool: &PgPool,
        user_id: Uuid,
        before: Option<DateTime<Utc>>,
        limit: i64,
    ) -> AppResult<Vec<PostRow>> {
        let before = before.unwrap_or_else(Utc::now);
        let posts = sqlx::query_as::<_, PostRow>(
            r#"
            SELECT p.* FROM posts p
            WHERE (p.author_id IN (SELECT following_id FROM follows WHERE follower_id = $1)
                OR p.author_id = $1)
              AND p.created_at < $2
            ORDER BY p.created_at DESC
            LIMIT $3
            "#,
        )
        .bind(user_id)
        .bind(before)
        .bind(limit)
        .fetch_all(pool)
        .await?;
        Ok(posts)
    }

    /// Posts by a specific user — will back the `/users/{username}/posts` endpoint.
    #[allow(dead_code)]
    pub async fn user_posts(
        pool: &PgPool,
        author_id: Uuid,
        before: Option<DateTime<Utc>>,
        limit: i64,
    ) -> AppResult<Vec<PostRow>> {
        let before = before.unwrap_or_else(Utc::now);
        let posts = sqlx::query_as::<_, PostRow>(
            r#"
            SELECT * FROM posts
            WHERE author_id = $1 AND created_at < $2
            ORDER BY created_at DESC
            LIMIT $3
            "#,
        )
        .bind(author_id)
        .bind(before)
        .bind(limit)
        .fetch_all(pool)
        .await?;
        Ok(posts)
    }
}
