import type {
  AdjustmentReason,
  BusinessId,
  InventoryMovement,
  InventoryMovementType,
  InventoryRecording,
  LocationId,
  MembershipId,
  PackSnapshot,
  ProductPack,
  ProductVariant,
  StockChangeLine,
  Uuid,
} from "@tali/domain";
import {
  createInventoryRecording,
  packEntryQuantity,
  parsePackSnapshot,
  planStockChange,
  Quantity,
  restoreInventoryRecording,
} from "@tali/domain";
import type { Permission } from "../../authorization/permissions.js";
import type { LocationBoundContext, UserActor } from "../../context/business-context.js";
import { requireLocationBound } from "../../context/business-context.js";
import { ConflictError, NotFoundError, ValidationError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import { idempotencyActorOf } from "../../idempotency/business-idempotency-store.js";
import type { CommandObject } from "../../idempotency/canonical-command.js";
import { canonicalCommandEncoding } from "../../idempotency/canonical-command.js";
import type { FingerprintHasher } from "../../idempotency/fingerprint-hasher.js";
import type { IdempotencyKey } from "../../idempotency/idempotency-key.js";
import { requireIdempotencyKey } from "../../idempotency/idempotency-key.js";
import type { IdempotentResultCodec, KeyedIdempotency } from "../../idempotency/keyed-idempotency.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { TransactionScope, UnitOfWork } from "../../ports/unit-of-work.js";
import type { MembershipRepository } from "../business/index.js";
import { requireActingMembership, requireUserActor } from "../business/index.js";
import type { ProductPackRepository, ProductRepository, UnitReferenceRepository } from "../catalog/index.js";
import { PACK_NOT_FOUND, PRODUCT_NOT_FOUND } from "../catalog/index.js";
import type { StockDocumentSnapshot } from "./codecs.js";
import { sourceOfSnapshot } from "./codecs.js";
import type { NormalizedStockLine, StockLineSyntax } from "./inventory-common.js";
import { fingerprintLines, normalizeStockLines } from "./inventory-common.js";
import type { InventoryMovementRepository, StockBalanceRepository } from "./ports.js";

/** What every keyed stock document needs, whatever its header table. */
export interface StockDocumentDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly products: ProductRepository;
  readonly packs: ProductPackRepository;
  readonly units: UnitReferenceRepository;
  readonly movements: InventoryMovementRepository;
  readonly balances: StockBalanceRepository;
  readonly idempotency: KeyedIdempotency;
  readonly hasher: FingerprintHasher;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * Everything the state-independent plan step knows. There is no transaction
 * scope here, so no repository can be called from the header hook.
 */
export interface HeaderPlan {
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly recording: InventoryRecording;
}

/** A document header: its ID plus who recorded it, when and through which channel. */
export type StockDocumentHeader = InventoryRecording & { readonly id: Uuid };

/** The result of a keyed stock document: the stored header snapshot plus its original movements. */
export interface StockDocumentOutcome<Snapshot extends StockDocumentSnapshot> {
  readonly document: Snapshot;
  /** Original movements only, ordered by variant ID ascending, on both the fresh and the replay path. */
  readonly movements: readonly InventoryMovement[];
  readonly replayed: boolean;
}

/** The fixed traits of one kind of keyed stock document. */
export interface StockDocumentKind<Snapshot extends StockDocumentSnapshot> {
  readonly operation: string;
  readonly commandSchemaVersion: number;
  readonly resourceType: "inventory_opening_batch" | "goods_receipt" | "inventory_adjustment";
  readonly movementType: InventoryMovementType;
  /** Whether an ARCHIVED variant may take this change (ADR-008 section 17). */
  readonly archivedAllowed: boolean;
  readonly codec: IdempotentResultCodec<Snapshot>;
}

/**
 * One keyed stock document request. The hooks split the work as plan
 * decision D21 requires:
 *
 * - `createHeader` is the state-independent plan hook. It is synchronous and
 *   receives no transaction scope, so it cannot reach a repository, lock or
 *   read stock; it only builds the header from the generated recording.
 * - `insertHeader` and `audit` run in `apply()`, after the key is claimed.
 */
export interface StockDocumentRequest<Header extends StockDocumentHeader, Snapshot extends StockDocumentSnapshot> {
  readonly kind: StockDocumentKind<Snapshot>;
  readonly lines: readonly StockLineSyntax[];
  /** Fingerprinted document fields other than the lines and location (reference, reason, note). */
  readonly fields: CommandObject;
  readonly reason?: AdjustmentReason;
  /** The signed stock-unit delta of a line from its positive magnitude. */
  readonly signed: (magnitude: Quantity, line: NormalizedStockLine) => Quantity;
  readonly createHeader: (plan: HeaderPlan) => Header;
  readonly snapshot: (header: Header, lineCount: number) => Snapshot;
  readonly insertHeader: (scope: TransactionScope, header: Header) => Promise<void>;
  readonly audit: (scope: TransactionScope, header: Header, key: IdempotencyKey, lineCount: number) => Promise<void>;
}

/** The checks that precede line syntax (plan section H, steps 1 to 3). */
export interface PreparedInventoryCommand {
  readonly actor: UserActor;
  readonly context: LocationBoundContext;
  readonly key: IdempotencyKey;
  readonly permission: Permission;
}

/**
 * The permission is checked before anything else, including the idempotency
 * lookup (ADR-004 section 6); the location is the one resolved server-side,
 * never a client value.
 */
export function prepareInventoryCommand(
  context: LocationBoundContext,
  permission: Permission,
  idempotencyKey: string | undefined,
): PreparedInventoryCommand {
  const actor = requireUserActor(context, permission);
  return { actor, context: requireLocationBound(context), key: requireIdempotencyKey(idempotencyKey), permission };
}

function variantOrNotFound(
  variants: ReadonlyMap<string, ProductVariant>,
  line: NormalizedStockLine,
  businessId: BusinessId,
): ProductVariant {
  const variant = variants.get(line.variantId);
  if (variant?.businessId !== businessId) throw new NotFoundError(PRODUCT_NOT_FOUND);
  return variant;
}

function requireStockable(variant: ProductVariant, archivedAllowed: boolean): void {
  if (!variant.trackInventory) throw new ConflictError("This product does not track inventory");
  if (variant.status !== "ACTIVE" && !archivedAllowed) {
    throw new ConflictError("An archived product cannot take opening stock or receipts");
  }
}

/** A unit other than the stock unit is a validation failure, never a conversion (plan decision D9). */
function unitMismatch(index: number, unit: string): ValidationError {
  const message = `quantity must be in the product's stock unit ${unit}`;
  return new ValidationError(message, [{ path: ["lines", index, "unit"], message }]);
}

/** The positive stock-unit magnitude of a line whose unit was checked, with the pack snapshot of a pack line. */
function lineMagnitude(
  line: NormalizedStockLine,
  variant: ProductVariant,
  packs: ReadonlyMap<string, ProductPack>,
  businessId: BusinessId,
): { readonly magnitude: Quantity; readonly pack?: PackSnapshot } {
  const quantity = line.quantity;
  if (quantity.form === "direct") {
    return {
      magnitude: withDomainRules(() => Quantity.ofMinor(quantity.quantityMinor, variant.stockUnit), "quantity"),
    };
  }
  const pack = packs.get(quantity.packId);
  if (pack?.businessId !== businessId || pack.variantId !== variant.id) throw new NotFoundError(PACK_NOT_FOUND);
  const magnitude = withDomainRules(
    () => packEntryQuantity({ pack, stockUnit: variant.stockUnit, packCount: quantity.packCount }),
    "packCount",
  );
  const snapshot = withDomainRules(() =>
    parsePackSnapshot({ packId: pack.id, name: pack.name, count: quantity.packCount, factorMinor: pack.factorMinor }),
  );
  return { magnitude, pack: snapshot };
}

/**
 * The shared keyed pipeline for opening stock, goods receipts, adjustments
 * and write-offs (plan section H, steps 1 to 14).
 *
 * Outside the transaction: permission, location-bound context, key and line
 * syntax. Inside: the acting membership, decimal normalization with unit
 * reference data, the fingerprint (with the resolved location), then
 * `KeyedIdempotency.runBusinessScoped`, whose `plan()` here is
 * state-independent: it reads the clock, derives the business date, generates
 * the document ID and builds the header snapshot, nothing else. Every lock,
 * pack lookup, balance read and stock decision happens in `apply()`, after the
 * key is claimed; a rejection there rolls back the whole unit of work,
 * including the claimed key.
 */
export async function runStockDocument<Header extends StockDocumentHeader, Snapshot extends StockDocumentSnapshot>(
  dependencies: StockDocumentDependencies,
  prepared: PreparedInventoryCommand,
  request: StockDocumentRequest<Header, Snapshot>,
): Promise<StockDocumentOutcome<Snapshot>> {
  const { actor, context, key, permission } = prepared;
  const { kind } = request;

  return dependencies.unitOfWork.run(async (scope): Promise<StockDocumentOutcome<Snapshot>> => {
    const membership = await requireActingMembership(scope, dependencies.memberships, context, permission);
    const lines = await normalizeStockLines(scope, dependencies.units, request.lines);
    const command = canonicalCommandEncoding({
      operation: kind.operation,
      commandSchemaVersion: kind.commandSchemaVersion,
      command: { ...request.fields, locationId: context.locationId, lines: fingerprintLines(lines) },
    });
    const fingerprint = await dependencies.hasher.fingerprint(command);

    const outcome = await dependencies.idempotency.runBusinessScoped(scope, {
      businessId: context.businessId,
      actor: idempotencyActorOf(actor),
      key,
      command,
      fingerprint,
      resourceType: kind.resourceType,
      codec: kind.codec,
      plan: () => {
        const header = request.createHeader({
          businessId: context.businessId,
          locationId: context.locationId,
          recording: planRecording(dependencies.clock, context, membership.id),
        });
        const snapshot = request.snapshot(header, lines.length);
        return Promise.resolve({
          result: snapshot,
          resourceId: header.id,
          apply: () => applyStockDocument(dependencies, scope, context, request, lines, header, snapshot, key),
        });
      },
    });
    const movements = await dependencies.movements.listOriginals(
      scope,
      context.businessId,
      sourceOfSnapshot(outcome.result),
    );
    return { document: outcome.result, movements, replayed: outcome.replayed };
  });
}

export function planRecording(
  clock: Clock,
  context: LocationBoundContext,
  membershipId: MembershipId,
): InventoryRecording {
  return withDomainRules(() =>
    createInventoryRecording({
      actorMembershipId: membershipId,
      ...(context.deviceId === undefined ? {} : { deviceId: context.deviceId }),
      sourceChannel: context.sourceChannel,
      correlationId: context.correlationId,
      now: clock.now(),
      timeZone: context.timeZone,
    }),
  );
}

/** ADR-008 section 9 order: variants FOR SHARE, packs, balances FOR UPDATE, decision, then the writes. */
async function applyStockDocument<Header extends StockDocumentHeader, Snapshot extends StockDocumentSnapshot>(
  dependencies: StockDocumentDependencies,
  scope: TransactionScope,
  context: LocationBoundContext,
  request: StockDocumentRequest<Header, Snapshot>,
  lines: readonly NormalizedStockLine[],
  header: Header,
  snapshot: Snapshot,
  key: IdempotencyKey,
): Promise<void> {
  const { businessId, locationId } = context;
  const variantIds = new Set(lines.map((line) => line.variantId));
  const variants = await dependencies.products.lockVariantsForShare(scope, businessId, variantIds);
  const items = lines.map((line) => ({ line, variant: variantOrNotFound(variants, line, businessId) }));
  for (const { variant } of items) requireStockable(variant, request.kind.archivedAllowed);
  for (const [index, { line, variant }] of items.entries()) {
    if (line.quantity.form === "direct" && line.quantity.unit !== variant.stockUnit) {
      throw unitMismatch(index, variant.stockUnit);
    }
  }

  const packIds = new Set(lines.flatMap((line) => (line.quantity.form === "pack" ? [line.quantity.packId] : [])));
  const packs =
    packIds.size === 0
      ? new Map<string, ProductPack>()
      : await dependencies.packs.findForEntry(scope, businessId, packIds);
  const changes: StockChangeLine[] = items.map(({ line, variant }) => {
    const { magnitude, pack } = lineMagnitude(line, variant, packs, businessId);
    return {
      movementId: dependencies.ids.newId("InventoryMovement"),
      variantId: line.variantId,
      delta: request.signed(magnitude, line),
      ...(pack === undefined ? {} : { pack }),
    };
  });

  const locked = await dependencies.balances.lockForUpdate(scope, businessId, locationId, variantIds);
  const plan = withDomainRules(() =>
    planStockChange({
      businessId,
      locationId,
      type: request.kind.movementType,
      source: sourceOfSnapshot(snapshot),
      lines: changes,
      balances: locked.balances,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      recording: restoreInventoryRecording(header),
    }),
  );

  await request.insertHeader(scope, header);
  await dependencies.movements.insertMany(scope, plan.movements);
  await dependencies.balances.apply(scope, locked, plan.balances);
  await request.audit(scope, header, key, lines.length);
}
