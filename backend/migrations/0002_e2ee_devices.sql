-- E2EE: per-device key bundles, multi-device message delivery, history sync

-- ─── Per-device key bundles (replaces user_key_bundles) ───
CREATE TABLE user_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name TEXT NOT NULL DEFAULT 'Unknown Device',
    identity_key TEXT NOT NULL,              -- X25519 public key (base64url)
    signed_pre_key TEXT NOT NULL,            -- Signed pre-key (base64url)
    signed_pre_key_signature TEXT NOT NULL,  -- Ed25519 signature of signed_pre_key
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_devices_user ON user_devices (user_id);

-- ─── Rebuild one_time_pre_keys at device scope ───
DROP TABLE one_time_pre_keys;

CREATE TABLE one_time_pre_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
    key_data TEXT NOT NULL,
    used BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_otpk_device_unused ON one_time_pre_keys (device_id, used) WHERE used = FALSE;

-- ─── Drop old per-user key bundle table ───
DROP TABLE user_key_bundles;

-- ─── Per-device message ciphertexts (one row per device per message) ───
CREATE TABLE message_device_ciphertexts (
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
    encrypted_content TEXT NOT NULL,
    nonce TEXT NOT NULL,
    PRIMARY KEY (message_id, device_id)
);

CREATE INDEX idx_mdc_device ON message_device_ciphertexts (device_id);

-- ─── History sync packages (encrypted for a specific pending device) ───
CREATE TABLE history_sync_packages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_device_id UUID NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
    recipient_device_id UUID NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);

CREATE UNIQUE INDEX idx_history_sync_recipient ON history_sync_packages (recipient_device_id);

-- ─── Give messages.encrypted_content a default so new inserts can omit it ───
ALTER TABLE messages ALTER COLUMN encrypted_content SET DEFAULT 'e2ee';
ALTER TABLE messages ALTER COLUMN nonce SET DEFAULT '';

-- ─── Track which device sent each message (needed for session key recovery) ───
ALTER TABLE messages
    ADD COLUMN sender_device_id UUID REFERENCES user_devices(id) ON DELETE SET NULL;
