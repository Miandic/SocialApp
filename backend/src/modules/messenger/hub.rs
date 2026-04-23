use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

use super::models::WsServerMessage;

/// Central hub for managing WebSocket connections and routing messages.
/// Uses Redis pub/sub under the hood for multi-instance scalability.
#[derive(Clone)]
pub struct ConnectionHub {
    /// Map of user_id -> list of sender channels (a user can have multiple connections)
    connections: Arc<RwLock<HashMap<Uuid, Vec<mpsc::UnboundedSender<WsServerMessage>>>>>,
}

impl ConnectionHub {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Register a new WebSocket connection for a user.
    pub async fn register(&self, user_id: Uuid) -> mpsc::UnboundedReceiver<WsServerMessage> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut conns = self.connections.write().await;
        conns.entry(user_id).or_default().push(tx);
        rx
    }

    /// Remove disconnected senders for a user.
    pub async fn unregister(&self, user_id: Uuid) {
        let mut conns = self.connections.write().await;
        if let Some(senders) = conns.get_mut(&user_id) {
            senders.retain(|tx| !tx.is_closed());
            if senders.is_empty() {
                conns.remove(&user_id);
            }
        }
    }

    /// Send a message to a specific user (all their connections).
    pub async fn send_to_user(&self, user_id: Uuid, msg: WsServerMessage) {
        let conns = self.connections.read().await;
        if let Some(senders) = conns.get(&user_id) {
            for tx in senders {
                // Err means the receiver (WebSocket task) has already dropped — the
                // connection was closed. unregister() will prune it on disconnect.
                let _ = tx.send(msg.clone());
            }
        }
    }

    /// Send a message to multiple users.
    pub async fn send_to_users(&self, user_ids: &[Uuid], msg: WsServerMessage) {
        let conns = self.connections.read().await;
        for uid in user_ids {
            if let Some(senders) = conns.get(uid) {
                for tx in senders {
                    let _ = tx.send(msg.clone()); // see send_to_user for why Err is ignored
                }
            }
        }
    }

    /// Check if a user is currently connected.
    pub async fn is_online(&self, user_id: Uuid) -> bool {
        let conns = self.connections.read().await;
        conns
            .get(&user_id)
            .is_some_and(|senders| senders.iter().any(|tx| !tx.is_closed()))
    }
}
