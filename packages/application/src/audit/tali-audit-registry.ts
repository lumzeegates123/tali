import { businessAuditActions } from "../modules/business/index.js";
import { catalogAuditActions } from "../modules/catalog/index.js";
import { deviceAuditActions } from "../modules/device/index.js";
import { identityAuditActions } from "../modules/identity/index.js";
import { locationAuditActions } from "../modules/location/index.js";
import { defineAuditRegistry } from "./audit-action.js";

/** Every audit action Tali can record. Registration fails at startup on a duplicate name. */
export const taliAuditRegistry = defineAuditRegistry([
  ...identityAuditActions,
  ...locationAuditActions,
  ...businessAuditActions,
  ...deviceAuditActions,
  ...catalogAuditActions,
]);
