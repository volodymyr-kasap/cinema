CREATE EXTENSION IF NOT EXISTS btree_gist;

--> statement-breakpoint
ALTER TABLE "showtimes"
  ADD CONSTRAINT "showtimes_no_overlap"
  EXCLUDE USING gist (
    "hall_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  );
