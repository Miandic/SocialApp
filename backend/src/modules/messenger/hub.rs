use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

use super::models::WsServerMessage;

/// Central hub for routing WebSocket messages to connected clients.
///
/// Each user can have multiple simultaneous connections (one per device).
/// The hub tracks `(device_id, sender)` pairs so individual devices can be
/// targeted with device-specific ciphertexts.
///
/// Invariant: at most ONE live entry per (user_id, device_id) pair.
/// `register()` evicts any stale entry for the same device before inserting.
#[derive(Clone)]
pub struct ConnectionHub {
    /// user_id → [(device_id, channel_sender)]
    connections:
        Arc<RwLock<HashMap<Uuid, Vec<(Uuid, mpsc::UnboundedSender<WsServerMessage>)>>>>,
}

impl ConnectionHub {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Register a new WebSocket connection for a user's device.
    ///
    /// Any existing (possibly stale) entry for the same (user_id, device_id)
    /// is removed first so the device never accumulates duplicate channels.
    pub async fn register(
        &self,
        user_id: Uuid,
        device_id: Uuid,
    ) -> mpsc::UnboundedReceiver<WsServerMessage> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut conns = self.connections.write().await;
        let senders = conns.entry(user_id).or_default();
        // Evict any previous entry for this device (handles reconnects / double-connects).
        senders.retain(|(did, _)| *did != device_id);
        senders.push((device_id, tx));
        rx
    }

    /// Prune closed channels after a WebSocket disconnects.
    pub async fn unregister(&self, user_id: Uuid, device_id: Uuid) {
        let mut conns = self.connections.write().await;
        if let Some(senders) = conns.get_mut(&user_id) {
            senders.retain(|(did, tx)| !(*did == device_id && tx.is_closed()));
            // Also clean up any other stale channels while we're here.
            senders.retain(|(_, tx)| !tx.is_closed());
            if senders.is_empty() {
                conns.remove(&user_id);
            }
        }
    }

    /// Send a message to all connections of a user (all their devices).
    pub async fn send_to_user(&self, user_id: Uuid, msg: WsServerMessage) {
        let conns = self.connections.read().await;
        if let Some(senders) = conns.get(&user_id) {
            for (_, tx) in senders {
                let _ = tx.send(msg.clone());
            }
        }
    }

    /// Send a message to one specific device of a user.
    pub async fn send_to_device(&self, user_id: Uuid, device_id: Uuid, msg: WsServerMessage) {
        let conns = self.connections.read().await;
        if let Some(senders) = conns.get(&user_id) {
            for (did, tx) in senders {
                if *did == device_id {
                    let _ = tx.send(msg.clone());
                }
            }
        }
    }

    /// Send the same message to all devices of multiple users.
    pub async fn send_to_users(&self, user_ids: &[Uuid], msg: WsServerMessage) {
        let conns = self.connections.read().await;
        for uid in user_ids {
            if let Some(senders) = conns.get(uid) {
                for (_, tx) in senders {
                    let _ = tx.send(msg.clone());
                }
            }
        }
    }

    /// Return the unique device IDs that currently have open connections for a user.
    ///
    /// Deduplication ensures each device_id appears exactly once even if the
    /// connections list somehow has lingering duplicates.
    pub async fn online_device_ids(&self, user_id: Uuid) -> Vec<Uuid> {
        let conns = self.connections.read().await;
        conns
            .get(&user_id)
            .map(|senders| {
                let mut seen = std::collections::HashSet::new();
                senders
                    .iter()
                    .filter(|(_, tx)| !tx.is_closed())
                    .map(|(did, _)| *did)
                    .filter(|did| seen.insert(*did))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Check if a user has any open connection.
    pub async fn is_online(&self, user_id: Uuid) -> bool {
        let conns = self.connections.read().await;
        conns
            .get(&user_id)
            .is_some_and(|senders| senders.iter().any(|(_, tx)| !tx.is_closed()))
    }
}
