-- Step B-core spec §4.5: deliberate identity linking. An intent is opened while signed in and spent by the second
-- sign-in. A Google session has no session id and the second sign-in replaces the session token, so the intent is bound
-- to a random secret instead. The secret goes once to the browser that opened the intent; only its hash is kept here.
CREATE TABLE link_intents (
  id           TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  identity_id  TEXT NOT NULL REFERENCES identities (id),
  expires_at   TEXT NOT NULL,
  used_at      TEXT
);
