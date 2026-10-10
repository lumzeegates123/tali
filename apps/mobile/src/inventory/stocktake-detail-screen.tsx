import type { StocktakeLineResponse, StocktakeResponse } from "@tali/shared";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ApiFailure } from "../api/tali-api-client";
import { Button, Field, Heading, Loading, styles } from "../onboarding/ui";
import { definitionFor, formatDelta, formatInstant, formatQuantity, STOCKTAKE_STATUS_LABEL } from "./inventory-format";
import { InventoryFailure, Notice, useAllowed, useInventory, useInventoryStore } from "./inventory-context";
import type { ItemLabel } from "./inventory-store";
import { ItemPicker, QuantityFields, usePacks } from "./quantity-fields";
import { entryProblemText, type QuantityEntry, stocktakeCount } from "./quantity-input";
import { postingSummary } from "./stocktakes-screen";

export const STALE_MESSAGE = "Some stock changed while you were counting. Recount the affected items before posting.";
const LINE_VERSION_CONFLICT =
  "This count changed since it was loaded. The latest counts are shown; check the item and count it again.";
const STOCKTAKE_VERSION_CONFLICT =
  "The stocktake changed since it was loaded. The latest is shown; review it and try again.";
const NOT_IN_PROGRESS = "This stocktake is no longer in progress. The latest is shown.";

type DetailState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly failure: ApiFailure }
  | {
      readonly phase: "ready";
      readonly stocktake: StocktakeResponse;
      readonly lines: readonly StocktakeLineResponse[];
      readonly truncated: boolean;
    };

interface CountTarget {
  readonly variantId: string;
  readonly name: string;
  readonly stockUnit: string;
  readonly productId: string | undefined;
}

interface Stale {
  readonly variantIds: ReadonlySet<string>;
  readonly lineCount: number;
}

function isStaleFailure(failure: ApiFailure | undefined): boolean {
  return failure?.kind === "api-error" && failure.code === "STOCKTAKE_STALE";
}

function placeLine(lines: readonly StocktakeLineResponse[], line: StocktakeLineResponse): StocktakeLineResponse[] {
  const others = lines.filter((candidate) => candidate.variantId !== line.variantId);
  const index = others.findIndex((candidate) => candidate.variantId > line.variantId);
  return index === -1 ? [...others, line] : [...others.slice(0, index), line, ...others.slice(index)];
}

/**
 * One stocktake. Counting screens render the API's lines as they come: a
 * BLIND line has no expected quantity or variance and none is fetched or
 * shown from anywhere else; a FULL line shows the fields the API returns.
 * Recounts and removals send the line version as last read, posting and
 * cancelling the stocktake version. STOCKTAKE_STALE marks the stale lines and
 * reloads; nothing is resubmitted automatically.
 */
