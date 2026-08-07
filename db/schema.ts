import {
  pgTable, pgEnum, text, bigint, jsonb, timestamp, char,
  uniqueIndex, index, check,
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
  createdIdx: index('bookings_created_at_idx').on(t.createdAt.desc()),
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
  // GENERATED ALWAYS AS IDENTITY, not bigserial: this is an append-only audit
  // log, so a caller must not be able to supply its own id (bigserial is a
  // plain bigint + nextval() default and silently allows that).
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
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
}, (t) => ({
  createdIdx: index('idempotency_created_at_idx').on(t.createdAt),
}));
