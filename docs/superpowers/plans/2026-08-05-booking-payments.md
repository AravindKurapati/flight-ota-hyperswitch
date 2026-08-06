# Booking Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hosted US flight-OTA prototype that takes a traveller from itinerary selection to a real completed payment on the Hyperswitch hosted sandbox, holding funds at booking and capturing only once a ticket is issued.

**Architecture:** Next.js App Router on Vercel with Neon Postgres. A single server-only module owns all Hyperswitch calls; a domain module owns the booking state machine and is the sole writer to `bookings`; route handlers stay thin. Flight payments use manual capture through Stripe test mode; a trip-protection add-on routes to the `fauxpay` dummy connector via a rule-based routing rule. Idempotency is enforced by database constraints at four mutation points rather than by application logic.

**Tech Stack:** TypeScript, Next.js 15 (App Router), React 19, Neon Postgres, Drizzle ORM, Vitest, `@juspay-tech/hyper-js` + `@juspay-tech/react-hyper-js`, `ulid`, `zod`.

## Global Constraints

These apply to every task. Violating any of them is a defect regardless of whether the task mentions it.

- **All monetary amounts are integers in minor units.** Never a float, never a decimal string. `$654.00` is `65400`.
- **The Hyperswitch API key and `sk_test_` never reach the browser.** Every module that reads them starts with `import 'server-only'`.
- **Sandbox base URL is `https://sandbox.hyperswitch.io`.** Publishable key starts `pk_snd_`. The v1 API only — do not copy v2 snippets from the docs, the field names differ.
- **`profile_id` is passed explicitly on every payment create.** Omitting it produces "no eligible connector", which presents as a routing bug.
- **`authentication_type` is set explicitly.** The v1 create default is `three_ds`; flight bookings must send `no_three_ds`.
- **`capture_method` is set explicitly.** The default is `automatic`; flight bookings must send `manual`.
- **`hs_payment_id` is exactly 30 characters.** Hyperswitch enforces `minLength: 30, maxLength: 30`.
- **No live PSP credentials.** Stripe test mode (`sk_test_`) only.
- **Every payment behaviour decision gets a line in `DECISIONS.md`**: what was chosen, what was rejected, why.
- **Spec is `FEATURE_booking_payments.md`; schema of record is `SCHEMA.md`.** If an implementation detail diverges from either, update the document in the same commit.

---

## File Structure

```
scripts/smoke.ts                      standalone sandbox verification, no framework
db/schema.ts                          Drizzle table definitions, mirrors SCHEMA.md
db/index.ts                           connection singleton
lib/env.ts                            validated environment, server-only
lib/ids.ts                            ULID generation + hs_payment_id derivation
lib/money.ts                          minor-unit helpers and fare breakdown
lib/hyperswitch.types.ts              request/response types for the v1 API
lib/hyperswitch.ts                    sole Hyperswitch client, server-only
lib/connector-capabilities.ts         static capability table + assertion
lib/state-machine.ts                  pure booking transition table
lib/events.ts                         booking_events append-only writer
lib/idempotency.ts                    response replay store
lib/ticketing.ts                      simulated GDS
lib/bookings/index.ts                 re-exports; the only import site for consumers
lib/bookings/shared.ts                PNR generator, DOT window constant, common queries
lib/bookings/create.ts                createBooking            (Task 10)
lib/bookings/issue.ts                 issueTicket              (Task 13)
lib/bookings/cancel.ts                cancelWithinWindow       (Task 14)
lib/bookings/refund.ts                refundBooking            (Task 15)
lib/bookings/protection.ts            addTripProtection        (Task 17)
lib/bookings/ancillary.ts             chargeAncillary          (Task 18)
lib/webhooks.ts                       HMAC-SHA512 verification
data/itineraries.ts                   hardcoded fixtures
app/page.tsx                          itinerary list
app/checkout/[bookingId]/page.tsx     HyperLoader mount
app/confirmation/[bookingId]/page.tsx post-redirect status
app/ops/page.tsx                      operations console
app/api/bookings/route.ts             flow A
app/api/bookings/[id]/protection/route.ts   flow G
app/api/bookings/[id]/issue/route.ts        flows C, D
app/api/bookings/[id]/cancel/route.ts       flow E
app/api/bookings/[id]/refund/route.ts       flow F
app/api/bookings/[id]/ancillary/route.ts    flow H
app/api/webhooks/hyperswitch/route.ts
tests/unit/*.test.ts
tests/integration/*.test.ts
```

Split by responsibility, not layer. `lib/hyperswitch.ts` is the only file that knows the wire format; the `lib/bookings/` package is the only writer of booking state.

**`lib/bookings/` is a directory, one file per operation.** Six tasks add booking operations, and a single file would land past 400 lines — more than any one subagent needs in context, and six tasks all editing the same file. `index.ts` re-exports every operation, so consumers and tests import from `../../lib/bookings` exactly as if it were still one module. Each operation file owns one exported function; anything two of them need lives in `shared.ts`.

If any single file grows past ~250 lines during implementation, that is the signal it has absorbed a responsibility that belongs elsewhere.

**Import paths inside `lib/bookings/`.** Code blocks in Tasks 13–18 are written as though they sit in `lib/`, one level up from where they actually land. When placing them, adjust: sibling `lib` modules become `../hyperswitch`, `../ids`, `../events`; the database becomes `../../db`; fixtures become `../../data/itineraries`; and the shared helpers (`pnr`, `DOT_VOID_WINDOW_MS`, `flightPaymentFor`, `Passenger`) come from `./shared`. Where a task's code selects the flight payment inline, use `flightPaymentFor()` instead of repeating the query.

---

## Sequencing note

Tasks 1–2 exist to kill the highest-severity assumption in the build before any UI is written: **that manual capture works on the configured connector.** The dummy connector cannot capture — verified from source — so if the Stripe test connector also fails, the entire architecture changes. That must surface in the first hour, not on day three.

If time runs short, Tasks 16 (trip protection) and 14 (refund) are the ones to drop. Tasks 1–13 and 17 carry the architectural argument.

---

### Task 1: Project scaffold and environment validation

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `vitest.config.ts`
- Create: `lib/env.ts`
- Test: `tests/unit/env.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `env` — a frozen object with `HYPERSWITCH_API_KEY: string`, `HYPERSWITCH_PUBLISHABLE_KEY: string`, `HYPERSWITCH_PROFILE_ID: string`, `HYPERSWITCH_WEBHOOK_SECRET: string`, `DATABASE_URL: string`, `APP_BASE_URL: string`. Throws at import time if any is missing.

- [ ] **Step 1: Write `.gitignore` before anything else exists**

This goes first deliberately. The repository is public and an `.env` committed once is compromised forever.

```gitignore
node_modules/
.next/
.env
.env.local
.env*.local
.vercel
*.tsbuildinfo
coverage/
```

- [ ] **Step 2: Initialise the project**

```bash
npm init -y
npm install next@latest react@latest react-dom@latest
npm install drizzle-orm @neondatabase/serverless ulid zod server-only
npm install -D typescript @types/node @types/react vitest drizzle-kit tsx dotenv
```

- [ ] **Step 3: Write `.env.example`**

```bash
# Hyperswitch sandbox — https://app.hyperswitch.io
HYPERSWITCH_API_KEY=snd_xxxxxxxxxxxxxxxxxxxxxxxx
HYPERSWITCH_PUBLISHABLE_KEY=pk_snd_xxxxxxxxxxxxxxxxxxxxxxxx
HYPERSWITCH_PROFILE_ID=pro_xxxxxxxxxxxxxxxxxxxxxxxx
HYPERSWITCH_WEBHOOK_SECRET=

# Neon
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require

# Stable production alias — webhooks are registered against this
APP_BASE_URL=https://your-app.vercel.app
```

- [ ] **Step 4: Write the failing test**

```typescript
// tests/unit/env.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('env', () => {
  it('throws when a required variable is missing', async () => {
    const original = process.env.HYPERSWITCH_API_KEY;
    delete process.env.HYPERSWITCH_API_KEY;
    vi.resetModules();
    await expect(import('../../lib/env')).rejects.toThrow(/HYPERSWITCH_API_KEY/);
    process.env.HYPERSWITCH_API_KEY = original;
  });
});
```

- [ ] **Step 5: Run it and confirm it fails**

Run: `npx vitest run tests/unit/env.test.ts`
Expected: FAIL — cannot resolve `../../lib/env`.

- [ ] **Step 6: Implement `lib/env.ts`**

```typescript
import 'server-only';
import { z } from 'zod';

