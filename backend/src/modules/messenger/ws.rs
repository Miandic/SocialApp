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
use crate::modules::devices::DevicesRepo;
use crate::state::AppState;

use super::hub::ConnectionHub;
use super::models::*;
use super::repo::MessengerRepo;

#[derive(Debug, Deserialize)]
pub struct WsAuthQuery {
    pub token: String,
    pub device_id: Uuid,
}

/// WebSocket upgrade handler.
///
/// The browser WebSocket API cannot send custom headers, so credentials are
/// passed via query params: `/api/messenger/ws?token=<jwt>&device_id=<uuid>`.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<WsAuthQuery>,
) -> Result<impl IntoResponse, crate::errors::AppError> {
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

    // Verify the claimed device belongs to this user
    if !DevicesRepo::device_belongs_to_user(&state.db, query.device_id, claims.sub).await? {
        return Err(crate::errors::AppError::Unauthorized(
            "Device not registered for this account".into(),
        ));
    }

    let user_id = claims.sub;
    let device_id = query.device_id;
    let username = claims.username;

    Ok(ws.on_upgrade(move |socket| {
        handle_socket(socket, state, user_id, device_id, username)
    }))
}

async fn handle_socket(
    socket: WebSocket,
    state: AppState,
    user_id: Uuid,
    device_id: Uuid,
    username: String,
) {
    let (mut sender, mut receiver) = socket.split();

    let mut hub_rx = state.hub.register(user_id, device_id).await;

    // Update last_seen timestamp for this device
    if let Err(e) = DevicesRepo::touch_last_seen(&state.db, device_id).await {
        tracing::warn!("Failed to touch last_seen for device {device_id}: {e}");
    }

    tracing::info!("WS connected: {username} / device {device_id}");

    // Forward hub messages → WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(msg) = hub_rx.recv().await {
            let text = match serde_json::to_string(&msg) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!("Failed to serialize WS message: {e}");
                    continue;
                }
            };
            if sender.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    // Receive WebSocket messages → process
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
                            device_id,
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

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }

    state.hub.unregister(user_id, device_id).await;
    tracing::info!("WS disconnected: {username} / device {device_id}");
}

async fn chat_member_ids(state: &AppState, chat_id: Uuid) -> Vec<Uuid> {
    match MessengerRepo::get_chat_members(&state.db, chat_id).await {
        Ok(members) => members.iter().map(|m| m.user_id).collect(),
        Err(e) => {
            tracing::error!("Failed to fetch members for chat {chat_id}: {e}");
            vec![]
        }
    }
}

async fn handle_client_message(
    state: &AppState,
    hub: &ConnectionHub,
    sender_id: Uuid,
    sender_device_id: Uuid,
    sender_username: &str,
    msg: WsClientMessage,
) {
    match msg {
        WsClientMessage::SendMessage {
            chat_id,
            device_ciphertexts,
            message_type,
        } => {
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

            let stored = match MessengerRepo::store_message_e2ee(
                &state.db,
                chat_id,
                sender_id,
                sender_device_id,
                msg_type,
                &device_ciphertexts,
            )
            .await
            {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!("Failed to store message: {e}");
                    return;
                }
            };

            let member_ids = chat_member_ids(state, chat_id).await;

            // Fetch the sender's identity key once so every recipient can
            // (re-)derive the shared session key without an extra REST call.
            let sender_identity_key =
                match DevicesRepo::get_device_identity_key(&state.db, sender_device_id).await {
                    Ok(k) => k,
                    Err(e) => {
                        tracing::error!(
                            "Failed to fetch identity key for device {sender_device_id}: {e}"
                        );
                        String::new()
                    }
                };

            // Notify every online device.
            // Devices with a matching ciphertext receive the decryptable content.
            // Devices without one still get a notification (placeholder ciphertext)
            // so the UI updates in real time; they'll see 🔒 and can re-fetch via REST.
            for &member_id in &member_ids {
                let online = hub.online_device_ids(member_id).await;
                for online_device_id in online {
                    let dc = device_ciphertexts
                        .iter()
                        .find(|dc| dc.device_id == online_device_id);

                    hub.send_to_device(
                        member_id,
                        online_device_id,
                        WsServerMessage::NewMessage {
                            id: stored.id,
                            chat_id,
                            sender_id,
                            sender_device_id,
                            sender_username: sender_username.to_string(),
                            sender_identity_key: sender_identity_key.clone(),
                            encrypted_content: dc
                                .map(|d| d.encrypted_content.clone())
                                .unwrap_or_else(|| stored.encrypted_content.clone()),
                            nonce: dc
                                .map(|d| d.nonce.clone())
                                .unwrap_or_else(|| stored.nonce.clone()),
                            message_type: stored.message_type.clone(),
                            created_at: stored.created_at,
                        },
                    )
                    .await;
                }
            }
        }

        WsClientMessage::Typing { chat_id } => {
            let other_ids: Vec<Uuid> = chat_member_ids(state, chat_id)
                .await
                .into_iter()
                .filter(|&id| id != sender_id)
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
            if let Err(e) =
                MessengerRepo::update_last_read(&state.db, chat_id, sender_id, message_id).await
            {
                tracing::warn!("Failed to update last read: {e}");
            }

            let other_ids: Vec<Uuid> = chat_member_ids(state, chat_id)
                .await
                .into_iter()
                .filter(|&id| id != sender_id)
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

        WsClientMessage::DeleteMessage {
            chat_id,
            message_id,
        } => {
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

            let member_ids = chat_member_ids(state, chat_id).await;
            hub.send_to_users(
                &member_ids,
                WsServerMessage::MessageDeleted { chat_id, message_id },
            )
            .await;
        }

        WsClientMessage::RequestKeyBundles { user_id } => {
            match DevicesRepo::get_user_device_bundles(&state.db, user_id).await {
                Ok(devices) => {
                    hub.send_to_user(
                        sender_id,
                        WsServerMessage::KeyBundles { user_id, devices },
                    )
                    .await;
                }
                Err(e) => {
                    tracing::error!("Failed to fetch key bundles for {user_id}: {e}");
                    hub.send_to_user(
                        sender_id,
                        WsServerMessage::Error {
                            message: "Failed to fetch key bundles".into(),
                        },
                    )
                    .await;
                }
            }
        }
    }
}
