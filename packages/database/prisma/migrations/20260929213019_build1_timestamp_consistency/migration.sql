-- Build 1 Slice 2: timestamp consistency CHECKs (ADR-005 section 19).
-- A row is never updated to a time before it was created. Hand-written:
-- Prisma does not model CHECK constraints. Expectations are listed in
-- scripts/verify-schema.mjs.

ALTER TABLE "users" ADD CONSTRAINT "users_updated_after_created" CHECK ("updated_at" >= "created_at");
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_updated_after_created" CHECK ("updated_at" >= "created_at");
ALTER TABLE "business_locations" ADD CONSTRAINT "business_locations_updated_after_created" CHECK ("updated_at" >= "created_at");
ALTER TABLE "business_memberships" ADD CONSTRAINT "business_memberships_updated_after_created" CHECK ("updated_at" >= "created_at");
