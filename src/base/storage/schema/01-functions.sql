-- Hoisted above its original position in the monolithic schema.sql (see git history) so all six *_set_updated_at triggers, in later fragments, can rely on it.

-- Keep updated_at honest on any UPDATE path.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
