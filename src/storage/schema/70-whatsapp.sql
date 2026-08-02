-- ---------------------------------------------------------------------------
-- WhatsApp LID -> phone number mapping.
--
-- WhatsApp identifies a person two ways: an E.164 phone number and a LID
-- (`<digits>@lid`, a privacy id). Only the phone number is a usable identity
-- here — community_users, RBAC and project membership all match on it, because
-- resolveSenderId resolves LID -> phone via `senderPn` on every inbound
-- message. Group participant metadata, by contrast, gives LIDs and nothing
-- else, which is how four unreachable "phantom members" were created (see
-- docs/SECURITY.md §6b).
--
-- The adapter already learned this mapping opportunistically, but only in an
-- in-memory Map: lost on every restart, and never available to anything
-- outside the adapter. Persisting it lets a LID be RESOLVED to its phone
-- number rather than merely refused.
--
-- PII: this row links a privacy id to a phone number, so it is personal data
-- and is deleted by forget_me / purge_user_data along with the rest of a
-- person's data (keyed on `phone`).
CREATE TABLE IF NOT EXISTS whatsapp_lid_map (
  lid        TEXT        PRIMARY KEY,
  phone      TEXT        NOT NULL,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Purge deletes by phone, and a person can have more than one LID.
CREATE INDEX IF NOT EXISTS whatsapp_lid_map_phone_idx
  ON whatsapp_lid_map (phone);
