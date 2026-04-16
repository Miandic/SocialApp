use axum::{
    extract::{Path, Query, State},
    Json,
};
use uuid::Uuid;
use validator::Validate;

use crate::errors::{AppError, AppResult};
use crate::middleware::auth::AuthUser;
use crate::modules::auth::models::UserRow;
use crate::state::AppState;

use super::models::*;
use super::repo::MessengerRepo;

/// Create a new chat (DM or group).
pub async fn create_chat(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateChatRequest>,
) -> AppResult<Json<ChatResponse>> {
    req.validate()
        .map_err(|e| AppError::Validation(e.to_string()))?;

    let is_group = req.is_group.unwrap_or(req.member_ids.len() > 1);

    // For DMs, check if chat already exists
    if !is_group && req.member_ids.len() == 1 {
        let other_id = req.member_ids[0];
        if let Some(existing) = MessengerRepo::find_dm_chat(&state.db, user.user_id, other_id).await? {
            let response = build_chat_response(&state, &existing).await?;
            return Ok(Json(response));
        }
    }

    if is_group && req.name.is_none() {
        return Err(AppError::BadRequest("Group chats require a name".into()));
    }

    let chat = MessengerRepo::create_chat(&state.db, req.name.as_deref(), is_group).await?;

    // Add creator as admin
    MessengerRepo::add_chat_member(&state.db, chat.id, user.user_id, "admin").await?;

    // Add other members
    for member_id in &req.member_ids {
        if *member_id != user.user_id {
            MessengerRepo::add_chat_member(&state.db, chat.id, *member_id, "member").await?;
        }
    }

    let response = build_chat_response(&state, &chat).await?;
    Ok(Json(response))
}

/// List all chats for the authenticated user.
pub async fn list_chats(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<ChatResponse>>> {
    let chats = MessengerRepo::get_user_chats(&state.db, user.user_id).await?;

    let mut responses = Vec::with_capacity(chats.len());
    for chat in &chats {
        responses.push(build_chat_response(&state, chat).await?);
    }
    Ok(Json(responses))
}

/// Get message history for a chat.
pub async fn get_messages(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chat_id): Path<Uuid>,
    Query(query): Query<MessagesQuery>,
) -> AppResult<Json<Vec<MessageResponse>>> {
    // Verify membership
    if !MessengerRepo::is_chat_member(&state.db, chat_id, user.user_id).await? {
        return Err(AppError::Forbidden);
    }

    let messages = MessengerRepo::get_messages(&state.db, chat_id, query.before, query.limit()).await?;

    let mut responses = Vec::with_capacity(messages.len());
    for msg in messages {
        let sender = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
            .bind(msg.sender_id)
            .fetch_one(&state.db)
            .await?;

        responses.push(MessageResponse {
            id: msg.id,
            chat_id: msg.chat_id,
            sender_id: msg.sender_id,
            sender_username: sender.username,
            encrypted_content: msg.encrypted_content,
            nonce: msg.nonce,
            message_type: msg.message_type,
            created_at: msg.created_at,
        });
    }
    Ok(Json(responses))
}

// ─── Helpers ───

async fn build_chat_response(state: &AppState, chat: &ChatRow) -> AppResult<ChatResponse> {
    let member_rows = MessengerRepo::get_chat_members(&state.db, chat.id).await?;

    let mut members = Vec::with_capacity(member_rows.len());
    for m in &member_rows {
        let user = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
            .bind(m.user_id)
            .fetch_one(&state.db)
            .await?;

        members.push(ChatMember {
            user_id: user.id,
            username: user.username,
            display_name: user.display_name,
            avatar_url: user.avatar_url,
            role: m.role.clone(),
        });
    }

    let last_message = match MessengerRepo::get_last_message(&state.db, chat.id).await? {
        Some(msg) => {
            let sender = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
                .bind(msg.sender_id)
                .fetch_one(&state.db)
                .await?;

            Some(MessageResponse {
                id: msg.id,
                chat_id: msg.chat_id,
                sender_id: msg.sender_id,
                sender_username: sender.username,
                encrypted_content: msg.encrypted_content,
                nonce: msg.nonce,
                message_type: msg.message_type,
                created_at: msg.created_at,
            })
        }
        None => None,
    };

    Ok(ChatResponse {
        id: chat.id,
        name: chat.name.clone(),
        is_group: chat.is_group,
        members,
        last_message,
        created_at: chat.created_at,
    })
}
