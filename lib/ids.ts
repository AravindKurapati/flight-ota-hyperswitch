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
