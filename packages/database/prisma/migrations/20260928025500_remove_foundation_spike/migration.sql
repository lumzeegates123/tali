-- Remove the temporary Wave B Prisma foundation spike schema.
--
-- APPROVED DESTRUCTIVE CHANGE. Removal was explicitly approved by the Tali
-- maintainers on 2026-09-27 (Wave B closeout). It is approved only because
-- `foundation_spike` is temporary test infrastructure created by migration
-- 20260927231057_foundation_spike to prove ADR-002's Prisma criteria
-- (docs/audits/prisma-foundation-spike.md). It never held Tali business data,
-- customer data or financial records, and no application code uses it.
--
-- This is not a pattern for business, financial or audit tables: those are
-- never dropped (.cursor/rules/10-database.mdc). The approval is recorded in
-- scripts/verify-schema.mjs (APPROVED_DESTRUCTIVE_MIGRATIONS), and every
-- destructive line below carries the tali:allow-destructive marker.
--
-- Tables are dropped explicitly and the schema without CASCADE, so an
-- unexpected object in the schema makes this migration fail instead of being
-- deleted silently. Dropping a table also removes its grants.

DROP TABLE "foundation_spike"."transaction_probe"; -- tali:allow-destructive
DROP TABLE "foundation_spike"."job_claim"; -- tali:allow-destructive
DROP TABLE "foundation_spike"."bigint_probe"; -- tali:allow-destructive
DROP TABLE "foundation_spike"."constraint_probe"; -- tali:allow-destructive
DROP TABLE "foundation_spike"."protected_entry"; -- tali:allow-destructive
DROP SCHEMA "foundation_spike"; -- tali:allow-destructive
