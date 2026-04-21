-- Invite token hash — sha256(plaintext) of a single-use collaborator invite.
--
-- Set when the owner sends an invite, cleared when the invitee accepts. NULL
-- on older rows that were auto-accepted before the email flow existed.

ALTER TABLE repo_collaborators ADD COLUMN invite_token_hash TEXT;
