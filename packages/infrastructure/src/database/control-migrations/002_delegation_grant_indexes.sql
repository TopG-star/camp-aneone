CREATE INDEX idx_delegation_grants_session ON delegation_grants (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_delegation_grants_action ON delegation_grants (action_id) WHERE action_id IS NOT NULL;
CREATE INDEX idx_delegation_grants_pending ON delegation_grants (pending_request_id) WHERE pending_request_id IS NOT NULL;
