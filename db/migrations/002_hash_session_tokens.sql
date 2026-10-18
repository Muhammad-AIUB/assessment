-- 002: store only a SHA-256 hash of each session token, so a leaked database (or backup)
-- cannot be used to hijack logged-in sessions. Existing sessions are dropped: users log in again.
DELETE FROM sessions;
ALTER TABLE sessions RENAME COLUMN token TO token_hash;
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
