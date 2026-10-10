import type { StocktakeResponse } from "@tali/shared";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ApiFailure } from "../api/tali-api-client";
import { Choice } from "../catalog/catalog-context";
import { Button, FailureNotice, Field, Heading, Loading, styles } from "../onboarding/ui";
import { formatInstant, STOCKTAKE_STATUS_LABEL } from "./inventory-format";
import { InventoryFailure, useAllowed, useInventory, useInventoryStore } from "./inventory-context";
import type { StocktakeFilter } from "./inventory-store";

const FILTER_LABEL: Readonly<Record<StocktakeFilter, string>> = {
  ALL: "All",
  DRAFT: "In progress",
  POSTED: "Posted",
  CANCELLED: "Cancelled",
};

const IN_PROGRESS = "A stocktake is already in progress. Finish or cancel it before starting another.";
const UNCONFIRMED =
  "Tali could not confirm whether the stocktake was started. Start it again to check (only one is created), or discard this attempt.";

export function postingSummary(stocktake: StocktakeResponse): string | undefined {
  if (stocktake.posting === null) return undefined;
  const { correctionMovementCount, zeroVarianceCount } = stocktake.posting;
  return `${correctionMovementCount} stock ${correctionMovementCount === 1 ? "correction" : "corrections"}, ${zeroVarianceCount} with no difference`;
}

/** Stocktakes by status, newest first as the API lists them, and starting a new one. */
export function StocktakesScreen({ onOpen }: { readonly onOpen: (stocktakeId: string) => void }) {
  const store = useInventoryStore();
  const allowed = useAllowed();
  const { stocktakes, keyed } = useInventory();
  const create = keyed.createStocktake;
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);
  const [inProgress, setInProgress] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    void store.refreshStocktakes();
  }, [store]);

  async function start() {
    setFailure(undefined);
    setInProgress(false);
    setMessage(undefined);
    const outcome = await store.createStocktake(note.trim() === "" ? {} : { note: note.trim() });
    if (outcome.status === "ok") {
      setNote("");
      onOpen(outcome.value.stocktakeId);
    } else if (outcome.status === "failed") {
      if (outcome.failure.kind === "api-error" && outcome.failure.code === "CONFLICT") setInProgress(true);
      else setFailure(outcome.failure);
    } else if (outcome.status === "unconfirmed") setMessage(UNCONFIRMED);
  }

  async function openDraft() {
    const outcome = await store.findDraftStocktake();
    if (outcome.status === "ok") {
      if (outcome.value === undefined) {
        setInProgress(false);
        setMessage("No stocktake is in progress now. You can start one.");
      } else onOpen(outcome.value.stocktakeId);
    } else if (outcome.status === "failed") setFailure(outcome.failure);
  }

  return (
    <View style={styles.screen}>
      <Heading>Stocktakes</Heading>
      {allowed.can("inventory:count") ? (
        <View style={styles.card}>
          <Field
            label="Note (optional)"
            value={note}
            onChangeText={setNote}
            editable={!(create.unconfirmed || create.inFlight)}
          />
          {inProgress ? (
            <View style={styles.alert} accessibilityRole="alert">
              <Text>{IN_PROGRESS}</Text>
              <Button label="Open the stocktake in progress" onPress={() => void openDraft()} />
            </View>
          ) : null}
          {failure === undefined ? null : <InventoryFailure failure={failure} conflict={IN_PROGRESS} />}
          {message === undefined && !(create.unconfirmed && !create.inFlight) ? null : (
            <View style={styles.notice} accessibilityLiveRegion="polite">
              <Text>{message ?? UNCONFIRMED}</Text>
            </View>
          )}
          <View style={styles.wrap}>
            <Button
              label={create.inFlight ? "Starting…" : create.unconfirmed ? "Start again" : "Start stocktake"}
              onPress={() => void start()}
              disabled={create.inFlight}
              busy={create.inFlight}
            />
            {create.unconfirmed && !create.inFlight ? (
              <Button
                label="Discard this attempt"
                secondary
                onPress={() => {
                  store.discardUnconfirmed("createStocktake");
                  setMessage(undefined);
                }}
              />
            ) : null}
          </View>
        </View>
      ) : null}
      <View style={styles.wrap} accessibilityRole="radiogroup" accessibilityLabel="Show">
        {(Object.keys(FILTER_LABEL) as StocktakeFilter[]).map((status) => (
          <Choice
            key={status}
            label={FILTER_LABEL[status]}
            selected={stocktakes.status === status}
            onPress={() => {
              void store.loadStocktakes(status);
            }}
          />
        ))}
      </View>
      {stocktakes.phase === "loading" ? <Loading label="Loading stocktakes…" /> : null}
      {stocktakes.phase === "failed" && stocktakes.failure !== undefined ? (
        <FailureNotice
          failure={stocktakes.failure}
          notFoundScope="business"
          onRetry={() => {
            void store.refreshStocktakes();
          }}
        />
      ) : null}
      {stocktakes.phase === "ready" && stocktakes.items.length === 0 ? <Text>No stocktakes yet.</Text> : null}
      {stocktakes.items.map((stocktake) => {
        const summary = postingSummary(stocktake);
        const started = formatInstant(stocktake.createdAt);
        return (
          <Pressable
            key={stocktake.stocktakeId}
            accessibilityRole="button"
            accessibilityLabel={`Open stocktake started ${started}`}
            onPress={() => {
              onOpen(stocktake.stocktakeId);
            }}
            style={styles.card}
          >
            <Text style={styles.strong}>{STOCKTAKE_STATUS_LABEL[stocktake.status]}</Text>
            <Text>Started {started}</Text>
            {stocktake.businessDate === null ? null : <Text>Business date {stocktake.businessDate}</Text>}
            <Text>
              {stocktake.countedLineCount} {stocktake.countedLineCount === 1 ? "item" : "items"} counted
            </Text>
            {stocktake.note === null ? null : <Text>{stocktake.note}</Text>}
            {summary === undefined ? null : <Text>{summary}</Text>}
          </Pressable>
        );
      })}
      {stocktakes.moreFailure === undefined ? null : (
        <FailureNotice
          failure={stocktakes.moreFailure}
          notFoundScope="business"
          onRetry={() => {
            void store.loadMoreStocktakes();
          }}
          retryDisabled={stocktakes.loadingMore}
        />
      )}
      {stocktakes.nextCursor === null || stocktakes.phase !== "ready" ? null : (
        <Button
          label={stocktakes.loadingMore ? "Loading more…" : "Show more"}
          onPress={() => {
            void store.loadMoreStocktakes();
          }}
          disabled={stocktakes.loadingMore}
          secondary
        />
      )}
    </View>
  );
}