const schema = z.object({
  HYPERSWITCH_API_KEY: z.string().min(1),
  HYPERSWITCH_PUBLISHABLE_KEY: z.string().startsWith('pk_snd_'),
  HYPERSWITCH_PROFILE_ID: z.string().min(1),
  HYPERSWITCH_WEBHOOK_SECRET: z.string(),
  DATABASE_URL: z.string().url(),
  APP_BASE_URL: z.string().url(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error(`Invalid or missing environment variables: ${missing}`);
}

export const env = Object.freeze(parsed.data);
```

The `pk_snd_` prefix check is deliberate: it fails loudly if a production key is ever pasted in.

- [ ] **Step 7: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/env.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add .gitignore package.json tsconfig.json .env.example vitest.config.ts lib/env.ts tests/unit/env.test.ts
git commit -m "chore: project scaffold with validated environment"
```

---

### Task 2: Sandbox smoke test — the critical path

**Files:**
- Create: `scripts/smoke.ts`

**Interfaces:**
- Consumes: `env` from Task 1
- Produces: nothing consumed by later tasks. This is a throwaway probe whose only job is to answer one question before anything is built on top of it.

**Manual prerequisites — do these in the dashboard first.** The plan cannot automate account creation.

1. Sign up at `app.hyperswitch.io` (sandbox). Note the merchant id.
2. Copy the API key (`snd_…`) and publishable key (`pk_snd_…`) from Developers.
3. Note the business profile id (`pro_…`). Everything is profile-scoped.
4. Create a free Stripe account, stay in **test mode**, copy the secret key (`sk_test_…`).
5. Connectors → connect **Stripe**, paste `sk_test_…`, enable card credit + debit, Visa / Mastercard / Amex / Discover.
6. Connectors → connect **fauxpay** (dummy). Accept the prefilled credentials.
7. Workflow → Routing → Rule-Based: `amount < 5000` → `fauxpay`. Save **and activate**.
8. Workflow → Routing → Default Fallback: **Stripe only.** Do not include fauxpay. This is decision D-006 and it is the guard that stops a flight authorization stranding on a connector that cannot release funds.
9. Populate `.env` from steps 2–3.

- [ ] **Step 1: Write the smoke script**

```typescript
// scripts/smoke.ts — run with: npx tsx -r dotenv/config scripts/smoke.ts
const BASE = 'https://sandbox.hyperswitch.io';
const KEY = process.env.HYPERSWITCH_API_KEY!;
const PROFILE = process.env.HYPERSWITCH_PROFILE_ID!;

async function hs(path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'api-key': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  // 1. Authorize only. Amount is above the $50 routing threshold so this must
  //    land on Stripe, not fauxpay.
  const created = await hs('/payments', {
    amount: 65400,
    currency: 'USD',
    confirm: true,
    capture_method: 'manual',
    authentication_type: 'no_three_ds',
    profile_id: PROFILE,
    description: 'smoke: manual capture probe',
    payment_method: 'card',
    payment_method_type: 'credit',
    payment_method_data: {
      card: {
        card_number: '4242424242424242',
        card_exp_month: '12',
        card_exp_year: '2030',
        card_cvc: '123',
        card_holder_name: 'Smoke Test',
      },
    },
  });

  console.log('status       :', created.status);
  console.log('connector    :', created.connector);
  console.log('capturable   :', created.amount_capturable);

  if (created.status !== 'requires_capture') {
    throw new Error(`EXPECTED requires_capture, GOT ${created.status}`);
  }

  // 2. Partial capture.
  const captured = await hs(`/payments/${created.payment_id}/capture`, {
    amount_to_capture: 60000,
  });
  console.log('after capture:', captured.status);

  // 3. A second authorization, then void it.
  const second = await hs('/payments', {
    amount: 65400,
    currency: 'USD',
    confirm: true,
    capture_method: 'manual',
    authentication_type: 'no_three_ds',
    profile_id: PROFILE,
    payment_method: 'card',
    payment_method_type: 'credit',
    payment_method_data: {
      card: {
        card_number: '4242424242424242',
        card_exp_month: '12',
        card_exp_year: '2030',
        card_cvc: '123',
        card_holder_name: 'Smoke Test',
      },
    },
  });
  const voided = await hs(`/payments/${second.payment_id}/cancel`, {
    cancellation_reason: 'smoke_test',
  });
  console.log('after void   :', voided.status);

  // 4. Decline card must fail, not throw a transport error.
  try {
    const declined = await hs('/payments', {
      amount: 65400,
      currency: 'USD',
      confirm: true,
      capture_method: 'manual',
      authentication_type: 'no_three_ds',
      profile_id: PROFILE,
      payment_method: 'card',
      payment_method_type: 'credit',
      payment_method_data: {
        card: {
          card_number: '4000000000000002',
          card_exp_month: '12',
          card_exp_year: '2030',
          card_cvc: '123',
          card_holder_name: 'Smoke Test',
        },
      },
    });
    console.log('decline      :', declined.status, declined.error_message);
  } catch (e) {
    console.log('decline threw:', (e as Error).message);
  }

  console.log('\nSMOKE PASSED — manual capture, partial capture and void all work.');
}

main().catch((e) => {
  console.error('\nSMOKE FAILED:', e.message);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

Run: `npx tsx -r dotenv/config scripts/smoke.ts`

Expected output: `status: requires_capture`, `connector: stripe`, capture returns `partially_captured`, void returns `cancelled`, decline reports a failed status with an error message.

- [ ] **Step 3: Interpret the result before proceeding**

This is a decision point, not a formality.

- `connector` is anything other than `stripe` → routing is misconfigured. Fix the dashboard rule before writing any code; a flight payment on `fauxpay` is unrecoverable.
- `status` is `succeeded` rather than `requires_capture` → `capture_method` was ignored. Verify it was sent and that the connector is Stripe.
- Capture returns `NotImplemented` → the connector cannot capture. **Stop.** The architecture in the spec does not hold; return to the spec before continuing.
- Anything else fails → resolve before Task 3. Every subsequent task assumes this passed.

- [ ] **Step 4: Record the outcome**

Append a line to `DECISIONS.md` under a new `## Verification` section stating the date, the connector that handled the payment, and that manual capture, partial capture and void were confirmed working on the hosted sandbox.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke.ts DECISIONS.md
git commit -m "test: verify manual capture, partial capture and void on sandbox"
```

---

### Task 3: Identity and money primitives

**Files:**
- Create: `lib/ids.ts`, `lib/money.ts`
- Test: `tests/unit/ids.test.ts`, `tests/unit/money.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `newId(): string` — a 26-character ULID
  - `toHsPaymentId(id: string): string` — `'pay_' + id`, exactly 30 chars, throws otherwise
  - `usd(major: number): number` — dollars to minor units
  - `formatUsd(minor: number): string` — `65400` to `"$654.00"`
  - `fareBreakdown(baseMinor: number): { base: number; excise: number; segment: number; september11: number; total: number }`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/ids.test.ts
import { describe, it, expect } from 'vitest';
import { newId, toHsPaymentId } from '../../lib/ids';

describe('ids', () => {
  it('generates 26-character ULIDs', () => {
    expect(newId()).toHaveLength(26);
  });

  it('derives a payment id of exactly 30 characters, every time', () => {
    for (let i = 0; i < 1000; i++) {
      expect(toHsPaymentId(newId())).toHaveLength(30);
    }
  });

  it('rejects an id that would not produce exactly 30 characters', () => {
    expect(() => toHsPaymentId('too-short')).toThrow(/30/);
  });
});
```

```typescript
// tests/unit/money.test.ts
import { describe, it, expect } from 'vitest';
import { usd, formatUsd, fareBreakdown } from '../../lib/money';

describe('money', () => {
  it('converts dollars to minor units as integers', () => {
    expect(usd(654)).toBe(65400);
    expect(usd(654.4)).toBe(65440);
  });

  it('never produces a fractional minor unit', () => {
    expect(Number.isInteger(usd(19.99))).toBe(true);
    expect(usd(19.99)).toBe(1999);
  });

  it('formats minor units for display', () => {
    expect(formatUsd(65400)).toBe('$654.00');
  });

  it('produces a breakdown whose parts sum exactly to the total', () => {
    const b = fareBreakdown(50000);
    expect(b.base + b.excise + b.segment + b.september11).toBe(b.total);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/unit/ids.test.ts tests/unit/money.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement `lib/ids.ts`**

```typescript
import { ulid } from 'ulid';

const PREFIX = 'pay_';
const HS_PAYMENT_ID_LENGTH = 30;

export function newId(): string {
  return ulid();
}

export function toHsPaymentId(id: string): string {
  const candidate = `${PREFIX}${id}`;
  if (candidate.length !== HS_PAYMENT_ID_LENGTH) {
    throw new Error(
      `hs_payment_id must be exactly ${HS_PAYMENT_ID_LENGTH} chars, got ${candidate.length} from id "${id}"`,
    );
  }
  return candidate;
}
```

A ULID is 26 characters, so `'pay_'` plus a ULID is exactly the 30 Hyperswitch demands. The throw exists because a silently wrong-length id would be rejected by the API with a message that does not obviously point back here.

- [ ] **Step 4: Implement `lib/money.ts`**

```typescript
/** Dollars to minor units. Rounds to avoid float drift: 19.99 * 100 = 1998.9999... */
export function usd(major: number): number {
  return Math.round(major * 100);
}

export function formatUsd(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

const EXCISE_RATE = 0.075;        // US domestic air transportation excise tax
const SEGMENT_FEE = 505;          // per segment, minor units
const SEPTEMBER_11_FEE = 560;     // per one-way trip, minor units

export function fareBreakdown(baseMinor: number) {
  const excise = Math.round(baseMinor * EXCISE_RATE);
  const segment = SEGMENT_FEE;
  const september11 = SEPTEMBER_11_FEE;
  return {
    base: baseMinor,
    excise,
    segment,
    september11,
    total: baseMinor + excise + segment + september11,
  };
}
```

The total is computed by summation rather than independently, so `order_details[]` can never disagree with `amount` — Hyperswitch validates that they match.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run tests/unit/ids.test.ts tests/unit/money.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/ids.ts lib/money.ts tests/unit/ids.test.ts tests/unit/money.test.ts
git commit -m "feat: identity derivation and minor-unit money helpers"
```

---

### Task 4: Booking state machine

**Files:**
- Create: `lib/state-machine.ts`
- Test: `tests/unit/state-machine.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type BookingState = 'QUOTED' | 'PAYMENT_FAILED' | 'AUTHORIZED' | 'TICKETING' | 'TICKETED' | 'VOIDED' | 'REFUNDED' | 'PARTIALLY_REFUNDED'`
  - `type BookingEvent = 'AUTH_SUCCEEDED' | 'AUTH_DECLINED' | 'RETRY' | 'ISSUANCE_STARTED' | 'ISSUANCE_SUCCEEDED' | 'ISSUANCE_FAILED_RETRYABLE' | 'ISSUANCE_FAILED_TERMINAL' | 'CANCELLED_IN_WINDOW' | 'REFUNDED_FULL' | 'REFUNDED_PARTIAL'`
  - `nextState(from: BookingState, event: BookingEvent): BookingState` — throws on an illegal transition
  - `canTransition(from: BookingState, event: BookingEvent): boolean`
  - `TERMINAL_STATES: ReadonlySet<BookingState>`

Pure. No database, no network, no clock. This is the file that encodes the spec's invariants, so it is the one worth testing exhaustively.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/state-machine.test.ts
import { describe, it, expect } from 'vitest';
import { nextState, canTransition, TERMINAL_STATES } from '../../lib/state-machine';

describe('booking state machine', () => {
  it('authorizes from quoted', () => {
    expect(nextState('QUOTED', 'AUTH_SUCCEEDED')).toBe('AUTHORIZED');
  });

  it('returns to quoted on retry after a decline, so the intent is reused', () => {
    expect(nextState('QUOTED', 'AUTH_DECLINED')).toBe('PAYMENT_FAILED');
    expect(nextState('PAYMENT_FAILED', 'RETRY')).toBe('QUOTED');
  });

  it('holds in TICKETING on a retryable issuance failure', () => {
    expect(nextState('TICKETING', 'ISSUANCE_FAILED_RETRYABLE')).toBe('TICKETING');
  });

  it('voids on a terminal issuance failure', () => {
    expect(nextState('TICKETING', 'ISSUANCE_FAILED_TERMINAL')).toBe('VOIDED');
  });

  it('allows a DOT cancellation only while authorized', () => {
    expect(nextState('AUTHORIZED', 'CANCELLED_IN_WINDOW')).toBe('VOIDED');
    expect(canTransition('TICKETED', 'CANCELLED_IN_WINDOW')).toBe(false);
  });

  it('never reaches TICKETED without passing through TICKETING', () => {
    expect(canTransition('AUTHORIZED', 'ISSUANCE_SUCCEEDED')).toBe(false);
    expect(nextState('AUTHORIZED', 'ISSUANCE_STARTED')).toBe('TICKETING');
    expect(nextState('TICKETING', 'ISSUANCE_SUCCEEDED')).toBe('TICKETED');
  });

  it('allows a partial refund to become full', () => {
    expect(nextState('PARTIALLY_REFUNDED', 'REFUNDED_FULL')).toBe('REFUNDED');
  });

  it('treats VOIDED and REFUNDED as terminal', () => {
    expect(TERMINAL_STATES.has('VOIDED')).toBe(true);
    expect(TERMINAL_STATES.has('REFUNDED')).toBe(true);
    expect(TERMINAL_STATES.has('PARTIALLY_REFUNDED')).toBe(false);
  });

  it('throws on an illegal transition rather than silently ignoring it', () => {
    expect(() => nextState('VOIDED', 'AUTH_SUCCEEDED')).toThrow(/VOIDED/);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/unit/state-machine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/state-machine.ts`**

```typescript
export type BookingState =
  | 'QUOTED'
  | 'PAYMENT_FAILED'
  | 'AUTHORIZED'
  | 'TICKETING'
  | 'TICKETED'
  | 'VOIDED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED';

export type BookingEvent =
  | 'AUTH_SUCCEEDED'
  | 'AUTH_DECLINED'
  | 'RETRY'
  | 'ISSUANCE_STARTED'
  | 'ISSUANCE_SUCCEEDED'
  | 'ISSUANCE_FAILED_RETRYABLE'
  | 'ISSUANCE_FAILED_TERMINAL'
  | 'CANCELLED_IN_WINDOW'
  | 'REFUNDED_FULL'
  | 'REFUNDED_PARTIAL';

const TRANSITIONS: Record<BookingState, Partial<Record<BookingEvent, BookingState>>> = {
  QUOTED: {
    AUTH_SUCCEEDED: 'AUTHORIZED',
    AUTH_DECLINED: 'PAYMENT_FAILED',
  },
  PAYMENT_FAILED: {
    RETRY: 'QUOTED',
  },
  AUTHORIZED: {
    ISSUANCE_STARTED: 'TICKETING',
    CANCELLED_IN_WINDOW: 'VOIDED',
  },
  TICKETING: {
    ISSUANCE_SUCCEEDED: 'TICKETED',
    ISSUANCE_FAILED_RETRYABLE: 'TICKETING',
    ISSUANCE_FAILED_TERMINAL: 'VOIDED',
  },
  TICKETED: {
    REFUNDED_FULL: 'REFUNDED',
    REFUNDED_PARTIAL: 'PARTIALLY_REFUNDED',
  },
  PARTIALLY_REFUNDED: {
    REFUNDED_FULL: 'REFUNDED',
    REFUNDED_PARTIAL: 'PARTIALLY_REFUNDED',
  },
  VOIDED: {},
  REFUNDED: {},
};

export const TERMINAL_STATES: ReadonlySet<BookingState> = new Set<BookingState>([
  'VOIDED',
  'REFUNDED',
]);

export function canTransition(from: BookingState, event: BookingEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export function nextState(from: BookingState, event: BookingEvent): BookingState {
  const to = TRANSITIONS[from][event];
  if (to === undefined) {
    throw new Error(`Illegal transition: ${from} cannot handle ${event}`);
  }
  return to;
}
```

`AUTHORIZED` deliberately has no `ISSUANCE_SUCCEEDED` edge. That is invariant 1 from the spec — capture never precedes issuance — expressed as an unreachable transition rather than a comment.

- [ ] **Step 4: Run and confirm pass**

Run: `npx vitest run tests/unit/state-machine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/state-machine.ts tests/unit/state-machine.test.ts
git commit -m "feat: booking state machine with invariants as unreachable transitions"
```

---

### Task 5: Database schema and migrations

**Files:**
- Create: `db/schema.ts`, `db/index.ts`, `drizzle.config.ts`
- Test: `tests/integration/schema.test.ts`

**Interfaces:**
- Consumes: `env` from Task 1
- Produces: `db` (Drizzle client), and table objects `bookings`, `payments`, `refunds`, `bookingEvents`, `idempotencyRecords`

Mirrors `SCHEMA.md` exactly. If they diverge, `SCHEMA.md` is wrong and must be updated in the same commit.

- [ ] **Step 1: Write `db/schema.ts`**

```typescript
import {
  pgTable, pgEnum, text, bigint, jsonb, timestamp, char,
  uniqueIndex, index, check, bigserial,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const bookingState = pgEnum('booking_state', [
  'QUOTED', 'PAYMENT_FAILED', 'AUTHORIZED', 'TICKETING',
  'TICKETED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED',
]);

export const paymentKind = pgEnum('payment_kind', ['flight', 'protection', 'ancillary']);
export const idempotencyStatus = pgEnum('idempotency_status', ['in_flight', 'complete']);

export const bookings = pgTable('bookings', {
  id: text('id').primaryKey(),
  pnr: text('pnr').notNull().unique(),
  itineraryId: text('itinerary_id').notNull(),
  passengers: jsonb('passengers').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  state: bookingState('state').notNull().default('QUOTED'),
  customerId: text('customer_id'),
  paymentMethodId: text('payment_method_id'),
  ticketNumber: text('ticket_number'),
  voidDeadlineAt: timestamp('void_deadline_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  stateIdx: index('bookings_state_idx').on(t.state),
  createdIdx: index('bookings_created_at_idx').on(t.createdAt),
  amountPositive: check('bookings_amount_positive', sql`${t.amountMinor} > 0`),
}));

export const payments = pgTable('payments', {
  id: text('id').primaryKey(),
  bookingId: text('booking_id').notNull().references(() => bookings.id),
  kind: paymentKind('kind').notNull(),
  hsPaymentId: text('hs_payment_id').notNull().unique(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  captureMethod: text('capture_method').notNull(),
  connector: text('connector'),
  state: text('state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // The double-charge guard. Partial: several ancillary charges are legitimate,
  // but exactly one flight and one protection payment per booking.
  onePerKind: uniqueIndex('payments_one_per_kind_idx')
    .on(t.bookingId, t.kind)
    .where(sql`kind IN ('flight', 'protection')`),
  bookingIdx: index('payments_booking_id_idx').on(t.bookingId),
  amountPositive: check('payments_amount_positive', sql`${t.amountMinor} > 0`),
  idLength: check('hs_payment_id_is_30_chars', sql`length(${t.hsPaymentId}) = 30`),
}));

export const refunds = pgTable('refunds', {
  id: text('id').primaryKey(),
  paymentId: text('payment_id').notNull().references(() => payments.id),
  hsRefundId: text('hs_refund_id').unique(),
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  reason: text('reason').notNull(),
  state: text('state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  onePerReason: uniqueIndex('refunds_one_per_reason_idx').on(t.paymentId, t.reason),
  paymentIdx: index('refunds_payment_id_idx').on(t.paymentId),
  amountPositive: check('refunds_amount_positive', sql`${t.amountMinor} > 0`),
}));

export const bookingEvents = pgTable('booking_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  bookingId: text('booking_id').notNull().references(() => bookings.id),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  bookingIdx: index('booking_events_booking_id_idx').on(t.bookingId, t.createdAt),
}));

export const idempotencyRecords = pgTable('idempotency_records', {
  key: text('key').primaryKey(),
  endpoint: text('endpoint').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  response: jsonb('response'),
  status: idempotencyStatus('status').notNull().default('in_flight'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Write `db/index.ts`**

```typescript
import 'server-only';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool } from '@neondatabase/serverless';
import { env } from '../lib/env';
import * as schema from './schema';

const pool = new Pool({ connectionString: env.DATABASE_URL });
export const db = drizzle(pool, { schema });
export * from './schema';
```

Uses the pooled driver rather than the HTTP driver because transactions with `SELECT ... FOR UPDATE` are required, and the HTTP driver does not support them.

- [ ] **Step 3: Generate and apply the migration**

```bash
npx drizzle-kit generate
npx drizzle-kit migrate
```

- [ ] **Step 4: Write the constraint test**

```typescript
// tests/integration/schema.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, bookings, payments } from '../../db';
import { newId, toHsPaymentId } from '../../lib/ids';

describe('schema constraints', () => {
  let bookingId: string;

  beforeAll(async () => {
    bookingId = newId();
    await db.insert(bookings).values({
      id: bookingId, pnr: `T${Date.now()}`, itineraryId: 'itin_1',
      passengers: [], amountMinor: 65400,
    });
  });

  it('rejects a second flight payment for the same booking', async () => {
    const insert = () => {
      const id = newId();
      return db.insert(payments).values({
        id, bookingId, kind: 'flight', hsPaymentId: toHsPaymentId(id),
        amountMinor: 65400, captureMethod: 'manual', state: 'requires_capture',
      });
    };
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it('rejects an hs_payment_id that is not exactly 30 characters', async () => {
    const id = newId();
    await expect(
      db.insert(payments).values({
        id, bookingId, kind: 'ancillary', hsPaymentId: 'too_short',
        amountMinor: 3500, captureMethod: 'automatic', state: 'succeeded',
      }),
    ).rejects.toThrow();
  });

  it('allows several ancillary payments for one booking', async () => {
    for (let i = 0; i < 2; i++) {
      const id = newId();
      await db.insert(payments).values({
        id, bookingId, kind: 'ancillary', hsPaymentId: toHsPaymentId(id),
        amountMinor: 3500, captureMethod: 'automatic', state: 'succeeded',
      });
    }
    const ancillaries = await db.select().from(payments)
      .where(and(eq(payments.bookingId, bookingId), eq(payments.kind, 'ancillary')));
    expect(ancillaries).toHaveLength(2);
  });
});
```

- [ ] **Step 5: Run and confirm pass**

Run: `npx vitest run tests/integration/schema.test.ts`
Expected: PASS. These tests prove the double-charge guard is enforced by Postgres, not by application code — which is the point of decision D-010.

- [ ] **Step 6: Commit**

```bash
git add db/ drizzle.config.ts tests/integration/schema.test.ts
git commit -m "feat: database schema with idempotency guards as constraints"
```

---

### Task 6: Hyperswitch client

**Files:**
- Create: `lib/hyperswitch.types.ts`, `lib/hyperswitch.ts`
- Test: `tests/unit/hyperswitch.test.ts`

**Interfaces:**
- Consumes: `env` from Task 1
- Produces:
  - `createIntent(input: CreateIntentInput): Promise<HsPayment>`
  - `getPayment(hsPaymentId: string): Promise<HsPayment>`
  - `capture(hsPaymentId: string, amountMinor: number): Promise<HsPayment>`
  - `voidPayment(hsPaymentId: string, reason: string): Promise<HsPayment>`
  - `refund(input: RefundInput): Promise<HsRefund>`
  - `chargeOffSession(input: OffSessionInput): Promise<HsPayment>`
  - `type HsPayment = { payment_id: string; status: string; connector: string | null; client_secret: string | null; amount: number; amount_capturable: number; amount_received: number | null; payment_method_id: string | null; error_message: string | null; error_code: string | null }`

- [ ] **Step 1: Write the types**

```typescript
// lib/hyperswitch.types.ts
export type HsPayment = {
  payment_id: string;
  status: string;
  connector: string | null;
  client_secret: string | null;
  amount: number;
  amount_capturable: number;
  amount_received: number | null;
  payment_method_id: string | null;
  error_message: string | null;
  error_code: string | null;
};

export type HsRefund = {
  refund_id: string;
  payment_id: string;
  amount: number;
  status: string;
};

export type OrderDetail = {
  product_name: string;
  quantity: number;
  amount: number;
};

export type CreateIntentInput = {
  hsPaymentId: string;
  amountMinor: number;
  captureMethod: 'manual' | 'automatic';
  customerId: string;
  description: string;
  orderDetails: OrderDetail[];
  setupFutureUsage?: 'off_session';
  returnUrl: string;
};

export type OffSessionInput = {
  hsPaymentId: string;
  amountMinor: number;
  customerId: string;
  paymentMethodId: string;
  description: string;
};

export type RefundInput = {
  hsPaymentId: string;
  amountMinor: number;
  reason: string;
};

export class HyperswitchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'HyperswitchError';
  }
}
```

- [ ] **Step 2: Implement `lib/hyperswitch.ts`**

```typescript
import 'server-only';
import { env } from './env';
import {
  type HsPayment, type HsRefund, type CreateIntentInput,
  type OffSessionInput, type RefundInput, HyperswitchError,
} from './hyperswitch.types';

const BASE = 'https://sandbox.hyperswitch.io';

async function call<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'api-key': env.HYPERSWITCH_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new HyperswitchError(
      `Hyperswitch ${method} ${path} failed with ${res.status}`,
      res.status,
      json,
    );
  }
  return json as T;
}

export function createIntent(input: CreateIntentInput): Promise<HsPayment> {
  const sum = input.orderDetails.reduce((acc, d) => acc + d.amount * d.quantity, 0);
  if (sum !== input.amountMinor) {
    throw new Error(
      `order_details sum ${sum} does not equal amount ${input.amountMinor}; Hyperswitch will reject this`,
    );
  }
  return call<HsPayment>('/payments', {
    payment_id: input.hsPaymentId,
    amount: input.amountMinor,
    currency: 'USD',
    confirm: false,
    capture_method: input.captureMethod,
    authentication_type: 'no_three_ds',
    profile_id: env.HYPERSWITCH_PROFILE_ID,
    customer_id: input.customerId,
    description: input.description,
    order_details: input.orderDetails,
    return_url: input.returnUrl,
    ...(input.setupFutureUsage ? { setup_future_usage: input.setupFutureUsage } : {}),
  });
}

export function getPayment(hsPaymentId: string): Promise<HsPayment> {
  return call<HsPayment>(`/payments/${hsPaymentId}`, undefined, 'GET');
}

export function capture(hsPaymentId: string, amountMinor: number): Promise<HsPayment> {
  return call<HsPayment>(`/payments/${hsPaymentId}/capture`, {
    amount_to_capture: amountMinor,
  });
}

export function voidPayment(hsPaymentId: string, reason: string): Promise<HsPayment> {
  return call<HsPayment>(`/payments/${hsPaymentId}/cancel`, {
    cancellation_reason: reason,
  });
}

export function refund(input: RefundInput): Promise<HsRefund> {
  return call<HsRefund>('/refunds', {
    payment_id: input.hsPaymentId,
    amount: input.amountMinor,
    reason: input.reason,
  });
}

export function chargeOffSession(input: OffSessionInput): Promise<HsPayment> {
  return call<HsPayment>('/payments', {
    payment_id: input.hsPaymentId,
    amount: input.amountMinor,
    currency: 'USD',
    confirm: true,
    off_session: true,
    capture_method: 'automatic',
    profile_id: env.HYPERSWITCH_PROFILE_ID,
    customer_id: input.customerId,
    description: input.description,
    recurring_details: {
      type: 'payment_method_id',
      data: input.paymentMethodId,
    },
  });
}
```

The `order_details` sum check fires before the network call. Hyperswitch validates this server-side and its error is not obviously traceable back to a fare-breakdown bug.

- [ ] **Step 3: Write the test**

```typescript
// tests/unit/hyperswitch.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('hyperswitch client', () => {
  beforeEach(() => vi.resetModules());

  it('refuses to send order_details that do not sum to amount', async () => {
    const { createIntent } = await import('../../lib/hyperswitch');
    await expect(
      createIntent({
        hsPaymentId: 'pay_' + '0'.repeat(26),
        amountMinor: 65400,
        captureMethod: 'manual',
        customerId: 'cus_1',
        description: 'x',
        orderDetails: [{ product_name: 'Fare', quantity: 1, amount: 50000 }],
        returnUrl: 'https://example.com',
      }),
    ).rejects.toThrow(/does not equal amount/);
  });

  it('always sends no_three_ds and an explicit capture_method', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ payment_id: 'x', status: 'requires_confirmation' }), { status: 200 }),
    );
    const { createIntent } = await import('../../lib/hyperswitch');
    await createIntent({
      hsPaymentId: 'pay_' + '0'.repeat(26),
      amountMinor: 50000,
      captureMethod: 'manual',
      customerId: 'cus_1',
      description: 'x',
      orderDetails: [{ product_name: 'Fare', quantity: 1, amount: 50000 }],
      returnUrl: 'https://example.com',
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.authentication_type).toBe('no_three_ds');
    expect(body.capture_method).toBe('manual');
    expect(body.profile_id).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run and confirm pass**

Run: `npx vitest run tests/unit/hyperswitch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/hyperswitch.ts lib/hyperswitch.types.ts tests/unit/hyperswitch.test.ts
git commit -m "feat: hyperswitch client with explicit auth type and amount reconciliation"
```

---

### Task 7: Connector capability guardrail

**Files:**
- Create: `lib/connector-capabilities.ts`
- Test: `tests/unit/connector-capabilities.test.ts`

**Interfaces:**
- Consumes: `type PaymentKind = 'flight' | 'protection' | 'ancillary'` (from `db/schema`)
- Produces:
  - `capabilitiesFor(connector: string | null): Capability`
  - `assertCapableOrThrow(connector: string | null, kind: PaymentKind): void`
  - `type Capability = { capture: boolean; void: boolean; mit: boolean; webhooks: boolean }`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/connector-capabilities.test.ts
import { describe, it, expect } from 'vitest';
import { assertCapableOrThrow, capabilitiesFor } from '../../lib/connector-capabilities';

describe('connector capabilities', () => {
  it('knows fauxpay cannot capture or void', () => {
    const c = capabilitiesFor('fauxpay');
    expect(c.capture).toBe(false);
    expect(c.void).toBe(false);
    expect(c.mit).toBe(false);
  });

  it('rejects a flight payment on a connector that cannot capture', () => {
    expect(() => assertCapableOrThrow('fauxpay', 'flight')).toThrow(/capture/);
  });

  it('accepts a flight payment on stripe', () => {
    expect(() => assertCapableOrThrow('stripe', 'flight')).not.toThrow();
  });

  it('accepts a protection payment on fauxpay, which needs nothing beyond authorize', () => {
    expect(() => assertCapableOrThrow('fauxpay', 'protection')).not.toThrow();
  });

  it('treats an unknown connector as incapable rather than assuming the best', () => {
    expect(() => assertCapableOrThrow('some_new_psp', 'flight')).toThrow();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/unit/connector-capabilities.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
export type Capability = {
  capture: boolean;
  void: boolean;
  mit: boolean;
  webhooks: boolean;
};

export type PaymentKind = 'flight' | 'protection' | 'ancillary';

const NONE: Capability = { capture: false, void: false, mit: false, webhooks: false };

/**
 * fauxpay's limits are verified from source:
 * crates/hyperswitch_connectors/src/connectors/dummyconnector.rs
 *   - Capture   → get_url() returns NotImplemented
 *   - Void      → empty trait impl
 *   - SetupMandate → explicit NotImplemented (so no MIT)
 *   - Webhooks  → WebhooksNotImplemented
 */
const TABLE: Record<string, Capability> = {
  stripe:     { capture: true,  void: true,  mit: true,  webhooks: true },
  fauxpay:    NONE,
  phonypay:   NONE,
  pretendpay: NONE,
};

const REQUIREMENTS: Record<PaymentKind, (keyof Capability)[]> = {
  flight: ['capture', 'void'],
  protection: [],
  ancillary: ['mit'],
};

export function capabilitiesFor(connector: string | null): Capability {
  if (!connector) return NONE;
  return TABLE[connector] ?? NONE;
}

export function assertCapableOrThrow(connector: string | null, kind: PaymentKind): void {
  const caps = capabilitiesFor(connector);
  const missing = REQUIREMENTS[kind].filter((r) => !caps[r]);
  if (missing.length > 0) {
    throw new Error(
      `Connector "${connector ?? 'unknown'}" cannot support a ${kind} payment: missing ${missing.join(', ')}`,
    );
  }
}
```

Unknown connectors default to `NONE` rather than to a permissive default. A new connector appearing in routing should fail loudly, not silently receive a payment it cannot complete.

- [ ] **Step 4: Run and confirm pass**

Run: `npx vitest run tests/unit/connector-capabilities.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/connector-capabilities.ts tests/unit/connector-capabilities.test.ts
git commit -m "feat: connector capability table with fail-closed default"
```

---

### Task 8: Event log and idempotency store

**Files:**
- Create: `lib/events.ts`, `lib/idempotency.ts`
- Test: `tests/integration/idempotency.test.ts`

**Interfaces:**
- Consumes: `db` from Task 5
- Produces:
  - `recordEvent(bookingId: string, type: string, payload?: unknown, tx?: Transaction): Promise<void>`
  - `withIdempotency<T>(key: string, endpoint: string, body: unknown, fn: () => Promise<T>): Promise<{ result: T; replayed: boolean }>`

- [ ] **Step 1: Implement `lib/events.ts`**

```typescript
import 'server-only';
import { db, bookingEvents } from '../db';

export async function recordEvent(
  bookingId: string,
  type: string,
  payload: unknown = {},
  tx: typeof db = db,
): Promise<void> {
  await tx.insert(bookingEvents).values({
    bookingId,
    type,
    payload: payload as Record<string, unknown>,
  });
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/integration/idempotency.test.ts
import { describe, it, expect, vi } from 'vitest';
import { withIdempotency } from '../../lib/idempotency';

describe('withIdempotency', () => {
  it('runs the function once and replays the stored response', async () => {
    const key = `k_${Date.now()}`;
    const fn = vi.fn().mockResolvedValue({ clientSecret: 'cs_abc' });

    const first = await withIdempotency(key, '/api/bookings', { a: 1 }, fn);
    const second = await withIdempotency(key, '/api/bookings', { a: 1 }, fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual({ clientSecret: 'cs_abc' });
  });

  it('rejects the same key with a different body', async () => {
    const key = `k_${Date.now()}_b`;
    const fn = vi.fn().mockResolvedValue({ ok: true });
    await withIdempotency(key, '/api/bookings', { a: 1 }, fn);
    await expect(
      withIdempotency(key, '/api/bookings', { a: 2 }, fn),
    ).rejects.toThrow(/fingerprint/i);
  });

  it('does not cache a failure, so a retry can succeed', async () => {
    const key = `k_${Date.now()}_c`;
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ ok: true });

    await expect(withIdempotency(key, '/x', {}, fn)).rejects.toThrow('transient');
    const retry = await withIdempotency(key, '/x', {}, fn);
    expect(retry.result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `npx vitest run tests/integration/idempotency.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `lib/idempotency.ts`**

```typescript
import 'server-only';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, idempotencyRecords } from '../db';

function fingerprint(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

export async function withIdempotency<T>(
  key: string,
  endpoint: string,
  body: unknown,
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const fp = fingerprint(body);

  const inserted = await db
    .insert(idempotencyRecords)
    .values({ key, endpoint, requestFingerprint: fp, status: 'in_flight' })
    .onConflictDoNothing()
    .returning();

  if (inserted.length === 0) {
    const [existing] = await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.key, key));

    if (existing.requestFingerprint !== fp) {
      throw new Error(
        `Idempotency key "${key}" was reused with a different request fingerprint`,
      );
    }
    if (existing.status === 'complete') {
      return { result: existing.response as T, replayed: true };
    }
    // in_flight: a concurrent request holds it, or a previous attempt died.
    // Per D-011 the caller resolves ambiguity by reading state back rather
    // than by re-running the mutation.
    throw new Error(`Request for key "${key}" is already in flight`);
  }

  try {
    const result = await fn();
    await db
      .update(idempotencyRecords)
      .set({ response: result as Record<string, unknown>, status: 'complete', updatedAt: new Date() })
      .where(eq(idempotencyRecords.key, key));
    return { result, replayed: false };
  } catch (e) {
    // Never cache a failure — a transient error must not poison the key.
    await db.delete(idempotencyRecords).where(eq(idempotencyRecords.key, key));
    throw e;
  }
}
```

- [ ] **Step 5: Run and confirm pass**

Run: `npx vitest run tests/integration/idempotency.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/events.ts lib/idempotency.ts tests/integration/idempotency.test.ts
git commit -m "feat: append-only event log and idempotency replay store"
```

---

### Task 9: Itinerary fixtures and simulated GDS

**Files:**
- Create: `data/itineraries.ts`, `lib/ticketing.ts`
- Test: `tests/unit/ticketing.test.ts`

**Interfaces:**
- Consumes: `fareBreakdown` from Task 3
- Produces:
  - `ITINERARIES: Itinerary[]` and `findItinerary(id: string): Itinerary | undefined`
  - `type Itinerary = { id: string; origin: string; destination: string; carrier: string; flightNumber: string; departsAt: string; baseFareMinor: number }`
  - `attemptIssuance(itineraryId: string, bookingId: string): Promise<IssuanceResult>`
  - `type IssuanceResult = { ok: true; ticketNumber: string } | { ok: false; kind: 'retryable' | 'terminal'; reason: string }`

  **Post-review revision (2026-08-06):** the signature shown in Step 4 below and
  used by Task 13 is `attemptIssuance(itineraryId, bookingId)`, not the
  single-argument form the Step 1-6 narrative below was originally drafted with.
  Retry state is keyed on the `(itineraryId, bookingId)` pair rather than
  `itineraryId` alone, so the retryable-then-succeeds narrative for `itin_ord_lax`
  replays independently for every booking instead of only working once per process.
  `attemptIssuance` also now validates the itinerary id via `findItinerary` and
  returns `{ ok: false, kind: 'terminal' }` for an unknown id, rather than the
  original Step 4 code, which fabricated a ticket number for any id it didn't
  recognize as one of the two failure fixtures. See
  `.superpowers/sdd/2026-08-05-booking-payments/task-9-report.md` for the full
  review trail; the Step 1-6 blocks below are left as originally drafted, defects
  included, as the historical record of what was proposed.

- [ ] **Step 1: Write `data/itineraries.ts`**

```typescript
import { usd } from '../lib/money';

export type Itinerary = {
  id: string;
  origin: string;
  destination: string;
  carrier: string;
  flightNumber: string;
  departsAt: string;
  baseFareMinor: number;
};

export const ITINERARIES: Itinerary[] = [
  {
    id: 'itin_sfo_jfk',
    origin: 'SFO', destination: 'JFK',
    carrier: 'Meridian Air', flightNumber: 'MR 412',
    departsAt: '2026-09-14T07:20:00-07:00',
    baseFareMinor: usd(318),
  },
  {
    id: 'itin_ord_lax',
    origin: 'ORD', destination: 'LAX',
    carrier: 'Northstar', flightNumber: 'NS 88',
    departsAt: '2026-09-21T16:05:00-05:00',
    baseFareMinor: usd(214),
  },
  {
    // Designated always-fails-issuance itinerary. Drives flow D on demand.
    id: 'itin_bos_sea',
    origin: 'BOS', destination: 'SEA',
    carrier: 'Cascade Airways', flightNumber: 'CW 1190',
    departsAt: '2026-10-02T09:45:00-04:00',
    baseFareMinor: usd(487),
  },
];

export function findItinerary(id: string): Itinerary | undefined {
  return ITINERARIES.find((i) => i.id === id);
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/unit/ticketing.test.ts
import { describe, it, expect } from 'vitest';
import { attemptIssuance } from '../../lib/ticketing';

describe('simulated GDS', () => {
  it('issues a ticket for a normal itinerary', async () => {
    const r = await attemptIssuance('itin_sfo_jfk');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ticketNumber).toMatch(/^\d{3}-\d{10}$/);
  });

  it('always fails terminally for the designated failure itinerary', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await attemptIssuance('itin_bos_sea');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe('terminal');
    }
  });

  it('is deterministic, so the demo is reproducible', async () => {
    const a = await attemptIssuance('itin_ord_lax');
    const b = await attemptIssuance('itin_ord_lax');
    expect(a.ok).toBe(b.ok);
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `npx vitest run tests/unit/ticketing.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement `lib/ticketing.ts`**

```typescript
export type IssuanceResult =
  | { ok: true; ticketNumber: string }
  | { ok: false; kind: 'retryable' | 'terminal'; reason: string };

/** Itineraries that never issue. Drives flow D reproducibly. */
const ALWAYS_FAILS_TERMINAL = new Set(['itin_bos_sea']);

/** Itineraries that fail once with a transient error before succeeding. */
const FAILS_ONCE_RETRYABLE = new Set(['itin_ord_lax']);

const attemptCounts = new Map<string, number>();

function ticketNumber(): string {
  const airline = '016';
  const serial = String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
  return `${airline}-${serial}`;
}

export async function attemptIssuance(itineraryId: string): Promise<IssuanceResult> {
  if (ALWAYS_FAILS_TERMINAL.has(itineraryId)) {
    return { ok: false, kind: 'terminal', reason: 'Fare no longer available at the carrier' };
  }

  if (FAILS_ONCE_RETRYABLE.has(itineraryId)) {
    const n = (attemptCounts.get(itineraryId) ?? 0) + 1;
    attemptCounts.set(itineraryId, n);
    if (n === 1) {
      return { ok: false, kind: 'retryable', reason: 'GDS timeout' };
    }
  }

  return { ok: true, ticketNumber: ticketNumber() };
}

/** Test and demo helper — resets the retryable counter. */
export function resetIssuanceCounters(): void {
  attemptCounts.clear();
}
```

The retryable case is stateful in memory, which is acceptable for a prototype but would not survive a serverless cold start. Note this in the README as a known simplification rather than pretending otherwise.

- [ ] **Step 5: Run and confirm pass**

Run: `npx vitest run tests/unit/ticketing.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add data/itineraries.ts lib/ticketing.ts tests/unit/ticketing.test.ts
git commit -m "feat: itinerary fixtures and deterministic simulated GDS"
```

---

### Task 10: Booking creation — flow A, with the double-submit guard

**Files:**
- Create: `lib/bookings/shared.ts`, `lib/bookings/create.ts`, `lib/bookings/index.ts`, `app/api/bookings/route.ts`
- Test: `tests/integration/create-booking.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–9
- Produces:
  - `createBooking(input: { itineraryId: string; passengers: Passenger[]; idempotencyKey: string }): Promise<{ bookingId: string; clientSecret: string; publishableKey: string }>`
  - `type Passenger = { firstName: string; lastName: string }`

This is the headline test of the whole plan. Two concurrent requests must produce exactly one payment row and exactly one Hyperswitch call.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/create-booking.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, payments } from '../../db';

vi.mock('../../lib/hyperswitch', () => ({
  createIntent: vi.fn().mockImplementation(async (i) => ({
    payment_id: i.hsPaymentId,
    status: 'requires_confirmation',
    connector: 'stripe',
    client_secret: `${i.hsPaymentId}_secret_test`,
    amount: i.amountMinor,
    amount_capturable: 0,
    amount_received: null,
    payment_method_id: null,
    error_message: null,
    error_code: null,
  })),
}));

describe('createBooking', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates one booking and one payment', async () => {
    const { createBooking } = await import('../../lib/bookings');
    const r = await createBooking({
      itineraryId: 'itin_sfo_jfk',
      passengers: [{ firstName: 'Ada', lastName: 'Lovelace' }],
      idempotencyKey: `idem_${Date.now()}`,
    });
    expect(r.clientSecret).toContain('_secret_');

    const rows = await db.select().from(payments).where(eq(payments.bookingId, r.bookingId));
    expect(rows).toHaveLength(1);
    expect(rows[0].hsPaymentId).toHaveLength(30);
  });

  it('a double submit produces one payment and one outbound call', async () => {
    const { createBooking } = await import('../../lib/bookings');
    const { createIntent } = await import('../../lib/hyperswitch');
    const key = `idem_${Date.now()}_dbl`;

    const payload = {
      itineraryId: 'itin_sfo_jfk',
      passengers: [{ firstName: 'Ada', lastName: 'Lovelace' }],
      idempotencyKey: key,
    };

    const [a, b] = await Promise.allSettled([
      createBooking(payload),
      createBooking(payload),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(vi.mocked(createIntent)).toHaveBeenCalledTimes(1);
  });

  it('a sequential resubmit returns the same client secret', async () => {
    const { createBooking } = await import('../../lib/bookings');
    const key = `idem_${Date.now()}_seq`;
    const payload = {
      itineraryId: 'itin_sfo_jfk',
      passengers: [{ firstName: 'Ada', lastName: 'Lovelace' }],
      idempotencyKey: key,
    };
    const first = await createBooking(payload);
    const second = await createBooking(payload);
    expect(second.clientSecret).toBe(first.clientSecret);
    expect(second.bookingId).toBe(first.bookingId);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/integration/create-booking.test.ts`
Expected: FAIL — `lib/bookings` does not exist.

- [ ] **Step 3: Implement `lib/bookings/shared.ts`, `lib/bookings/create.ts` and `lib/bookings/index.ts`**

First `lib/bookings/shared.ts` — everything more than one operation needs:

```typescript
import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db, payments } from '../../db';

export type Passenger = { firstName: string; lastName: string };

export const DOT_VOID_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Ambiguous characters (I, O) omitted — PNRs get read aloud over the phone. */
export function pnr(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  return Array.from({ length: 6 }, () =>
    alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

/** Every operation that touches money needs the booking's flight payment. */
export async function flightPaymentFor(bookingId: string, tx: typeof db = db) {
  const [row] = await tx.select().from(payments)
    .where(and(eq(payments.bookingId, bookingId), eq(payments.kind, 'flight')));
  if (!row) throw new Error(`No flight payment for booking ${bookingId}`);
  return row;
}
```

Then `lib/bookings/index.ts`, which is the only import site consumers use:

```typescript
export * from './shared';
export * from './create';
// Later tasks append one export line each: issue, cancel, refund,
// protection, ancillary. Tests and routes import from '../../lib/bookings'
// and never from an operation file directly.
```

Then `lib/bookings/create.ts`:

```typescript
import 'server-only';
import { db, bookings, payments } from '../../db';
import { newId, toHsPaymentId } from '../ids';
import { fareBreakdown } from '../money';
import { findItinerary } from '../../data/itineraries';
import { createIntent } from '../hyperswitch';
import { withIdempotency } from '../idempotency';
import { recordEvent } from '../events';
import { env } from '../env';
import { type Passenger, DOT_VOID_WINDOW_MS, pnr } from './shared';

export async function createBooking(input: {
  itineraryId: string;
  passengers: Passenger[];
  idempotencyKey: string;
}): Promise<{ bookingId: string; clientSecret: string; publishableKey: string }> {
  const itinerary = findItinerary(input.itineraryId);
  if (!itinerary) throw new Error(`Unknown itinerary: ${input.itineraryId}`);

  const { result } = await withIdempotency(
    input.idempotencyKey,
    '/api/bookings',
    { itineraryId: input.itineraryId, passengers: input.passengers },
    async () => {
      const fare = fareBreakdown(itinerary.baseFareMinor);
      const perPassenger = fare.total;
      const total = perPassenger * input.passengers.length;

      const bookingId = newId();
      const paymentId = newId();
      const hsPaymentId = toHsPaymentId(paymentId);

      await db.insert(bookings).values({
        id: bookingId,
        pnr: pnr(),
        itineraryId: itinerary.id,
        passengers: input.passengers,
        amountMinor: total,
        state: 'QUOTED',
        customerId: `cus_${bookingId}`,
        voidDeadlineAt: new Date(Date.now() + DOT_VOID_WINDOW_MS),
      });

      await recordEvent(bookingId, 'booking.created', {
        itineraryId: itinerary.id,
        total,
      });

      const intent = await createIntent({
        hsPaymentId,
        amountMinor: total,
        captureMethod: 'manual',
        customerId: `cus_${bookingId}`,
        description: `${itinerary.carrier} ${itinerary.flightNumber} ${itinerary.origin}-${itinerary.destination}`,
        setupFutureUsage: 'off_session',
        returnUrl: `${env.APP_BASE_URL}/confirmation/${bookingId}`,
        orderDetails: [
          { product_name: 'Air fare', quantity: input.passengers.length, amount: fare.base },
          { product_name: 'US excise tax', quantity: input.passengers.length, amount: fare.excise },
          { product_name: 'Segment fee', quantity: input.passengers.length, amount: fare.segment },
          { product_name: 'September 11 security fee', quantity: input.passengers.length, amount: fare.september11 },
        ],
      });

      await db.insert(payments).values({
        id: paymentId,
        bookingId,
        kind: 'flight',
        hsPaymentId,
        amountMinor: total,
        captureMethod: 'manual',
        connector: intent.connector,
        state: intent.status,
      });

      return {
        bookingId,
        clientSecret: intent.client_secret!,
        publishableKey: env.HYPERSWITCH_PUBLISHABLE_KEY,
      };
    },
  );

  return result;
}
```

- [ ] **Step 4: Implement `app/api/bookings/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createBooking } from '../../../lib/bookings';

const schema = z.object({
  itineraryId: z.string().min(1),
  passengers: z.array(z.object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
  })).min(1),
  idempotencyKey: z.string().min(8),
});

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    return NextResponse.json(await createBooking(parsed.data));
  } catch (e) {
    const message = (e as Error).message;
    if (message.includes('already in flight')) {
      return NextResponse.json({ error: 'Request already in progress' }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 5: Run and confirm pass**

Run: `npx vitest run tests/integration/create-booking.test.ts`
Expected: PASS — in particular `createIntent` called exactly once across a concurrent double submit.

- [ ] **Step 6: Commit**

```bash
git add lib/bookings/ app/api/bookings/route.ts tests/integration/create-booking.test.ts
git commit -m "feat: booking creation with concurrent double-submit protection"
```

---

### Task 11: Checkout page — flows A and B

**Files:**
- Create: `app/page.tsx`, `app/checkout/[bookingId]/page.tsx`, `app/checkout/[bookingId]/CheckoutForm.tsx`, `app/confirmation/[bookingId]/page.tsx`
- Modify: `package.json` (add SDK packages)

**Interfaces:**
- Consumes: `POST /api/bookings` from Task 10
- Produces: nothing consumed by later tasks

**Known documentation inconsistency — resolve empirically.** The official React guide initialises `const widgets = useWidgets()` but then calls `hyper.confirmPayment({ elements, ... })`. Those cannot both be right. Try `widgets` first, since that is what the hook returns; if the SDK rejects it, pass `elements`. Record whichever works in a comment so the next reader does not repeat the investigation.

- [ ] **Step 1: Install the SDK**

```bash
npm install @juspay-tech/hyper-js @juspay-tech/react-hyper-js
```

- [ ] **Step 2: Write the checkout form**

```tsx
'use client';
import { useState } from 'react';
import { useHyper, useWidgets, UnifiedCheckout } from '@juspay-tech/react-hyper-js';

export function CheckoutForm({ bookingId }: { bookingId: string }) {
  const hyper = useHyper();
  const widgets = useWidgets();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Double-click guard, layer one. The server guard in Task 10 is the one
    // that actually protects us; this exists so the traveller never sees a
    // second request fired at all.
    if (submitting || !hyper || !widgets) return;
    setSubmitting(true);
    setMessage(null);

    const { error } = await hyper.confirmPayment({
      widgets,
      confirmParams: {
        return_url: `${window.location.origin}/confirmation/${bookingId}`,
      },
      redirect: 'if_required',
    });

    if (error) {
      // A decline lands here. The PaymentIntent stays reusable, so the
      // traveller can enter another card against the same intent and
      // Hyperswitch records it as attempt #2.
      setMessage(error.message ?? 'That card was declined. Please try another card.');
      setSubmitting(false);
      return;
    }

    window.location.href = `/confirmation/${bookingId}`;
  }

  return (
    <form onSubmit={handleSubmit}>
      <UnifiedCheckout id="unified-checkout" options={{}} />
      <button type="submit" disabled={submitting} aria-busy={submitting}>
        {submitting ? 'Processing…' : 'Pay and hold my seat'}
      </button>
      {message && <p role="alert">{message}</p>}
      <p>
        Your card is authorized now and charged only once your ticket is issued.
        Free cancellation within 24 hours.
      </p>
    </form>
  );
}
```

The decline path deliberately does not create a new booking or a new intent. `setSubmitting(false)` returns the traveller to the same form against the same `client_secret`, which is what produces the multi-attempt timeline in the Control Center.

- [ ] **Step 3: Write the checkout page wrapper**

```tsx
'use client';
import { useEffect, useState } from 'react';
import { loadHyper } from '@juspay-tech/hyper-js';
import { HyperElements } from '@juspay-tech/react-hyper-js';
import { CheckoutForm } from './CheckoutForm';

export default function CheckoutPage({ params }: { params: { bookingId: string } }) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [hyperPromise, setHyperPromise] = useState<ReturnType<typeof loadHyper> | null>(null);

  useEffect(() => {
    fetch(`/api/bookings/${params.bookingId}/session`)
      .then((r) => r.json())
      .then((d) => {
        setClientSecret(d.clientSecret);
        setHyperPromise(
          loadHyper(d.publishableKey, { customBackendUrl: 'https://sandbox.hyperswitch.io' }),
        );
      });
  }, [params.bookingId]);

  if (!clientSecret || !hyperPromise) return <p>Loading checkout…</p>;

  return (
    <HyperElements options={{ clientSecret }} hyper={hyperPromise}>
      <CheckoutForm bookingId={params.bookingId} />
    </HyperElements>
  );
}
```

- [ ] **Step 4: Add the session route**

Create `app/api/bookings/[id]/session/route.ts` returning `{ clientSecret, publishableKey }` for an existing booking by reading `payments.hsPaymentId` and calling `getPayment`. This exists so a page refresh mid-checkout resumes the same intent rather than creating a second one.

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, payments } from '../../../../../db';
import { getPayment } from '../../../../../lib/hyperswitch';
import { env } from '../../../../../lib/env';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const [row] = await db.select().from(payments)
    .where(and(eq(payments.bookingId, params.id), eq(payments.kind, 'flight')));
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const intent = await getPayment(row.hsPaymentId);
  return NextResponse.json({
    clientSecret: intent.client_secret,
    publishableKey: env.HYPERSWITCH_PUBLISHABLE_KEY,
  });
}
```

- [ ] **Step 5: Verify by hand**

Run `npm run dev`. Book `itin_sfo_jfk`, pay with `4242424242424242`, exp `12/30`, CVC `123`. Expect a redirect to confirmation and a payment in `requires_capture` in the Control Center.

Then repeat with `4000000000000002`. Expect an inline decline, the form still usable, and a second attempt with the good card succeeding — with **one** `payment_id` and two attempts visible in the Control Center.

Then double-click Pay rapidly. Expect exactly one payment.

- [ ] **Step 6: Commit**

```bash
git add app/ package.json package-lock.json
git commit -m "feat: checkout with unified checkout, decline retry on the same intent"
```

---

### Task 12: Webhook handler

**Files:**
- Create: `lib/webhooks.ts`, `app/api/webhooks/hyperswitch/route.ts`
- Test: `tests/unit/webhooks.test.ts`

**Interfaces:**
- Consumes: `db` from Task 5
- Produces: `verifySignature(rawBody: string, signature: string): boolean`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/webhooks.test.ts
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySignature } from '../../lib/webhooks';

describe('webhook signature', () => {
  const secret = process.env.HYPERSWITCH_WEBHOOK_SECRET!;

  it('accepts a correctly signed payload', () => {
    const body = JSON.stringify({ event_type: 'payment_succeeded' });
    const sig = createHmac('sha512', secret).update(body).digest('hex');
    expect(verifySignature(body, sig)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const body = JSON.stringify({ event_type: 'payment_succeeded' });
    const sig = createHmac('sha512', secret).update(body).digest('hex');
    expect(verifySignature(JSON.stringify({ event_type: 'evil' }), sig)).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    expect(verifySignature('{}', 'abc')).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/unit/webhooks.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `lib/webhooks.ts`**

```typescript
import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env';

export function verifySignature(rawBody: string, signature: string): boolean {
  const expected = createHmac('sha512', env.HYPERSWITCH_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;   // timingSafeEqual throws on length mismatch
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Implement the route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, payments } from '../../../../db';
import { verifySignature } from '../../../../lib/webhooks';
import { recordEvent } from '../../../../lib/events';

/** Statuses ordered by progress. A webhook never moves a payment backwards. */
const RANK: Record<string, number> = {
  requires_payment_method: 0, requires_confirmation: 1, requires_customer_action: 2,
  processing: 3, requires_capture: 4, partially_captured: 5,
  succeeded: 6, cancelled: 7, failed: 7,
};

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const signature = req.headers.get('x-webhook-signature-512') ?? '';

  if (!verifySignature(raw, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const event = JSON.parse(raw);
  const hsPaymentId: string | undefined = event?.content?.object?.payment_id;
  const status: string | undefined = event?.content?.object?.status;
  if (!hsPaymentId || !status) return NextResponse.json({ ok: true });

  const [row] = await db.select().from(payments).where(eq(payments.hsPaymentId, hsPaymentId));
  if (!row) return NextResponse.json({ ok: true });   // not ours; acknowledge anyway

  // Monotonic only. Webhooks are unordered and may duplicate, so a late
  // 'succeeded' must not overwrite a later 'cancelled'.
  if ((RANK[status] ?? -1) > (RANK[row.state] ?? -1)) {
    await db.update(payments)
      .set({ state: status, updatedAt: new Date() })
      .where(eq(payments.id, row.id));
  }

  await recordEvent(row.bookingId, 'webhook.received', {
    hsPaymentId, status, eventId: event?.event_id ?? null,
  });
  return NextResponse.json({ ok: true });
}
```

Always returns 200 for unknown payments. Hyperswitch retries delivery for up to **24 hours** when it does not receive a 2XX, so a non-200 buys a day of pointless retries for a webhook we will never care about.

The header name and algorithm are verified against the docs: HMAC-SHA512 over the raw JSON body, keyed with the business profile's `payments_response_hash_key`, delivered as `x-webhook-signature-512`. An `x-webhook-signature-256` variant exists for systems without SHA512; we do not use it.

The payload also carries an `event_id`, which Hyperswitch's own guidance names as the duplicate-detection key. The monotonic rank check below already makes replays harmless, so `event_id` is not required for correctness here — but log it in the `webhook.received` event so duplicate deliveries are visible in the ops timeline rather than invisible.

- [ ] **Step 5: Run and confirm pass**

Run: `npx vitest run tests/unit/webhooks.test.ts`
Expected: PASS

- [ ] **Step 6: Register the webhook**

In the dashboard, set the profile's outgoing webhook URL to `${APP_BASE_URL}/api/webhooks/hyperswitch` — the **stable production alias**, never a preview URL. Copy the payment response hash key into `HYPERSWITCH_WEBHOOK_SECRET`.

- [ ] **Step 7: Commit**

```bash
git add lib/webhooks.ts app/api/webhooks/ tests/unit/webhooks.test.ts
git commit -m "feat: HMAC-verified webhook handler with monotonic state advance"
```

---

### Task 13: Issuance — flows C and D

**Files:**
- Create: `app/api/bookings/[id]/issue/route.ts`
- Create: `lib/bookings/issue.ts`; Modify: `lib/bookings/index.ts` (re-export `issueTicket`)
- Test: `tests/integration/issue.test.ts`

**Interfaces:**
- Consumes: `attemptIssuance` (Task 9), `capture` / `voidPayment` (Task 6), `assertCapableOrThrow` (Task 7), `nextState` (Task 4)
- Produces: `issueTicket(bookingId: string): Promise<{ state: BookingState; ticketNumber?: string }>`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/issue.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/hyperswitch', () => ({
  createIntent: vi.fn(async (i) => ({
    payment_id: i.hsPaymentId, status: 'requires_capture', connector: 'stripe',
    client_secret: `${i.hsPaymentId}_secret_t`, amount: i.amountMinor,
    amount_capturable: i.amountMinor, amount_received: null,
    payment_method_id: null, error_message: null, error_code: null,
  })),
  capture: vi.fn(async () => ({ status: 'succeeded' })),
  voidPayment: vi.fn(async () => ({ status: 'cancelled' })),
  getPayment: vi.fn(async () => ({ status: 'requires_capture' })),
}));

describe('issueTicket', () => {
  it('captures only after a ticket number exists', async () => {
    const { createBooking, issueTicket } = await import('../../lib/bookings');
    const { capture } = await import('../../lib/hyperswitch');

    const b = await createBooking({
      itineraryId: 'itin_sfo_jfk',
      passengers: [{ firstName: 'A', lastName: 'B' }],
      idempotencyKey: `k_${Date.now()}_ok`,
    });
    const r = await issueTicket(b.bookingId);

    expect(r.state).toBe('TICKETED');
    expect(r.ticketNumber).toBeTruthy();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('voids and never captures when issuance fails terminally', async () => {
    const { createBooking, issueTicket } = await import('../../lib/bookings');
    const { capture, voidPayment } = await import('../../lib/hyperswitch');
    vi.mocked(capture).mockClear();

    const b = await createBooking({
      itineraryId: 'itin_bos_sea',
      passengers: [{ firstName: 'A', lastName: 'B' }],
      idempotencyKey: `k_${Date.now()}_fail`,
    });
    const r = await issueTicket(b.bookingId);

    expect(r.state).toBe('VOIDED');
    expect(voidPayment).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
  });

  it('is idempotent — a second call does not capture twice', async () => {
    const { createBooking, issueTicket } = await import('../../lib/bookings');
    const { capture } = await import('../../lib/hyperswitch');
    vi.mocked(capture).mockClear();

    const b = await createBooking({
      itineraryId: 'itin_sfo_jfk',
      passengers: [{ firstName: 'A', lastName: 'B' }],
      idempotencyKey: `k_${Date.now()}_idem`,
    });
    await issueTicket(b.bookingId);
    await issueTicket(b.bookingId);

    expect(capture).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/integration/issue.test.ts`
Expected: FAIL — `issueTicket` is not exported.

- [ ] **Step 3: Create `lib/bookings/issue.ts` and re-export it from `index.ts`**

```typescript
import { eq, and } from 'drizzle-orm';
import { attemptIssuance } from './ticketing';
import { capture, voidPayment } from './hyperswitch';
import { assertCapableOrThrow } from './connector-capabilities';
import { nextState, type BookingState } from './state-machine';

export async function issueTicket(
  bookingId: string,
): Promise<{ state: BookingState; ticketNumber?: string }> {
  return db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings)
      .where(eq(bookings.id, bookingId)).for('update');
    if (!booking) throw new Error(`Unknown booking ${bookingId}`);

    // Idempotency guard: only an AUTHORIZED or TICKETING booking may proceed.
    if (booking.state === 'TICKETED') {
      return { state: booking.state, ticketNumber: booking.ticketNumber ?? undefined };
    }
    if (booking.state !== 'AUTHORIZED' && booking.state !== 'TICKETING') {
      throw new Error(`Cannot issue a ticket for a booking in state ${booking.state}`);
    }

    const [payment] = await tx.select().from(payments)
      .where(and(eq(payments.bookingId, bookingId), eq(payments.kind, 'flight')));

    // D-007: refuse to proceed on a connector that cannot complete this payment.
    assertCapableOrThrow(payment.connector, 'flight');

    if (booking.state === 'AUTHORIZED') {
      await tx.update(bookings)
        .set({ state: nextState('AUTHORIZED', 'ISSUANCE_STARTED'), updatedAt: new Date() })
        .where(eq(bookings.id, bookingId));
      await recordEvent(bookingId, 'ticketing.attempted', {}, tx);
    }

    const issuance = await attemptIssuance(booking.itineraryId, bookingId);

    if (!issuance.ok && issuance.kind === 'retryable') {
      await recordEvent(bookingId, 'ticketing.failed', { kind: 'retryable', reason: issuance.reason }, tx);
      return { state: 'TICKETING' };
    }

    if (!issuance.ok) {
      await voidPayment(payment.hsPaymentId, issuance.reason);
      const state = nextState('TICKETING', 'ISSUANCE_FAILED_TERMINAL');
      await tx.update(bookings).set({ state, updatedAt: new Date() }).where(eq(bookings.id, bookingId));
      await tx.update(payments).set({ state: 'cancelled' }).where(eq(payments.id, payment.id));
      await recordEvent(bookingId, 'payment.voided', { reason: issuance.reason }, tx);
      return { state };
    }

    // Ticket exists. Only now do we take the money.
    await capture(payment.hsPaymentId, payment.amountMinor);
    const state = nextState('TICKETING', 'ISSUANCE_SUCCEEDED');
    await tx.update(bookings)
      .set({ state, ticketNumber: issuance.ticketNumber, updatedAt: new Date() })
      .where(eq(bookings.id, bookingId));
    await tx.update(payments).set({ state: 'succeeded' }).where(eq(payments.id, payment.id));
    await recordEvent(bookingId, 'payment.captured', { ticketNumber: issuance.ticketNumber }, tx);

    return { state, ticketNumber: issuance.ticketNumber };
  });
}
```

- [ ] **Step 4: Implement the route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { issueTicket } from '../../../../../lib/bookings';

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    return NextResponse.json(await issueTicket(params.id));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
```

- [ ] **Step 5: Run and confirm pass**

Run: `npx vitest run tests/integration/issue.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/bookings/ app/api/bookings/ tests/integration/issue.test.ts
git commit -m "feat: ticket issuance capturing only after a ticket number exists"
```

---

### Task 14: DOT 24-hour cancellation — flow E

**Files:**
- Create: `app/api/bookings/[id]/cancel/route.ts`
- Create: `lib/bookings/cancel.ts`; Modify: `lib/bookings/index.ts` (re-export `cancelWithinWindow`)
- Test: `tests/integration/cancel.test.ts`

**Interfaces:**
- Produces: `cancelWithinWindow(bookingId: string, now?: Date): Promise<{ state: BookingState }>`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/cancel.test.ts
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, bookings } from '../../db';

vi.mock('../../lib/hyperswitch', () => ({
  createIntent: vi.fn(async (i) => ({
    payment_id: i.hsPaymentId, status: 'requires_capture', connector: 'stripe',
    client_secret: 'cs', amount: i.amountMinor, amount_capturable: i.amountMinor,
    amount_received: null, payment_method_id: null, error_message: null, error_code: null,
  })),
  voidPayment: vi.fn(async () => ({ status: 'cancelled' })),
  capture: vi.fn(), getPayment: vi.fn(),
}));

describe('cancelWithinWindow', () => {
  it('voids inside the 24 hour window', async () => {
    const { createBooking, cancelWithinWindow } = await import('../../lib/bookings');
    const { voidPayment } = await import('../../lib/hyperswitch');
    const b = await createBooking({
      itineraryId: 'itin_sfo_jfk', passengers: [{ firstName: 'A', lastName: 'B' }],
      idempotencyKey: `k_${Date.now()}_c1`,
    });
    await db.update(bookings).set({ state: 'AUTHORIZED' }).where(eq(bookings.id, b.bookingId));

    const r = await cancelWithinWindow(b.bookingId);
    expect(r.state).toBe('VOIDED');
    expect(voidPayment).toHaveBeenCalled();
  });

  it('refuses outside the window, using server time not client time', async () => {
    const { createBooking, cancelWithinWindow } = await import('../../lib/bookings');
    const b = await createBooking({
      itineraryId: 'itin_sfo_jfk', passengers: [{ firstName: 'A', lastName: 'B' }],
      idempotencyKey: `k_${Date.now()}_c2`,
    });
    await db.update(bookings).set({ state: 'AUTHORIZED' }).where(eq(bookings.id, b.bookingId));

    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await expect(cancelWithinWindow(b.bookingId, later)).rejects.toThrow(/window/i);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/integration/cancel.test.ts`
Expected: FAIL

- [ ] **Step 3: Create `lib/bookings/cancel.ts` and re-export it from `index.ts`**

```typescript
export async function cancelWithinWindow(
  bookingId: string,
  now: Date = new Date(),
): Promise<{ state: BookingState }> {
  return db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings)
      .where(eq(bookings.id, bookingId)).for('update');
    if (!booking) throw new Error(`Unknown booking ${bookingId}`);

    if (booking.state === 'VOIDED') return { state: booking.state };

    if (booking.state !== 'AUTHORIZED') {
      throw new Error(
        `A booking in state ${booking.state} cannot be cancelled as a void; a captured booking must be refunded`,
      );
    }
    if (!booking.voidDeadlineAt || now > booking.voidDeadlineAt) {
      throw new Error('Outside the 24 hour cancellation window');
    }

    const [payment] = await tx.select().from(payments)
      .where(and(eq(payments.bookingId, bookingId), eq(payments.kind, 'flight')));
    assertCapableOrThrow(payment.connector, 'flight');

    await voidPayment(payment.hsPaymentId, 'dot_24h_cancellation');

    const state = nextState('AUTHORIZED', 'CANCELLED_IN_WINDOW');
    await tx.update(bookings).set({ state, updatedAt: new Date() }).where(eq(bookings.id, bookingId));
    await tx.update(payments).set({ state: 'cancelled' }).where(eq(payments.id, payment.id));
    await recordEvent(bookingId, 'payment.voided', { reason: 'dot_24h_cancellation' }, tx);

    return { state };
  });
}
```

- [ ] **Step 4: Implement `app/api/bookings/[id]/cancel/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { cancelWithinWindow } from '../../../../../lib/bookings';

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    return NextResponse.json(await cancelWithinWindow(params.id));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
```

- [ ] **Step 5: Run and confirm pass**

Run: `npx vitest run tests/integration/cancel.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/bookings/ app/api/bookings/ tests/integration/cancel.test.ts
git commit -m "feat: DOT 24-hour cancellation as a void with server-side deadline"
```

---

### Task 15: Refunds — flow F

**Files:**
- Create: `app/api/bookings/[id]/refund/route.ts`
- Create: `lib/bookings/refund.ts`; Modify: `lib/bookings/index.ts` (re-export `refundBooking`)
- Test: `tests/integration/refund.test.ts`

**Interfaces:**
- Produces: `refundBooking(input: { bookingId: string; amountMinor: number; reason: string }): Promise<{ state: BookingState }>`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/refund.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/hyperswitch', () => ({
  createIntent: vi.fn(async (i) => ({
    payment_id: i.hsPaymentId, status: 'requires_capture', connector: 'stripe',
    client_secret: 'cs', amount: i.amountMinor, amount_capturable: i.amountMinor,
    amount_received: null, payment_method_id: null, error_message: null, error_code: null,
  })),
  capture: vi.fn(async () => ({ status: 'succeeded' })),
  voidPayment: vi.fn(), getPayment: vi.fn(),
  refund: vi.fn(async (i) => ({ refund_id: `ref_${Date.now()}`, payment_id: i.hsPaymentId, amount: i.amountMinor, status: 'succeeded' })),
}));

describe('refundBooking', () => {
  it('partially refunds a ticketed booking', async () => {
    const { createBooking, issueTicket, refundBooking } = await import('../../lib/bookings');
    const b = await createBooking({
      itineraryId: 'itin_sfo_jfk', passengers: [{ firstName: 'A', lastName: 'B' }],
      idempotencyKey: `k_${Date.now()}_r1`,
    });
    await issueTicket(b.bookingId);
    const r = await refundBooking({ bookingId: b.bookingId, amountMinor: 5000, reason: 'schedule_change' });
    expect(r.state).toBe('PARTIALLY_REFUNDED');
  });

  it('does not refund twice for the same reason', async () => {
    const { createBooking, issueTicket, refundBooking } = await import('../../lib/bookings');
    const { refund } = await import('../../lib/hyperswitch');
    vi.mocked(refund).mockClear();

    const b = await createBooking({
      itineraryId: 'itin_sfo_jfk', passengers: [{ firstName: 'A', lastName: 'B' }],
      idempotencyKey: `k_${Date.now()}_r2`,
    });
    await issueTicket(b.bookingId);
    await refundBooking({ bookingId: b.bookingId, amountMinor: 5000, reason: 'schedule_change' });
    await refundBooking({ bookingId: b.bookingId, amountMinor: 5000, reason: 'schedule_change' });

    expect(refund).toHaveBeenCalledTimes(1);
  });

  it('refuses to refund more than was captured', async () => {
    const { createBooking, issueTicket, refundBooking } = await import('../../lib/bookings');
    const b = await createBooking({
      itineraryId: 'itin_sfo_jfk', passengers: [{ firstName: 'A', lastName: 'B' }],
      idempotencyKey: `k_${Date.now()}_r3`,
    });
    await issueTicket(b.bookingId);
    await expect(
      refundBooking({ bookingId: b.bookingId, amountMinor: 99_999_99, reason: 'oops' }),
    ).rejects.toThrow(/exceeds/i);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/integration/refund.test.ts`
Expected: FAIL

- [ ] **Step 3: Create `lib/bookings/refund.ts` and re-export it from `index.ts`**

```typescript
import { refunds } from '../db';
import { refund as hsRefund } from './hyperswitch';

export async function refundBooking(input: {
  bookingId: string;
  amountMinor: number;
  reason: string;
}): Promise<{ state: BookingState }> {
  return db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings)
      .where(eq(bookings.id, input.bookingId)).for('update');
    if (!booking) throw new Error(`Unknown booking ${input.bookingId}`);
    if (booking.state !== 'TICKETED' && booking.state !== 'PARTIALLY_REFUNDED') {
      throw new Error(`Cannot refund a booking in state ${booking.state}`);
    }

    const [payment] = await tx.select().from(payments)
      .where(and(eq(payments.bookingId, input.bookingId), eq(payments.kind, 'flight')));

    const existing = await tx.select().from(refunds).where(eq(refunds.paymentId, payment.id));
    const alreadyRefunded = existing.reduce((sum, r) => sum + r.amountMinor, 0);
    if (alreadyRefunded + input.amountMinor > payment.amountMinor) {
      throw new Error(
        `Refund exceeds captured amount: ${alreadyRefunded} + ${input.amountMinor} > ${payment.amountMinor}`,
      );
    }

    // Idempotency guard: insert first, let the unique index on
    // (payment_id, reason) reject a duplicate before any money moves.
    const refundId = newId();
    try {
      await tx.insert(refunds).values({
        id: refundId, paymentId: payment.id, amountMinor: input.amountMinor,
        reason: input.reason, state: 'pending',
      });
    } catch {
      return { state: booking.state };   // already refunded for this reason
    }

    const result = await hsRefund({
      hsPaymentId: payment.hsPaymentId,
      amountMinor: input.amountMinor,
      reason: input.reason,
    });

    await tx.update(refunds)
      .set({ hsRefundId: result.refund_id, state: result.status, updatedAt: new Date() })
      .where(eq(refunds.id, refundId));

    const total = alreadyRefunded + input.amountMinor;
    const state = nextState(
      booking.state,
      total >= payment.amountMinor ? 'REFUNDED_FULL' : 'REFUNDED_PARTIAL',
    );
    await tx.update(bookings).set({ state, updatedAt: new Date() }).where(eq(bookings.id, input.bookingId));
    await recordEvent(input.bookingId, 'refund.created', { amount: input.amountMinor, reason: input.reason }, tx);

    return { state };
  });
}
```

The refund row is inserted **before** the Hyperswitch call. The unique index rejects the duplicate while it is still free to do so — after the call it would be too late.

- [ ] **Step 4: Implement the route**, accepting `{ amountMinor: number, reason: string }` validated with zod.

- [ ] **Step 5: Run and confirm pass**

Run: `npx vitest run tests/integration/refund.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/bookings/ app/api/bookings/ tests/integration/refund.test.ts
git commit -m "feat: partial and full refunds guarded by a pre-call unique constraint"
```

---

### Task 16: Operations console

**Files:**
- Create: `app/ops/page.tsx`, `app/api/ops/bookings/route.ts`

**Interfaces:**
- Consumes: all booking operations
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Implement the data route**

```typescript
import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { db, bookings, payments } from '../../../../db';
import { getPayment } from '../../../../lib/hyperswitch';

export async function GET() {
  const rows = await db.select().from(bookings).orderBy(desc(bookings.createdAt)).limit(25);

  const enriched = await Promise.all(rows.map(async (b) => {
    const [p] = await db.select().from(payments).where(eq(payments.bookingId, b.id));
    let live: string | null = null;
    try {
      live = p ? (await getPayment(p.hsPaymentId)).status : null;
    } catch {
      live = 'unreachable';
    }
    return {
      ...b,
      hsPaymentId: p?.hsPaymentId ?? null,
      connector: p?.connector ?? null,
      storedPaymentState: p?.state ?? null,
      livePaymentState: live,
      diverged: p ? live !== p.state : false,
    };
  }));

  return NextResponse.json(enriched);
}
```

- [ ] **Step 2: Implement the page**

A table with one row per booking: PNR, itinerary, amount, booking state, connector, `hs_payment_id` (selectable, for cross-referencing the Control Center), stored vs live payment state with divergence highlighted, and action buttons — Issue ticket when `AUTHORIZED` or `TICKETING`, Cancel when `AUTHORIZED`, Refund when `TICKETED`. Bookings in `TICKETING` render first and highlighted: that is the state where funds are held and no ticket exists.

Every action button must disable itself while its request is in flight, for the same reason the Pay button does.

- [ ] **Step 3: Verify by hand**

Book, confirm the booking appears as `AUTHORIZED`, issue the ticket, watch it become `TICKETED` and the live payment state become `succeeded`. Cross-reference the `hs_payment_id` in the Control Center.

- [ ] **Step 4: Commit**

```bash
git add app/ops/ app/api/ops/
git commit -m "feat: operations console with stored vs live payment state"
```

---

### Task 17: Trip protection — flow G

**Files:**
- Create: `app/api/bookings/[id]/protection/route.ts`
- Create: `lib/bookings/protection.ts`; Modify: `lib/bookings/index.ts` (re-export `addTripProtection`), `app/checkout/[bookingId]/CheckoutForm.tsx` (add the opt-in)
- Test: `tests/integration/protection.test.ts`

**Interfaces:**
- Produces: `addTripProtection(bookingId: string): Promise<{ connector: string | null }>`

Amount is fixed at `usd(24)` = `2400`, deliberately under the `$50` routing threshold so the rule sends it to `fauxpay`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/protection.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/hyperswitch', () => ({
  createIntent: vi.fn(async (i) => ({
    payment_id: i.hsPaymentId, status: 'succeeded',
    connector: i.amountMinor < 5000 ? 'fauxpay' : 'stripe',
    client_secret: 'cs', amount: i.amountMinor, amount_capturable: 0,
    amount_received: i.amountMinor, payment_method_id: null,
    error_message: null, error_code: null,
  })),
  capture: vi.fn(), voidPayment: vi.fn(), getPayment: vi.fn(), refund: vi.fn(),
}));

describe('trip protection', () => {
  it('is auto-capture and lands on the dummy connector', async () => {
    const { createBooking, addTripProtection } = await import('../../lib/bookings');
    const b = await createBooking({
      itineraryId: 'itin_sfo_jfk', passengers: [{ firstName: 'A', lastName: 'B' }],
      idempotencyKey: `k_${Date.now()}_p1`,
    });
    const r = await addTripProtection(b.bookingId);
    expect(r.connector).toBe('fauxpay');
  });

  it('cannot be added twice', async () => {
    const { createBooking, addTripProtection } = await import('../../lib/bookings');
    const b = await createBooking({
      itineraryId: 'itin_sfo_jfk', passengers: [{ firstName: 'A', lastName: 'B' }],
      idempotencyKey: `k_${Date.now()}_p2`,
    });
    await addTripProtection(b.bookingId);
    await expect(addTripProtection(b.bookingId)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/integration/protection.test.ts`
Expected: FAIL

- [ ] **Step 3: Create `lib/bookings/protection.ts` and re-export it from `index.ts`**

```typescript
const TRIP_PROTECTION_MINOR = 2400;   // $24.00 — below the $50 routing threshold

export async function addTripProtection(bookingId: string): Promise<{ connector: string | null }> {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!booking) throw new Error(`Unknown booking ${bookingId}`);

  const paymentId = newId();
  const hsPaymentId = toHsPaymentId(paymentId);

  // The unique index on (booking_id, kind) rejects a second protection payment.
  await db.insert(payments).values({
    id: paymentId, bookingId, kind: 'protection', hsPaymentId,
    amountMinor: TRIP_PROTECTION_MINOR, captureMethod: 'automatic', state: 'pending',
  });

  const intent = await createIntent({
    hsPaymentId,
    amountMinor: TRIP_PROTECTION_MINOR,
    captureMethod: 'automatic',
    customerId: booking.customerId!,
    description: 'Trip protection',
    returnUrl: `${env.APP_BASE_URL}/confirmation/${bookingId}`,
    orderDetails: [{ product_name: 'Trip protection', quantity: 1, amount: TRIP_PROTECTION_MINOR }],
  });

  assertCapableOrThrow(intent.connector, 'protection');

  await db.update(payments)
    .set({ connector: intent.connector, state: intent.status, updatedAt: new Date() })
    .where(eq(payments.id, paymentId));
  await recordEvent(bookingId, 'protection.added', { connector: intent.connector });

  return { connector: intent.connector };
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `npx vitest run tests/integration/protection.test.ts`
Expected: PASS

- [ ] **Step 5: Verify the routing rule fires against the real sandbox**

Book with protection and confirm in the Control Center that the $24.00 payment shows `fauxpay` while the flight payment shows `stripe`. If both show the same connector the rule is inactive — check it was saved **and activated**.

- [ ] **Step 6: Commit**

```bash
git add lib/bookings/ app/ tests/integration/protection.test.ts
git commit -m "feat: trip protection routed to the dummy connector by rule"
```

---

### Task 18: Post-booking ancillary charge — flow H

**Files:**
- Create: `app/api/bookings/[id]/ancillary/route.ts`
- Create: `lib/bookings/ancillary.ts`; Modify: `lib/bookings/index.ts` (re-export `chargeAncillary`)
- Test: `tests/integration/ancillary.test.ts`

**Interfaces:**
- Produces: `chargeAncillary(input: { bookingId: string; description: string; amountMinor: number; idempotencyKey: string }): Promise<{ status: string }>`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/ancillary.test.ts
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, bookings } from '../../db';

vi.mock('../../lib/hyperswitch', () => ({
  createIntent: vi.fn(async (i) => ({
    payment_id: i.hsPaymentId, status: 'requires_capture', connector: 'stripe',
    client_secret: 'cs', amount: i.amountMinor, amount_capturable: i.amountMinor,
    amount_received: null, payment_method_id: 'pm_saved_123',
    error_message: null, error_code: null,
  })),
  chargeOffSession: vi.fn(async () => ({ status: 'succeeded', connector: 'stripe' })),
  capture: vi.fn(async () => ({ status: 'succeeded' })),
  voidPayment: vi.fn(), getPayment: vi.fn(), refund: vi.fn(),
}));

describe('chargeAncillary', () => {
  it('refuses when no payment method was saved at booking', async () => {
    const { createBooking, chargeAncillary } = await import('../../lib/bookings');
    const b = await createBooking({
      itineraryId: 'itin_sfo_jfk', passengers: [{ firstName: 'A', lastName: 'B' }],
      idempotencyKey: `k_${Date.now()}_a1`,
    });
    await expect(chargeAncillary({
      bookingId: b.bookingId, description: 'Checked bag',
      amountMinor: 3500, idempotencyKey: `k_${Date.now()}_a1x`,
    })).rejects.toThrow(/payment method/i);
  });

  it('charges off-session when a payment method exists', async () => {
    const { createBooking, chargeAncillary } = await import('../../lib/bookings');
    const { chargeOffSession } = await import('../../lib/hyperswitch');
    const b = await createBooking({
      itineraryId: 'itin_sfo_jfk', passengers: [{ firstName: 'A', lastName: 'B' }],
      idempotencyKey: `k_${Date.now()}_a2`,
    });
    await db.update(bookings)
      .set({ state: 'TICKETED', paymentMethodId: 'pm_saved_123' })
      .where(eq(bookings.id, b.bookingId));

    const r = await chargeAncillary({
      bookingId: b.bookingId, description: 'Checked bag',
      amountMinor: 3500, idempotencyKey: `k_${Date.now()}_a2x`,
    });
    expect(r.status).toBe('succeeded');
    expect(chargeOffSession).toHaveBeenCalledTimes(1);
  });

  it('does not charge twice for the same idempotency key', async () => {
    const { createBooking, chargeAncillary } = await import('../../lib/bookings');
    const { chargeOffSession } = await import('../../lib/hyperswitch');
    vi.mocked(chargeOffSession).mockClear();

    const b = await createBooking({
      itineraryId: 'itin_sfo_jfk', passengers: [{ firstName: 'A', lastName: 'B' }],
      idempotencyKey: `k_${Date.now()}_a3`,
    });
    await db.update(bookings)
      .set({ state: 'TICKETED', paymentMethodId: 'pm_saved_123' })
      .where(eq(bookings.id, b.bookingId));

    const key = `k_${Date.now()}_a3x`;
    await chargeAncillary({ bookingId: b.bookingId, description: 'Bag', amountMinor: 3500, idempotencyKey: key });
    await chargeAncillary({ bookingId: b.bookingId, description: 'Bag', amountMinor: 3500, idempotencyKey: key });

    expect(chargeOffSession).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/integration/ancillary.test.ts`
Expected: FAIL

- [ ] **Step 3: Create `lib/bookings/ancillary.ts` and re-export it from `index.ts`**

```typescript
import { chargeOffSession } from './hyperswitch';

export async function chargeAncillary(input: {
  bookingId: string;
  description: string;
  amountMinor: number;
  idempotencyKey: string;
}): Promise<{ status: string }> {
  const { result } = await withIdempotency(
    input.idempotencyKey,
    '/api/bookings/ancillary',
    { bookingId: input.bookingId, amountMinor: input.amountMinor, description: input.description },
    async () => {
      const [booking] = await db.select().from(bookings).where(eq(bookings.id, input.bookingId));
      if (!booking) throw new Error(`Unknown booking ${input.bookingId}`);
      if (booking.state !== 'TICKETED') {
        throw new Error(`Cannot charge an ancillary on a booking in state ${booking.state}`);
      }
      if (!booking.paymentMethodId) {
        throw new Error(
          'No stored payment method for this booking; the traveller did not consent to save their card at checkout',
        );
      }

      const paymentId = newId();
      const hsPaymentId = toHsPaymentId(paymentId);

      await db.insert(payments).values({
        id: paymentId, bookingId: input.bookingId, kind: 'ancillary', hsPaymentId,
        amountMinor: input.amountMinor, captureMethod: 'automatic', state: 'pending',
      });

      const charged = await chargeOffSession({
        hsPaymentId,
        amountMinor: input.amountMinor,
        customerId: booking.customerId!,
        paymentMethodId: booking.paymentMethodId,
        description: input.description,
      });

      await db.update(payments)
        .set({ connector: charged.connector, state: charged.status, updatedAt: new Date() })
        .where(eq(payments.id, paymentId));
      await recordEvent(input.bookingId, 'ancillary.charged', {
        description: input.description, amount: input.amountMinor,
      });

      return { status: charged.status };
    },
  );
  return result;
}
```

- [ ] **Step 4: Capture `payment_method_id` at booking**

In the webhook handler, when a flight payment reaches `requires_capture` and the event carries `payment_method_id`, persist it to `bookings.paymentMethodId`. Without this, flow H has nothing to charge.

- [ ] **Step 5: Run and confirm pass**

Run: `npx vitest run tests/integration/ancillary.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/bookings/ app/ tests/integration/ancillary.test.ts
git commit -m "feat: off-session ancillary charge using the stored payment method"
```

---

### Task 19: End-to-end verification, seed script and README

**Files:**
- Create: `scripts/seed.ts`, `README.md`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Add npm scripts**

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest",
    "smoke": "tsx -r dotenv/config scripts/smoke.ts",
    "seed": "tsx -r dotenv/config scripts/seed.ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

- [ ] **Step 2: Write `scripts/seed.ts`**

Creates one booking in each demonstrable state so the ops console is populated at the start of a walkthrough: one `AUTHORIZED` awaiting issuance, one `TICKETED`, one `VOIDED` from a failed issuance, one `PARTIALLY_REFUNDED`.

**Run this on demo day, not before.** Dummy-connector payments expire after two days, so seeded trip-protection data goes stale.

- [ ] **Step 3: Write the README**

Must cover: what this is and the vertical, the one-paragraph architecture, setup from a cold start (Hyperswitch account, Stripe test key, connectors, routing rule, `.env`, migrations), how to run the smoke test, the demo script in order, the test cards table (`4242424242424242` success, `4000000000000002` decline, `4000000000009995` insufficient funds), links to `FEATURE_booking_payments.md`, `SCHEMA.md` and `DECISIONS.md`, and a **Known simplifications** section that states plainly: the GDS is simulated, the retryable-issuance counter is in-memory and will reset on a cold start, and there is no authentication on `/ops`.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 5: Run both end-to-end paths against the real sandbox**

Book `itin_sfo_jfk` → issue → confirm `succeeded` in the Control Center.
Book `itin_bos_sea` → issue → confirm `cancelled` and that no capture occurred.

- [ ] **Step 6: Commit**

```bash
git add scripts/seed.ts README.md package.json
git commit -m "docs: README, seed script and end-to-end verification"
```

---

## Self-Review

**Spec coverage.** Flows A–H map to Tasks 10/11, 11, 13, 13, 14, 15, 17, 18. The four idempotency points map to Tasks 10 (create), 11 (confirm, client-side), 13 (capture), 15 (refund). Connector capability is Task 7 and is exercised in 13, 14, 17. The state machine is Task 4. Error handling is distributed: unknown-outcome reads in Task 6's `getPayment` plus the ops console in 16, monotonic webhooks in 12, ticketing classification in 9 and 13, server-side deadline in 14.

**Two gaps found and accepted, not silently dropped:**

1. The spec's "resolve ambiguity by reading state back" (D-011) is implemented as `getPayment` availability and divergence display, but no task wires an automatic reconciliation on timeout. For a prototype the ops console surfacing divergence is sufficient; a production build needs a reconciliation job. Recorded here rather than pretended away.
2. `payment_method_id` capture (Task 18, Step 4) depends on the webhook carrying that field, which is unverified. If it does not, the fallback is a `getPayment` read after authorization — one extra call, no design change.

**Placeholder scan.** Task 16 Step 2 and Task 19 Steps 2–3 describe UI and prose rather than showing full code. That is deliberate — they are presentational and the required content is enumerated explicitly. Every step that produces logic contains real code.

**Type consistency.** `BookingState` and `BookingEvent` originate in Task 4 and are used unchanged in 13, 14, 15. `HsPayment` originates in Task 6 and is the return type throughout. `PaymentKind` is declared in both `db/schema.ts` (as a pg enum) and `lib/connector-capabilities.ts` (as a union) — **implementer note: import the union from `connector-capabilities` and derive the enum values from it, so the two cannot drift.**

---

## Risk register carried from the spec

| Risk | Where it is addressed |
| --- | --- |
| Manual capture unavailable on the connector | Task 2, before anything is built |
| Dummy payments expire after 2 days | Task 19, seed on demo day |
| Webhook URL churn on preview deploys | Task 12 Step 6, production alias only |
| Minor-unit arithmetic | Task 3, plus the reconciliation check in Task 6 |
| A flight payment stranding on `fauxpay` | Task 2 prerequisite 8, plus Task 7 enforcement |
| Scope creep into airline search | Task 9, three hardcoded fixtures |