export function StocktakeDetailScreen({
  stocktakeId,
  onBack,
  onUnavailable,
}: {
  readonly stocktakeId: string;
  readonly onBack: () => void;
  readonly onUnavailable: () => void;
}) {
  const store = useInventoryStore();
  const allowed = useAllowed();
  const { units, labels } = useInventory();
  const [state, setState] = useState<DetailState>({ phase: "loading" });
  const [stale, setStale] = useState<Stale>({ variantIds: new Set(), lineCount: 0 });
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<
    { readonly failure: ApiFailure; readonly versionConflict: string } | undefined
  >(undefined);
  const [target, setTarget] = useState<CountTarget | undefined>(undefined);
  const [confirm, setConfirm] = useState<"post" | "cancel" | undefined>(undefined);
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [header, lines] = await Promise.all([store.getStocktake(stocktakeId), store.loadStocktakeLines(stocktakeId)]);
    const failed = header.status === "failed" ? header.failure : lines.status === "failed" ? lines.failure : undefined;
    if (failed !== undefined) {
      if (failed.kind === "api-error" && failed.code === "NOT_FOUND") onUnavailable();
      else setState({ phase: "failed", failure: failed });
      return;
    }
    if (header.status !== "ok" || lines.status !== "ok") return;
    setState({ phase: "ready", stocktake: header.value, lines: lines.value.lines, truncated: lines.value.truncated });
    void store.ensureLabels(lines.value.lines.map((line) => line.variantId));
  }, [store, stocktakeId, onUnavailable]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") return <Loading label="Loading the stocktake…" />;
  if (state.phase === "failed") {
    return (
      <View style={styles.screen}>
        <InventoryFailure failure={state.failure} onRetry={() => void load()} />
        <Button label="Back to stocktakes" onPress={onBack} secondary />
      </View>
    );
  }

  const { stocktake, lines, truncated } = state;
  const draft = stocktake.status === "DRAFT";
  const canCount = draft && allowed.can("inventory:count");
  const canFinish = draft && stocktake.visibility === "FULL" && allowed.can("inventory:count-post");
  const full = stocktake.visibility === "FULL" && lines.every((line) => line.visibility === "FULL");
  const summary = postingSummary(stocktake);

  function nameOf(variantId: string): string {
    const label = labels[variantId];
    return label === undefined ? "Loading item…" : label === null ? "Item not available" : label.name;
  }

  function apply(next: { readonly stocktake: StocktakeResponse; readonly line: StocktakeLineResponse }) {
    setState((current) =>
      current.phase === "ready"
        ? { ...current, stocktake: next.stocktake, lines: placeLine(current.lines, next.line) }
        : current,
    );
  }

  /** Shows the failure and reloads when the API says our copy is out of date. */
  function failed(outcomeFailure: ApiFailure, versionConflict: string) {
    setFailure({ failure: outcomeFailure, versionConflict });
    if (outcomeFailure.kind !== "api-error") return;
    if (outcomeFailure.code === "STOCKTAKE_STALE") {
      const details = outcomeFailure.stale;
      setStale({ variantIds: new Set(details?.staleVariantIds ?? []), lineCount: details?.staleLineCount ?? 0 });
      void load();
    } else if (outcomeFailure.code === "VERSION_CONFLICT" || outcomeFailure.code === "CONFLICT") {
      void load();
    }
  }

  async function post() {
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    const outcome = await store.postStocktake(stocktake.stocktakeId, { expectedVersion: stocktake.version });
    setBusy(false);
    setConfirm(undefined);
    if (outcome.status === "ok") {
      setStale({ variantIds: new Set(), lineCount: 0 });
      setNotice(
        outcome.value.changed
          ? "Stocktake posted. Stock now matches the counts."
          : "This stocktake was already posted.",
      );
      void load();
    } else if (outcome.status === "failed") failed(outcome.failure, STOCKTAKE_VERSION_CONFLICT);
  }

  async function cancel() {
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    const reason = cancelReason.trim();
    const outcome = await store.cancelStocktake(stocktake.stocktakeId, {
      expectedVersion: stocktake.version,
      ...(reason === "" ? {} : { reason }),
    });
    setBusy(false);
    setConfirm(undefined);
    if (outcome.status === "ok") {
      setNotice(
        outcome.value.changed ? "Stocktake cancelled. No stock was changed." : "This stocktake was already cancelled.",
      );
      setState((current) => (current.phase === "ready" ? { ...current, stocktake: outcome.value.stocktake } : current));
    } else if (outcome.status === "failed") failed(outcome.failure, STOCKTAKE_VERSION_CONFLICT);
  }

  async function remove(line: StocktakeLineResponse) {
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    const outcome = await store.removeLine(stocktake.stocktakeId, line.variantId, { expectedVersion: line.version });
    setBusy(false);
    if (outcome.status === "ok") {
      apply(outcome.value);
      setNotice(`${nameOf(line.variantId)} removed from this stocktake.`);
    } else if (outcome.status === "failed") failed(outcome.failure, LINE_VERSION_CONFLICT);
  }

  return (
    <View style={styles.screen}>
      <Heading>Stocktake</Heading>
      {notice === undefined ? null : <Notice>{notice}</Notice>}
      <Text>Status: {STOCKTAKE_STATUS_LABEL[stocktake.status]}</Text>
      <Text>Started: {formatInstant(stocktake.createdAt)}</Text>
      {stocktake.businessDate === null ? null : <Text>Business date: {stocktake.businessDate}</Text>}
      {stocktake.postedAt === null ? null : <Text>Posted: {formatInstant(stocktake.postedAt)}</Text>}
      {stocktake.cancelledAt === null ? null : <Text>Cancelled: {formatInstant(stocktake.cancelledAt)}</Text>}
      <Text>Note: {stocktake.note ?? "None"}</Text>
      <Text>Items counted: {stocktake.countedLineCount}</Text>
      {summary === undefined ? null : <Text>Result: {summary}</Text>}
      {stocktake.visibility === "BLIND" && draft ? (
        <Text style={styles.hint}>Count what is on the shelf. Expected quantities are not shown while counting.</Text>
      ) : null}
      {stale.variantIds.size === 0 && !isStaleFailure(failure?.failure) ? null : (
        <View style={styles.alert} accessibilityRole="alert" accessibilityLiveRegion="assertive">
          <Text>{STALE_MESSAGE}</Text>
          {stale.lineCount > stale.variantIds.size ? (
            <Text>
              {stale.lineCount} items are affected; the first {stale.variantIds.size} are marked below.
            </Text>
          ) : null}
        </View>
      )}
      {failure === undefined || isStaleFailure(failure.failure) ? null : (
        <InventoryFailure
          failure={failure.failure}
          versionConflict={failure.versionConflict}
          conflict={NOT_IN_PROGRESS}
        />
      )}
      {canCount ? (
        <CountForm
          key={target?.variantId ?? "new"}
          stocktakeId={stocktake.stocktakeId}
          target={target}
          lines={lines}
          truncated={truncated}
          onPick={(item) => {
            store.rememberLabel(item);
            setTarget({
              variantId: item.variantId,
              name: item.name,
              stockUnit: item.stockUnit,
              productId: item.productId,
            });
          }}
          onClear={() => {
            setTarget(undefined);
          }}
          onSaved={(result, name) => {
            apply(result);
            setStale((current) => {
              if (!current.variantIds.has(result.line.variantId)) return current;
              const variantIds = new Set(current.variantIds);
              variantIds.delete(result.line.variantId);
              return { variantIds, lineCount: current.lineCount };
            });
            setTarget(undefined);
            setFailure(undefined);
            setNotice(`Count saved for ${name}.`);
          }}
          onFailed={(outcomeFailure) => {
            failed(outcomeFailure, LINE_VERSION_CONFLICT);
          }}
        />
      ) : null}
      {truncated ? <Text style={styles.hint}>Only the first {lines.length} counted items are shown.</Text> : null}
      <Text style={styles.label} accessibilityRole="header">
        Counted items
      </Text>
      {lines.length === 0 ? <Text>No items counted yet.</Text> : null}
      {lines.map((line) => {
        const name = nameOf(line.variantId);
        const removed = line.status === "REMOVED";
        const isStale = stale.variantIds.has(line.variantId);
        return (
          <View key={line.variantId} style={[styles.card, isStale ? styles.invalid : null]}>
            <Text style={styles.strong}>{name}</Text>
            <Text>Counted: {removed ? "Removed" : formatQuantity(line.countedQuantity, units.items)}</Text>
            {full && line.visibility === "FULL" ? <FullLineFacts line={line} /> : null}
            {isStale ? (
              <Text style={styles.error}>Stock changed while counting. Recount.</Text>
            ) : (
              <Text>{removed ? "Removed" : `Counted ${formatInstant(line.countedAt)}`}</Text>
            )}
            {canCount ? (
              <View style={styles.wrap}>
                <Button
                  label={removed ? `Count ${name} again` : `Recount ${name}`}
                  secondary
                  disabled={busy}
                  onPress={() => {
                    const label = labels[line.variantId];
                    setTarget({
                      variantId: line.variantId,
                      name,
                      stockUnit: line.stockUnit,
                      productId: label === undefined || label === null ? undefined : label.productId,
                    });
                  }}
                />
                {removed ? null : (
                  <Button label={`Remove ${name}`} secondary disabled={busy} onPress={() => void remove(line)} />
                )}
              </View>
            ) : null}
          </View>
        );
      })}
      {canFinish ? (
        <View style={styles.card}>
          <Text style={styles.strong} accessibilityRole="header">
            Finish the stocktake
          </Text>
          {confirm === "post" ? (
            <View style={styles.notice} accessibilityLabel="Confirm posting">
              <Text>
                Posting sets the stock of every counted item to its counted quantity. This cannot be undone; a later
                stocktake or adjustment can correct it.
              </Text>
              <View style={styles.wrap}>
                <Button
                  label={busy ? "Posting…" : "Confirm post"}
                  disabled={busy}
                  busy={busy}
                  onPress={() => void post()}
                />
                <Button
                  label="Keep counting"
                  secondary
                  disabled={busy}
                  onPress={() => {
                    setConfirm(undefined);
                  }}
                />
              </View>
            </View>
          ) : confirm === "cancel" ? (
            <View style={styles.notice} accessibilityLabel="Confirm cancelling">
              <Text>Cancelling discards the counts. No stock changes.</Text>
              <Field label="Reason (optional)" value={cancelReason} onChangeText={setCancelReason} editable={!busy} />
              <View style={styles.wrap}>
                <Button
                  label={busy ? "Cancelling…" : "Confirm cancel"}
                  disabled={busy}
                  busy={busy}
                  onPress={() => void cancel()}
                />
                <Button
                  label="Keep the stocktake"
                  secondary
                  disabled={busy}
                  onPress={() => {
                    setConfirm(undefined);
                  }}
                />
              </View>
            </View>
          ) : (
            <View style={styles.wrap}>
              <Button
                label="Post stocktake"
                disabled={busy}
                onPress={() => {
                  setConfirm("post");
                }}
              />
              <Button
                label="Cancel stocktake"
                secondary
                disabled={busy}
                onPress={() => {
                  setConfirm("cancel");
                }}
              />
            </View>
          )}
        </View>
      ) : null}
      <Button label="Back to stocktakes" onPress={onBack} secondary />
    </View>
  );
}

