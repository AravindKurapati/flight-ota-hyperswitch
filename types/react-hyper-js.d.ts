// Ambient module declaration for `@juspay-tech/react-hyper-js`.
//
// Task-11 correction 2: this package ships NO `.d.ts` and no `types` field
// (verified by listing every file under
// node_modules/@juspay-tech/react-hyper-js — only dist/bundle.js,
// dist/index.js, dist/index.mjs, README, LICENSE). Importing from it
// un-declared fails `tsc --noEmit` with TS7016 under this project's
// `strict: true`. This file exists to close that gap honestly: it types
// only the members this app actually calls, derived from reading the
// compiled bundle (dist/index.mjs) directly, not invented or copied from
// any Stripe-shaped guess.
//
// What the bundle actually does (see task-11-report.md for the full
// investigation):
//   - `useHyper()` returns a context value whose `confirmPayment` is
//     literally `HyperInstance.confirmPayment` from `@juspay-tech/hyper-js`,
//     passed through unmodified once the `hyper` promise resolves inside
//     <HyperElements>. That is what makes it safe to reuse hyper-js's own
//     `confirmPaymentInputPayload` / response types here rather than
//     inventing new ones.
//   - `useWidgets()` returns the internal Elements-like registry
//     (`{options, update, getElement, fetchUpdates, create}`) that
//     <UnifiedCheckout>/<PaymentElement> use internally to mount. This app
//     does not currently pass its result anywhere (see Correction 3
//     resolution in CheckoutForm.tsx) — typed as `unknown` rather than
//     guessed, since nothing here inspects its shape.
//   - `UnifiedCheckout` and `PaymentElement` are the SAME compiled
//     component (componentType: "payment"); `UnifiedCheckout` is just the
//     current, non-deprecated export name for it.
//   - `useStripe`/`useElements` exist too but the compiled code itself
//     calls `console.warn(...)` marking them deprecated aliases for
//     `useHyper`/`useWidgets` — not declared here since this app doesn't
//     use them.
declare module '@juspay-tech/react-hyper-js' {
  import type { ReactElement, ReactNode } from 'react';
  import type {
    confirmPaymentInputPayload,
    ConfirmPaymentResponse,
    ConfirmPaymentErrorResponse,
    HyperInstance,
  } from '@juspay-tech/hyper-js';

  /** The object returned by `useHyper()`. Only the member this app calls is typed. */
  export interface HyperContextValue {
    confirmPayment(
      params: confirmPaymentInputPayload,
    ): Promise<ConfirmPaymentResponse | ConfirmPaymentErrorResponse>;
  }

  export function useHyper(): HyperContextValue;

  /** See file header: shape not needed by this app, so left opaque. */
  export function useWidgets(): unknown;

  export interface HyperElementsProps {
    children: ReactNode;
    /** Must include `clientSecret`; see hyper-js's `ElementsOptions`. */
    options: { clientSecret: string; [key: string]: unknown };
    /** The return value of `loadHyper(...)`. */
    hyper: Promise<HyperInstance>;
  }

  export function HyperElements(props: HyperElementsProps): ReactElement;

  export interface UnifiedCheckoutProps {
    id?: string;
    options?: Record<string, unknown>;
  }

  export function UnifiedCheckout(props: UnifiedCheckoutProps): ReactElement;
}
