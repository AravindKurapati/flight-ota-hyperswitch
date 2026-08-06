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
