-- Custom SQL migration file, put your code below! --
-- SCHEMA.md: "updated_at maintained by trigger on bookings, payments, refunds."
-- Pushed into the database rather than application code for the same reason as
-- the payments_one_per_kind_idx / refunds_one_per_reason_idx guards (D-010):
-- a DB constraint cannot be bypassed by a code path that forgets to set it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bookings_set_updated_at
  BEFORE UPDATE ON "bookings"
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER payments_set_updated_at
  BEFORE UPDATE ON "payments"
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER refunds_set_updated_at
  BEFORE UPDATE ON "refunds"
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
