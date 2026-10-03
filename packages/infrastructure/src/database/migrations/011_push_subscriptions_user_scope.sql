ALTER TABLE push_subscriptions
ADD COLUMN user_id TEXT REFERENCES users (id);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id
  ON push_subscriptions (user_id);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_created_at
  ON push_subscriptions (created_at DESC);
