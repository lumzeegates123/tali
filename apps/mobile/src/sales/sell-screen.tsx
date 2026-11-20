import { useState } from "react";
import { Text, View } from "react-native";
import { describeFailure } from "../api/failure-messages";
import { Choice } from "../catalog/catalog-context";
import { formatMoney } from "../catalog/money-format";
import { Button, FailureNotice, Field, Heading, Loading, styles } from "../onboarding/ui";
import { type DiscountKind, MAX_TENDERS, TENDER_LABEL, type TenderMethod } from "./sale-draft";
import { NOT_VERIFIED_HINT, SaleSummary } from "./sale-summary";
import { useSales, useSalesAllowed, useSalesStore } from "./sales-context";

export const UNCONFIRMED_SALE = "Tali could not confirm whether this sale was recorded.";
export const FINAL_TOTAL_NOTE = "Final total is calculated by Tali when the sale is recorded.";
export const CHANGE_NOTE = "Change is calculated by Tali when the sale is recorded.";

const METHODS: readonly TenderMethod[] = ["CASH", "BANK_TRANSFER", "POS_CARD", "OTHER"];
const DISCOUNT_LABEL: Readonly<Record<DiscountKind, string>> = {
  NONE: "No discount",
  FIXED: "Amount off",
  PERCENT: "Percent off",
};

const ADD_RESULT_TEXT = {
  alreadyInCart: "This product is already in the cart. Change its quantity there.",
  priceNotSet: "Price not set",
  cartFull: "The cart is full.",
} as const;

/**
 * The Sell tab (`sales:create`): find active products, build a cart in
 * stock units, enter tenders and record the sale. Prices shown are the
 * catalog's displayed prices; the final total and any change are calculated
 * by Tali when the sale is recorded and shown on the receipt.
 */
