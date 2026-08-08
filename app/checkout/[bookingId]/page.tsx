'use client';
import { use, useEffect, useState } from 'react';
import { loadHyper } from '@juspay-tech/hyper-js';
import type { HyperInstance } from '@juspay-tech/hyper-js';
import { HyperElements } from '@juspay-tech/react-hyper-js';
import { CheckoutForm } from './CheckoutForm';

// Task-11 correction 5: params is a Promise in this Next.js version
// (16.3.0 — params/searchParams have been Promise-typed since 15.0.0-RC).
// This page must stay a Client Component (it owns useState/useEffect for
// the client_secret fetch and the mounted <HyperElements> tree — hooks that
// depend on `loadHyper`'s browser-side script injection), so it cannot be
// `async` the way a Server Component page could. `use()` is React's
// documented mechanism for unwrapping a promise prop inside a Client
// Component's render body instead (verified against this exact pattern in
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md).
export default function CheckoutPage({
  params,
}: {
  params: Promise<{ bookingId: string }>;
}) {
  const { bookingId } = use(params);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [hyperPromise, setHyperPromise] = useState<Promise<HyperInstance> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/bookings/${bookingId}/session`)
      .then((r) => {
        if (!r.ok) throw new Error(`Could not load this booking (status ${r.status}).`);
        return r.json() as Promise<{ clientSecret: string; publishableKey: string }>;
      })
      .then((d) => {
        if (cancelled) return;
        setClientSecret(d.clientSecret);
        setHyperPromise(
          loadHyper(d.publishableKey, { customBackendUrl: 'https://sandbox.hyperswitch.io' }),
        );
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load checkout.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bookingId]);

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!clientSecret || !hyperPromise) return <p>Loading checkout…</p>;

  return (
    <HyperElements options={{ clientSecret }} hyper={hyperPromise}>
      <CheckoutForm bookingId={bookingId} />
    </HyperElements>
  );
}
