use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use uuid::Uuid;
use validator::Validate;

use crate::{
    errors::{AppError, AppResult},
    middleware::auth::AuthUser,
    modules::messenger::models::WsServerMessage,
    state::AppState,
};

use super::{models::*, repo::DevicesRepo};

/// Register this device's key bundle.
///
/// First verified device of the account is auto-approved (is_verified = true).
/// Every subsequent device starts as unverified and requires approval from an
/// already-verified device.
pub async fn register_device(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<RegisterDeviceRequest>,
) -> AppResult<(StatusCode, Json<RegisterDeviceResponse>)> {
    req.validate().map_err(|e| AppError::Validation(e.to_string()))?;

    let has_devices = DevicesRepo::user_has_verified_devices(&state.db, auth.user_id).await?;
    // Auto-verify if:
    //  (a) the user has no verified devices at all — first device on the account, OR
    //  (b) the user has verified devices in the DB but NONE of them are currently
    //      online — they re-logged in from a new browser/incognito tab and there
    //      is no one around to approve the new device, so we treat it as trusted.
    let is_online = state.hub.is_online(auth.user_id).await;
    let is_verified = !has_devices || !is_online;

    let device = DevicesRepo::create_device(
        &state.db,
        auth.user_id,
        &req.device_name,
        &req.identity_key,
        &req.signed_pre_key,
        &req.signed_pre_key_signature,
        is_verified,
    )
    .await?;

    DevicesRepo::add_one_time_pre_keys(&state.db, device.id, &req.one_time_pre_keys).await?;

    if !is_verified {
        state
            .hub
            .send_to_user(
                auth.user_id,
                WsServerMessage::NewDevicePending {
                    device_id: device.id,
                    device_name: req.device_name.clone(),
                },
            )
            .await;
    }

    Ok((
        StatusCode::CREATED,
        Json(RegisterDeviceResponse {
            device_id: device.id,
            is_verified: device.is_verified,
            created_at: device.created_at,
        }),
    ))
}

/// List all devices registered to the authenticated user.
pub async fn list_devices(
    State(state): State<AppState>,
    auth: AuthUser,
) -> AppResult<Json<Vec<DeviceResponse>>> {
    let devices = DevicesRepo::list_devices(&state.db, auth.user_id).await?;
    let response = devices
        .into_iter()
        .map(|d| DeviceResponse {
            id: d.id,
            device_name: d.device_name,
            is_verified: d.is_verified,
            created_at: d.created_at,
            last_seen_at: d.last_seen_at,
        })
        .collect();
    Ok(Json(response))
}

/// Approve a pending device. Caller must already have a verified device on this account.
pub async fn approve_device(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(device_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    if !DevicesRepo::user_has_verified_devices(&state.db, auth.user_id).await? {
        return Err(AppError::Forbidden);
    }

    let approved = DevicesRepo::approve_device(&state.db, auth.user_id, device_id).await?;
    if !approved {
        return Err(AppError::NotFound(
            "Device not found or already verified".into(),
        ));
    }

    state
        .hub
        .send_to_user(auth.user_id, WsServerMessage::DeviceApproved { device_id })
        .await;

    Ok(StatusCode::NO_CONTENT)
}

/// Revoke (permanently delete) a device.
pub async fn revoke_device(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(device_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let deleted = DevicesRepo::delete_device(&state.db, auth.user_id, device_id).await?;
    if !deleted {
        return Err(AppError::NotFound("Device not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Upload additional one-time pre-keys for a device.
pub async fn upload_pre_keys(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(device_id): Path<Uuid>,
    Json(req): Json<UploadPreKeysRequest>,
) -> AppResult<StatusCode> {
    if !DevicesRepo::device_belongs_to_user(&state.db, device_id, auth.user_id).await? {
        return Err(AppError::NotFound("Device not found".into()));
    }
    DevicesRepo::add_one_time_pre_keys(&state.db, device_id, &req.one_time_pre_keys).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Return key bundles for all verified devices of a user.
/// Called by the sender before encrypting a message.
pub async fn get_user_key_bundles(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(user_id): Path<Uuid>,
) -> AppResult<Json<Vec<DeviceKeyBundle>>> {
    let bundles = DevicesRepo::get_user_device_bundles(&state.db, user_id).await?;
    Ok(Json(bundles))
}

/// Store an encrypted history package destined for a pending device on this account.
pub async fn send_history_package(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<SendHistoryRequest>,
) -> AppResult<StatusCode> {
    if !DevicesRepo::device_belongs_to_user(&state.db, req.sender_device_id, auth.user_id).await?
    {
        return Err(AppError::Forbidden);
    }
    if !DevicesRepo::device_belongs_to_user(&state.db, req.recipient_device_id, auth.user_id)
        .await?
    {
        return Err(AppError::NotFound("Recipient device not found".into()));
    }

    DevicesRepo::store_history_package(
        &state.db,
        auth.user_id,
        req.sender_device_id,
        req.recipient_device_id,
        &req.ciphertext,
        &req.nonce,
    )
    .await?;

    state
        .hub
        .send_to_user(
            auth.user_id,
            WsServerMessage::HistorySyncReady {
                sender_device_id: req.sender_device_id,
            },
        )
        .await;

    Ok(StatusCode::CREATED)
}

/// Fetch the pending history sync package for a device.
pub async fn get_history_package(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(device_id): Path<Uuid>,
) -> AppResult<Json<Option<HistoryPackageResponse>>> {
    if !DevicesRepo::device_belongs_to_user(&state.db, device_id, auth.user_id).await? {
        return Err(AppError::NotFound("Device not found".into()));
    }
    let pkg = DevicesRepo::get_history_package(&state.db, device_id).await?;
    let response = pkg.map(|p| HistoryPackageResponse {
        id: p.id,
        sender_device_id: p.sender_device_id,
        ciphertext: p.ciphertext,
        nonce: p.nonce,
        created_at: p.created_at,
    });
    Ok(Json(response))
}

/// Delete a history sync package after the recipient device has consumed it.
pub async fn delete_history_package(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(device_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    if !DevicesRepo::device_belongs_to_user(&state.db, device_id, auth.user_id).await? {
        return Err(AppError::NotFound("Device not found".into()));
    }
    DevicesRepo::delete_history_package(&state.db, device_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
