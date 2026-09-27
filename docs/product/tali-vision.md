# Tali Vision

## One sentence

Tali is an AI-native operating system for small businesses: one trusted place where a business records what
it sells, what it holds, what it is owed, what it owes and what it spends, operated by talking to it as
naturally as the owner would talk to a trusted assistant or bookkeeper.

## The problem

Small businesses run on memory, notebooks, spreadsheets, chat threads and a patchwork of disconnected apps.
The consequences are familiar:

- The owner does not know true profit, true stock levels, or who owes what.
- Money is received through many channels (cash, transfers, mobile money, card, payment links) and is hard to
  match to sales and debts.
- Stock leaks through theft, spoilage and errors that no one notices.
- Credit given to customers is poorly tracked and often never collected.
- Books are reconstructed late, if at all, which blocks access to loans and financial services.
- Existing software expects owners to learn accounting concepts and fill in forms, which many do not have time for.

## The idea

Tali combines three things:

1. **A reliable business core**: products, inventory, sales, customers, receivables, payments, expenses,
   suppliers, purchasing and a double-entry ledger. This is deterministic, auditable software.
2. **An AI layer that removes data-entry work**: owners and staff speak, type, send a photo of a receipt, or
   forward a WhatsApp message. AI interprets it, extracts the details, and proposes the right transaction.
   A person confirms. The core records it correctly.
3. **Connections to where money and conversations actually happen**: WhatsApp, banks, payment providers,
   and later, customer ordering and regulated financial partners.

The AI makes Tali easy. The core makes Tali trustworthy. **AI never bypasses the core.**

## Who it is for

- Owners of small businesses: shops, kiosks, pharmacies, restaurants, salons, wholesalers, small distributors,
  online sellers and service businesses.
- Their staff: cashiers, store keepers, sales people, managers, with limited and role-appropriate permissions.
- Later: their customers (ordering, statements, payment), their suppliers, and their accountants.

## First market

The first private pilot targets **independent provisions / general-retail businesses in Nigeria**, trading in
**NGN**. These businesses typically sell high volumes of low-value items, give informal credit to regular
customers, receive money as cash, bank transfers and POS payments, and often trade through unreliable
connectivity.

Nigeria is the first market, not the only one. Tali is currency-aware from day one (ISO currency codes, one
currency per business in the MVP, no NGN hardcoded in domain logic) and does not hardcode any country's tax
rules. Multi-currency accounting and multi-country tax engines are post-MVP.

## Product surfaces

- **Android-first React Native / Expo mobile app**: the primary merchant experience, designed for intermittent
  connectivity.
- **Web app**: business configuration, data imports, reporting, reconciliation and deeper administrative review.
- **WhatsApp**: a channel adapter onto the same backend and domain services.
- iOS may later use the same React Native codebase; it is not required for the private pilot.

See `docs/product/mvp-scope.md` for the approved MVP scope, tiers and implementation order.

## Long-term platform

- Businesses and staff with roles and permissions
- Products and product variants
- Inventory (movement-based)
- Sales and customers
- Receivables and customer credit
- Payments (multiple channels)
- Expenses
- Suppliers and purchasing
- Bookkeeping and financial ledger
- Reconciliation of bank and provider activity against the books
- Text AI assistant
- Voice AI
- Document and photo capture (receipts, invoices, stock sheets)
- WhatsApp as a primary channel
- Bank and payment-provider integrations
- Customer ordering
- Workflow automation
- Business intelligence and insights
- Embedded financial services through regulated partners (payments, credit, savings, insurance)
- Future ambient store intelligence (e.g. sensing stock and activity in the store). This is post-MVP research;
  the MVP includes only explicit, user-initiated voice capture.

## What success looks like

- An owner can answer "How much did I make this week, what is in stock, and who owes me?" instantly and
  correctly.
- Recording a sale, expense or payment takes seconds, from any channel.
- The books are always up to date and explainable: every number traces back to evidence and to who approved it.
- A business's data is never visible to another business.
- A lender or partner can trust Tali-produced records because they are complete, balanced and auditable.

## What Tali is not

- Not a chatbot bolted onto a spreadsheet. The ledger and inventory are real, rigorous systems.
- Not an autonomous agent that moves money on its own. AI proposes; people and deterministic rules decide.
- Not a bank. Regulated financial services are delivered through licensed partners.