/** Only a FULL line has these fields; the type makes a BLIND line impossible here. */
function FullLineFacts({ line }: { readonly line: Extract<StocktakeLineResponse, { visibility: "FULL" }> }) {
  const { units } = useInventory();
  return (
    <>
      <Text>Expected: {formatQuantity(line.expectedAtCount, units.items)}</Text>
      <Text>Difference: {line.variance === null ? "Not posted" : formatDelta(line.variance, units.items)}</Text>
    </>
  );
}

function CountForm({
  stocktakeId,
  target,
  lines,
  truncated,
  onPick,
  onClear,
  onSaved,
  onFailed,
}: {
  readonly stocktakeId: string;
  readonly target: CountTarget | undefined;
  readonly lines: readonly StocktakeLineResponse[];
  readonly truncated: boolean;
  readonly onPick: (item: ItemLabel) => void;
  readonly onClear: () => void;
  readonly onSaved: (
    result: { readonly stocktake: StocktakeResponse; readonly line: StocktakeLineResponse },
    name: string,
  ) => void;
  readonly onFailed: (failure: ApiFailure) => void;
}) {
  const store = useInventoryStore();
  const { units } = useInventory();
  const packs = usePacks(target?.productId);
  const [entry, setEntry] = useState<QuantityEntry>({ kind: "direct", text: "" });
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const existing = target === undefined ? undefined : lines.find((line) => line.variantId === target.variantId);

  if (target === undefined) {
    return <ItemPicker label="Find an item to count" onPick={onPick} />;
  }
  const definition = definitionFor(units.items, target.stockUnit);

  async function save(current: CountTarget) {
    const count = stocktakeCount(definition, entry);
    if (!count.ok) {
      setError(entryProblemText(count.problem, definition));
      return;
    }
    setError(undefined);
    setBusy(true);
    // A recount sends the line version as last read; a first count sends none.
    const outcome = await store.recordCount(stocktakeId, current.variantId, {
      count: count.value,
      ...(existing === undefined ? {} : { expectedVersion: existing.version }),
    });
    setBusy(false);
    if (outcome.status === "ok") onSaved(outcome.value, current.name);
    else if (outcome.status === "failed") onFailed(outcome.failure);
  }

  return (
    <View style={styles.card} accessibilityLabel={`Count ${target.name}`}>
      <Text style={styles.strong}>
        {existing === undefined ? "Count" : "Recount"} {target.name}
      </Text>
      {existing === undefined && truncated ? (
        <Text style={styles.hint}>If this item was counted already, Tali asks you to recount it from the list.</Text>
      ) : null}
      <QuantityFields
        label="Counted quantity"
        stockUnit={target.stockUnit}
        units={units.items}
        packs={packs}
        entry={entry}
        onChange={setEntry}
        allowLoose
        error={error}
        disabled={busy}
      />
      <View style={styles.wrap}>
        <Button label={busy ? "Saving…" : "Save count"} disabled={busy} busy={busy} onPress={() => void save(target)} />
        <Button label="Choose another item" secondary disabled={busy} onPress={onClear} />
      </View>
    </View>
  );
}
