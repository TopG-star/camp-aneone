-- Migration 004: Add conversation_id to conversations table
-- Groups messages into logical conversations (sessions).
-- Existing rows get a default conversation_id of 'default'.

ALTER TABLE conversations ADD COLUMN conversation_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_conversations_conversation_id
  ON conversations (conversation_id, created_at ASC);
