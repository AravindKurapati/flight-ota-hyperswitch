'use client';
// Operations console (Task 16). NO AUTHENTICATION — a known, accepted
// simplification for this prototype (also listed in README.md's "Known
// simplifications"). Anyone who can reach this URL can issue, cancel and
// refund. Do not deploy this page as-is beyond a demo.
import { useCallback, useEffect, useState } from 'react';
import { formatUsd } from '../../lib/money';

type OpsRow = {
  id: string;
  pnr: string;
  itineraryId: string;
  amountMinor: number;
  state: string;
  ticketNumber: string | null;
  hsPaymentId: string | null;
  connector: string | null;
  storedPaymentState: string | null;
  livePaymentState: string | null;
  diverged: boolean;
};

export default function OpsPage() {
  const [rows, setRows] = useState<OpsRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Booking id of the row whose action is in flight; disables that row's
  // buttons — same double-click discipline as the checkout Pay button.
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ops/bookings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRows(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function act(bookingId: string, path: string, body?: unknown) {
    if (busy) return;
    setBusy(bookingId);
    setError(null);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const responseBody = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof responseBody.error === 'string' ? responseBody.error : `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  }

  function refund(row: OpsRow) {
    const amount = window.prompt(
      `Refund amount in cents (captured: ${row.amountMinor})`,
      String(row.amountMinor),
    );
    if (!amount) return;
    const reason = window.prompt('Refund reason (one refund per reason)', 'goodwill');
    if (!reason) return;
    void act(row.id, 'refund', { amountMinor: Number(amount), reason });
  }

  if (rows === null) {
    return (
      <>
        <header className="nav-edge">
          <a className="wordmark" href="/">
            Flight OTA<small>sandbox</small>
          </a>
        </header>
        <main className="ops-shell">
          {error ? (
            <p className="ops-alert" role="alert">Failed to load: {error}</p>
          ) : (
            <p className="checkout-note">Loading…</p>
          )}
        </main>
      </>
    );
  }

  // TICKETING first: funds are held and no ticket exists yet — the single
  // most operationally urgent state in the system.
  const sorted = [...rows].sort((a, b) =>
    Number(b.state === 'TICKETING') - Number(a.state === 'TICKETING'));

  return (
    <>
      <header className="nav-edge">
        <a className="wordmark" href="/">
          Flight OTA<small>sandbox</small>
        </a>
        <a className="nav-edge__link" href="/">
          ← Booking
        </a>
      </header>
      <main className="ops-shell">
        <h1>Operations console</h1>
        <p className="ops-shell__lede">
          Stored vs. live payment state shown side by side; a highlighted row pair has
          diverged and needs a human look (reconciliation is surfaced, not automated).
        </p>
        {error && <p className="ops-alert" role="alert">{error}</p>}
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                {['PNR', 'Itinerary', 'Amount', 'Booking state', 'Ticket', 'Connector',
                  'hs_payment_id', 'Stored payment', 'Live payment', 'Actions'].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const urgent = row.state === 'TICKETING';
                return (
                  <tr key={row.id} className={urgent ? 'is-urgent' : undefined}>
                    <td>{row.pnr}</td>
                    <td>{row.itineraryId}</td>
                    <td className="ops-mono">{formatUsd(row.amountMinor)}</td>
                    <td className="ops-state">
                      {row.state}{urgent ? ' ⚠' : ''}
                    </td>
                    <td>{row.ticketNumber ?? '—'}</td>
                    <td>{row.connector ?? '—'}</td>
                    <td className="ops-mono ops-mono--select">{row.hsPaymentId ?? '—'}</td>
                    <td className={row.diverged ? 'ops-cell--diverged' : undefined}>
                      {row.storedPaymentState ?? '—'}
                    </td>
                    <td className={row.diverged ? 'ops-cell--diverged' : undefined}>
                      {row.livePaymentState ?? '—'}{row.diverged ? ' ≠' : ''}
                    </td>
                    <td>
                      <div className="ops-actions">
                        {(row.state === 'AUTHORIZED' || row.state === 'TICKETING') && (
                          <button
                            className="btn btn-sm"
                            disabled={busy === row.id}
                            onClick={() => void act(row.id, 'issue')}
                          >
                            Issue ticket
                          </button>
                        )}
                        {row.state === 'AUTHORIZED' && (
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={busy === row.id}
                            onClick={() => void act(row.id, 'cancel')}
                          >
                            Cancel
                          </button>
                        )}
                        {(row.state === 'TICKETED' || row.state === 'PARTIALLY_REFUNDED') && (
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={busy === row.id}
                            onClick={() => refund(row)}
                          >
                            Refund
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>
      <footer className="foot-line">
        <p>NO AUTHENTICATION — internal demo tool, not for production use</p>
      </footer>
    </>
  );
}
