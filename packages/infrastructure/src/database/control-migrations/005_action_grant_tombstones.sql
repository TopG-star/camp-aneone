-- Step B-core spec 7.1: an action's grant dies when the action reaches a final status. A grant can still arrive after that: an issue that
-- was in flight when the action was cancelled, or one whose reply was lost and that a later exchange replays. The end of an action is
-- remembered here, so a grant stored for it afterwards is stored revoked. Only the action id is kept.
CREATE TABLE action_grant_tombstones (
  action_id  TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
