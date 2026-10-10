-- Spec 8.5: link a model call to the conversation and turn that caused it, and a proposed action to the model call that proposed it.
-- All three are plain ids inside one context file (no foreign keys, and none across files). Nullable: existing rows have no link,
-- and calls that are not chat turns (email classification, the briefing, background jobs) and actions created any other way stay null.
-- ADD COLUMN does not fire the append-only triggers on model_call_decisions.
ALTER TABLE model_call_decisions ADD COLUMN conversation_id TEXT;
ALTER TABLE model_call_decisions ADD COLUMN turn_id TEXT;
ALTER TABLE action_instances ADD COLUMN model_call_id TEXT;
