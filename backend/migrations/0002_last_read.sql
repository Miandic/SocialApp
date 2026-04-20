ALTER TABLE chat_members ADD COLUMN last_read_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;
