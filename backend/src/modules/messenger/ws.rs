use axum::{
    extract::{
        ws::{Message, WebSocket},
        Query, State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use jsonwebtoken::{decode, DecodingKey, Validation};
use serde::Deserialize;
use uuid::Uuid;

use crate::middleware::auth::{Claims, TokenType};
use crate::state::AppState;

use super::hub::ConnectionHub;
use super::models::*;
use super::repo::MessengerRepo;

#[derive(Debug, Deserialize)]
pub struct WsAuthQuery {
    pub token: String,
}

/// WebSocket upgrade handler.
/// Browser WebSocket API cannot send custom headers, so we accept the JWT
/// via query parameter: `/api/messenger/ws?token=<access_token>`
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<WsAuthQuery>,
) -> Result<impl IntoResponse, crate::errors::AppError> {
    // Validate the token from query param
    let claims = decode::<Claims>(
        &query.token,
        &DecodingKey::from_secret(state.config.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|e| crate::errors::AppError::Unauthorized(format!("Invalid token: {e}")))?
    .claims;

    if claims.token_type != TokenType::Access {
        return Err(crate::errors::AppError::Unauthorized(
            "Expected access token".into(),
        ));
    }

    let user_id = claims.sub;
    let username = claims.username;

    Ok(ws.on_upgrade(move |socket| handle_socket(socket, state, user_id, username)))
}

async fn handle_socket(socket: WebSocket, state: AppState, user_id: Uuid, username: String) {
    let (mut sender, mut receiver) = socket.split();

    // Register this connection
    let mut hub_rx = state.hub.register(user_id).await;

    tracing::info!("WebSocket connected: {username} ({user_id})");

    // Task: forward hub messages → WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(msg) = hub_rx.recv().await {
            let text = serde_json::to_string(&msg).unwrap_or_default();
            if sender.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    // Task: receive WebSocket messages → process
    let hub = state.hub.clone();
    let recv_state = state.clone();
    let username_clone = username.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(client_msg) = serde_json::from_str::<WsClientMessage>(&text) {
                        handle_client_message(
                            &recv_state,
                            &hub,
                            user_id,
                            &username_clone,
                            client_msg,
                        )
                        .await;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // Wait for either task to finish
    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }

    state.hub.unregister(user_id).await;
    tracing::info!("WebSocket disconnected: {username} ({user_id})");
}

async fn handle_client_message(
    state: &AppState,
    hub: &ConnectionHub,
    sender_id: Uuid,
    sender_username: &str,
    msg: WsClientMessage,
) {
    match msg {
        WsClientMessage::SendMessage {
            chat_id,
            encrypted_content,
            nonce,
            message_type,
        } => {
            // Verify membership
            if !MessengerRepo::is_chat_member(&state.db, chat_id, sender_id)
                .await
                .unwrap_or(false)
            {
                hub.send_to_user(
                    sender_id,
                    WsServerMessage::Error {
                        message: "Not a member of this chat".into(),
                    },
                )
                .await;
                return;
            }

            let msg_type = message_type.as_deref().unwrap_or("text");

            // Store the encrypted message
            let stored = match MessengerRepo::store_message(
                &state.db,
                chat_id,
                sender_id,
                &encrypted_content,
                &nonce,
                msg_type,
            )
            .await
            {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!("Failed to store message: {e}");
                    return;
                }
            };

            // Get all chat members and broadcast
            let members = MessengerRepo::get_chat_members(&state.db, chat_id)
                .await
                .unwrap_or_default();

            let member_ids: Vec<Uuid> = members.iter().map(|m| m.user_id).collect();

            let server_msg = WsServerMessage::NewMessage {
                id: stored.id,
                chat_id,
                sender_id,
                sender_username: sender_username.to_string(),
                encrypted_content: stored.encrypted_content,
                nonce: stored.nonce,
                message_type: stored.message_type,
                created_at: stored.created_at,
            };

            hub.send_to_users(&member_ids, server_msg).await;
        }

        WsClientMessage::Typing { chat_id } => {
            let members = MessengerRepo::get_chat_members(&state.db, chat_id)
                .await
                .unwrap_or_default();

            let other_ids: Vec<Uuid> = members
                .iter()
                .filter(|m| m.user_id != sender_id)
                .map(|m| m.user_id)
                .collect();

            hub.send_to_users(
                &other_ids,
                WsServerMessage::Typing {
                    chat_id,
                    user_id: sender_id,
                    username: sender_username.to_string(),
                },
            )
            .await;
        }

        WsClientMessage::MarkRead {
            chat_id,
            message_id,
        } => {
            let members = MessengerRepo::get_chat_members(&state.db, chat_id)
                .await
                .unwrap_or_default();

            let other_ids: Vec<Uuid> = members
                .iter()
                .filter(|m| m.user_id != sender_id)
                .map(|m| m.user_id)
                .collect();

            hub.send_to_users(
                &other_ids,
                WsServerMessage::MessagesRead {
                    chat_id,
                    user_id: sender_id,
                    last_read_message_id: message_id,
                },
            )
            .await;
        }

        WsClientMessage::UploadPreKeys {
            identity_key,
            signed_pre_key,
            signed_pre_key_signature,
            one_time_pre_keys,
        } => {
            if let Err(e) = MessengerRepo::upsert_key_bundle(
                &state.db,
                sender_id,
                &identity_key,
                &signed_pre_key,
                &signed_pre_key_signature,
            )
            .await
            {
                tracing::error!("Failed to store key bundle: {e}");
                return;
            }

            if let Err(e) =
                MessengerRepo::add_one_time_pre_keys(&state.db, sender_id, &one_time_pre_keys)
                    .await
            {
                tracing::error!("Failed to store one-time pre-keys: {e}");
            }
        }

        WsClientMessage::DeleteMessage { chat_id, message_id } => {
            if !MessengerRepo::is_chat_member(&state.db, chat_id, sender_id)
                .await
                .unwrap_or(false)
            {
                hub.send_to_user(
                    sender_id,
                    WsServerMessage::Error {
                        message: "Not a member of this chat".into(),
                    },
                )
                .await;
                return;
            }

            let deleted =
                MessengerRepo::delete_message(&state.db, chat_id, message_id, sender_id)
                    .await
                    .unwrap_or(false);

            if !deleted {
                hub.send_to_user(
                    sender_id,
                    WsServerMessage::Error {
                        message: "Message not found or permission denied".into(),
                    },
                )
                .await;
                return;
            }

            let members = MessengerRepo::get_chat_members(&state.db, chat_id)
                .await
                .unwrap_or_default();
            let member_ids: Vec<Uuid> = members.iter().map(|m| m.user_id).collect();

            hub.send_to_users(
                &member_ids,
                WsServerMessage::MessageDeleted { chat_id, message_id },
            )
            .await;
        }

        WsClientMessage::RequestKeyBundle { user_id } => {
            let bundle = MessengerRepo::get_key_bundle(&state.db, user_id).await;
            match bundle {
                Ok(Some(b)) => {
                    let otpk = MessengerRepo::claim_one_time_pre_key(&state.db, user_id)
                        .await
                        .unwrap_or(None);

                    hub.send_to_user(
                        sender_id,
                        WsServerMessage::KeyBundle {
                            user_id,
                            identity_key: b.identity_key,
                            signed_pre_key: b.signed_pre_key,
                            signed_pre_key_signature: b.signed_pre_key_signature,
                            one_time_pre_key: otpk,
                        },
                    )
                    .await;
                }
                _ => {
                    hub.send_to_user(
                        sender_id,
                        WsServerMessage::Error {
                            message: "Key bundle not found for user".into(),
                        },
                    )
                    .await;
                }
            }
        }
    }
}
