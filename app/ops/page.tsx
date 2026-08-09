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
    return <main style={{ margin: '2rem', fontFamily: 'sans-serif' }}>
      {error ? <p role="alert">Failed to load: {error}</p> : <p>Loading…</p>}
    </main>;
  }

  // TICKETING first: funds are held and no ticket exists yet — the single
  // most operationally urgent state in the system.
  const sorted = [...rows].sort((a, b) =>
    Number(b.state === 'TICKETING') - Number(a.state === 'TICKETING'));

  return (
    <main style={{ margin: '2rem', fontFamily: 'sans-serif' }}>
      <h1>Operations console</h1>
      <p>
        Stored vs. live payment state shown side by side; a highlighted row pair has
        diverged and needs a human look (reconciliation is surfaced, not automated).
      </p>
      {error && <p role="alert" style={{ color: '#b00020' }}>{error}</p>}
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            {['PNR', 'Itinerary', 'Amount', 'Booking state', 'Ticket', 'Connector',
              'hs_payment_id', 'Stored payment', 'Live payment', 'Actions'].map((h) => (
              <th key={h} style={{ textAlign: 'left', borderBottom: '2px solid #333', padding: '0.4rem' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const urgent = row.state === 'TICKETING';
            const cell: React.CSSProperties = { borderBottom: '1px solid #ddd', padding: '0.4rem' };
            return (
              <tr key={row.id} style={urgent ? { background: '#fff3cd' } : undefined}>
                <td style={cell}>{row.pnr}</td>
                <td style={cell}>{row.itineraryId}</td>
                <td style={cell}>{formatUsd(row.amountMinor)}</td>
                <td style={{ ...cell, fontWeight: urgent ? 700 : 400 }}>
                  {row.state}{urgent ? ' ⚠' : ''}
                </td>
                <td style={cell}>{row.ticketNumber ?? '—'}</td>
                <td style={cell}>{row.connector ?? '—'}</td>
                <td style={{ ...cell, fontFamily: 'monospace', fontSize: '0.8rem', userSelect: 'all' }}>
                  {row.hsPaymentId ?? '—'}
                </td>
                <td style={{ ...cell, background: row.diverged ? '#f8d7da' : undefined }}>
                  {row.storedPaymentState ?? '—'}
                </td>
                <td style={{ ...cell, background: row.diverged ? '#f8d7da' : undefined, fontWeight: row.diverged ? 700 : 400 }}>
                  {row.livePaymentState ?? '—'}{row.diverged ? ' ≠' : ''}
                </td>
                <td style={cell}>
                  {(row.state === 'AUTHORIZED' || row.state === 'TICKETING') && (
                    <button disabled={busy === row.id} onClick={() => void act(row.id, 'issue')}>
                      Issue ticket
                    </button>
                  )}{' '}
                  {row.state === 'AUTHORIZED' && (
                    <button disabled={busy === row.id} onClick={() => void act(row.id, 'cancel')}>
                      Cancel
                    </button>
                  )}{' '}
                  {(row.state === 'TICKETED' || row.state === 'PARTIALLY_REFUNDED') && (
                    <button disabled={busy === row.id} onClick={() => refund(row)}>
                      Refund
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