export function SellScreen({ onCheckHistory }: { readonly onCheckHistory: () => void }) {
  const store = useSalesStore();
  const allowed = useSalesAllowed();
  const { reference, search, lines, tenders, checkout, receipt } = useSales();
  const [query, setQuery] = useState("");
  const [addNotice, setAddNotice] = useState<string | undefined>(undefined);
  const currency = reference.currency;
  const locked = checkout.phase !== "editing";

  if (reference.phase === "loading") return <Loading label="Loading sales…" />;
  if (reference.phase === "failed" || currency === undefined) {
    return reference.failure === undefined ? null : (
      <FailureNotice
        failure={reference.failure}
        notFoundScope="business"
        onRetry={() => {
          void store.loadReference();
        }}
      />
    );
  }

  if (receipt !== undefined) {
    return (
      <View style={styles.screen}>
        <Heading>Receipt</Heading>
        <View style={styles.notice} accessibilityLiveRegion="polite">
          <Text>Sale recorded.</Text>
        </View>
        <SaleSummary sale={receipt} currency={currency} units={reference.units} />
        <Button
          label="New sale"
          onPress={() => {
            store.clearReceipt();
          }}
        />
      </View>
    );
  }

  const rejection = checkout.serverTotal === undefined ? checkout.failure : undefined;

  return (
    <View style={styles.screen}>
      <Heading>Sell</Heading>
      <Field label="Find a product" value={query} onChangeText={setQuery} />
      <Button
        label="Search"
        secondary
        onPress={() => {
          setAddNotice(undefined);
          void store.searchProducts(query);
        }}
      />
      {search.phase === "loading" ? <Loading label="Searching…" /> : null}
      {search.phase === "failed" && search.failure !== undefined ? (
        <FailureNotice failure={search.failure} notFoundScope="business" />
      ) : null}
      {search.phase === "ready" && search.items.length === 0 ? <Text>No active products match.</Text> : null}
      {search.items.map((product) => (
        <View key={product.variantId} style={styles.card}>
          <Text style={styles.strong}>{product.name}</Text>
          {product.sku === null ? null : <Text>SKU: {product.sku}</Text>}
          <Text>
            {product.sellingPrice === null
              ? "Price not set"
              : `Displayed price: ${formatMoney(product.sellingPrice, currency)} per ${product.stockUnit}`}
          </Text>
          <Button
            label={`Add ${product.name}`}
            secondary
            disabled={locked || product.sellingPrice === null}
            onPress={() => {
              const result = store.addProduct(product);
              setAddNotice(result === "added" || result === "locked" ? undefined : ADD_RESULT_TEXT[result]);
            }}
          />
        </View>
      ))}
      {addNotice === undefined ? null : (
        <View style={styles.notice} accessibilityLiveRegion="polite">
          <Text>{addNotice}</Text>
        </View>
      )}

      <Text style={styles.label}>Cart</Text>
      {lines.length === 0 ? <Text>The cart is empty.</Text> : null}
      {lines.map((line) => {
        const errors = checkout.lineErrors[line.variantId] ?? {};
        const notice = checkout.lineNotices[line.variantId];
        return (
          <View key={line.variantId} style={styles.card} accessibilityLabel={`Cart line ${line.name}`}>
            <Text style={styles.strong}>{line.name}</Text>
            <Text>
              Displayed price: {formatMoney(line.displayedPrice, currency)} per {line.stockUnit}
            </Text>
            <Field
              label={`Quantity of ${line.name} (${line.stockUnit})`}
              value={line.quantityText}
              keyboardType="decimal-pad"
              editable={!locked}
              error={errors.quantity}
              onChangeText={(value) => {
                store.updateLine(line.variantId, { quantityText: value });
              }}
            />
            {allowed.discount ? (
              <>
                <View
                  style={styles.wrap}
                  accessibilityRole="radiogroup"
                  accessibilityLabel={`Discount on ${line.name}`}
                >
                  {(["NONE", "FIXED", "PERCENT"] as const).map((kind) => (
                    <Choice
                      key={kind}
                      label={DISCOUNT_LABEL[kind]}
                      selected={line.discountKind === kind}
                      disabled={locked}
                      onPress={() => {
                        store.updateLine(line.variantId, { discountKind: kind });
                      }}
                    />
                  ))}
                </View>
                {line.discountKind === "NONE" ? null : (
                  <Field
                    label={
                      line.discountKind === "FIXED"
                        ? `Discount amount on ${line.name} (${currency.code})`
                        : `Discount percent on ${line.name}`
                    }
                    value={line.discountText}
                    keyboardType="decimal-pad"
                    editable={!locked}
                    error={errors.discount}
                    onChangeText={(value) => {
                      store.updateLine(line.variantId, { discountText: value });
                    }}
                  />
                )}
                {line.discountKind === "NONE" && errors.discount !== undefined ? (
                  <Text style={styles.error}>Error: {errors.discount}</Text>
                ) : null}
              </>
            ) : null}
            {notice === undefined ? null : (
              <Text style={styles.error} accessibilityLiveRegion="polite">
                {notice}
              </Text>
            )}
            <Button
              label={`Remove ${line.name}`}
              secondary
              disabled={locked}
              onPress={() => {
                store.removeLine(line.variantId);
              }}
            />
          </View>
        );
      })}
      <Text style={styles.hint}>{FINAL_TOTAL_NOTE}</Text>

      <Text style={styles.label}>Tenders</Text>
      {tenders.map((tender, index) => {
        const errors = checkout.tenderErrors[tender.rowId] ?? {};
        const name = `tender ${index + 1}`;
        return (
          <View key={tender.rowId} style={styles.card} accessibilityLabel={`Tender ${index + 1}`}>
            <View style={styles.wrap} accessibilityRole="radiogroup" accessibilityLabel={`Method of ${name}`}>
              {METHODS.map((method) => (
                <Choice
                  key={method}
                  label={TENDER_LABEL[method]}
                  selected={tender.method === method}
                  disabled={locked}
                  onPress={() => {
                    store.updateTender(tender.rowId, { method });
                  }}
                />
              ))}
            </View>
            {tender.method === "CASH" ? null : (
              <>
                <Text style={styles.strong}>Not verified</Text>
                <Text style={styles.hint}>{NOT_VERIFIED_HINT}</Text>
              </>
            )}
            <Field
              label={`Amount of ${name} (${currency.code})`}
              value={tender.amountText}
              keyboardType="decimal-pad"
              editable={!locked}
              error={errors.amount}
              onChangeText={(value) => {
                store.updateTender(tender.rowId, { amountText: value });
              }}
            />
            {tender.method === "CASH" ? (
              <Field
                label={`Cash received for ${name} (${currency.code}, optional)`}
                hint={CHANGE_NOTE}
                value={tender.cashReceivedText}
                keyboardType="decimal-pad"
                editable={!locked}
                error={errors.cashReceived}
                onChangeText={(value) => {
                  store.updateTender(tender.rowId, { cashReceivedText: value });
                }}
              />
            ) : (
              <Field
                label={`Reference of ${name} (optional)`}
                value={tender.reference}
                editable={!locked}
                error={errors.reference}
                onChangeText={(value) => {
                  store.updateTender(tender.rowId, { reference: value });
                }}
              />
            )}
            {tenders.length > 1 ? (
              <Button
                label={`Remove ${name}`}
                secondary
                disabled={locked}
                onPress={() => {
                  store.removeTender(tender.rowId);
                }}
              />
            ) : null}
          </View>
        );
      })}
      {tenders.length < MAX_TENDERS ? (
        <Button
          label="Add tender"
          secondary
          disabled={locked}
          onPress={() => {
            store.addTender("CASH");
          }}
        />
      ) : null}

      {checkout.formError === undefined ? null : <Text style={styles.error}>Error: {checkout.formError}</Text>}
      {checkout.serverTotal === undefined ? null : (
        <View style={styles.alert} accessibilityRole="alert">
          {checkout.failure === undefined ? null : <Text>{describeFailure(checkout.failure).text}</Text>}
          <Text testID="server-total">Server total: {formatMoney(checkout.serverTotal, currency)}</Text>
          {tenders.length === 1 ? (
            <Button
              label="Use the server total as the tender amount"
              secondary
              disabled={locked}
              onPress={() => {
                store.useServerTotal();
              }}
            />
          ) : null}
        </View>
      )}
      {rejection === undefined ? null : <FailureNotice failure={rejection} notFoundScope="business" />}
      {checkout.phase === "unconfirmed" ? (
        <View style={styles.alert} accessibilityRole="alert">
          <Text>{UNCONFIRMED_SALE}</Text>
          <Text>Submitting again with the same details never records the sale twice.</Text>
          <Button
            label="Submit again with same details"
            onPress={() => {
              void store.resubmitSale();
            }}
          />
          <Button
            label="Discard and check Sales history"
            secondary
            onPress={() => {
              store.discardUnconfirmedSale();
              onCheckHistory();
            }}
          />
        </View>
      ) : (
        <Button
          label={checkout.phase === "submitting" ? "Recording…" : "Record sale"}
          disabled={checkout.phase === "submitting" || lines.length === 0}
          busy={checkout.phase === "submitting"}
          onPress={() => {
            void store.submitSale(allowed.discount);
          }}
        />
      )}
    </View>
  );
}
