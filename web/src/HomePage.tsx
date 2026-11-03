import { useCallback, useEffect, useRef, useState } from 'react'
import { type Balance, type Bill, errorMessage, request, type Share } from './api'
import './home.css'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; bills: Bill[]; balances: Balance[] }

interface Pending {
  bill: Bill
  share: Share
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
// display only: all stored and sent amounts stay in whole cents
const formatCents = (cents: number): string => money.format(cents / 100)

function readHomeId(): string | null {
  return new URLSearchParams(window.location.search).get('homeId')
}

function billStatus(bill: Bill): { label: string; tone: string } {
  const paid = bill.shares.filter((s) => s.paidAt !== null).length
  if (paid === bill.shares.length) return { label: 'Fully paid', tone: 'good' }
  if (paid === 0) return { label: 'Pending', tone: 'bad' }
  return { label: 'Partially paid', tone: 'warn' }
}

async function fetchHome(homeId: string) {
  const [billsRes, balancesRes] = await Promise.all([
    request<{ bills: Bill[] }>(`/homes/${homeId}/bills`),
    request<{ balances: Balance[] }>(`/homes/${homeId}/balances`),
  ])
  return { bills: billsRes.bills, balances: balancesRes.balances }
}

export function HomePage() {
  const [homeId, setHomeId] = useState<string | null>(readHomeId)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [payingId, setPayingId] = useState<string | null>(null)
  const [payError, setPayError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // one idempotency key per share, reused on retry, cleared after a final answer
  const keys = useRef(new Map<string, string>())

  const reload = useCallback(
    async (showSpinner: boolean) => {
      if (!homeId) return
      if (showSpinner) setState({ status: 'loading' })
      try {
        const data = await fetchHome(homeId)
        setState({ status: 'ready', ...data })
      } catch (err) {
        setState({ status: 'error', message: errorMessage(err) })
      }
    },
    [homeId],
  )

  useEffect(() => {
    void reload(true)
  }, [reload])

  async function createDemoHome() {
    setCreating(true)
    setCreateError(null)
    try {
      const home = await request<{ id: string }>('/homes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Green Valley Apartment' }),
      })
      for (const name of ['Harshitha', 'Rahul', 'Priya', 'Ananya']) {
        await request(`/homes/${home.id}/members`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
      }
      await request(`/homes/${home.id}/bills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Electricity Bill', totalCents: 12000 }),
      })
      window.history.replaceState(null, '', `?homeId=${home.id}`)
      setHomeId(home.id)
    } catch (err) {
      setCreateError(errorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  async function confirmPayment() {
    if (!pending) return
    const { bill, share } = pending
    let key = keys.current.get(share.id)
    if (!key) {
      key = crypto.randomUUID()
      keys.current.set(share.id, key)
    }
    setPayingId(share.id)
    setPayError(null)
    try {
      await request<Share>(`/bills/${bill.id}/shares/${share.id}/pay`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
      })
      keys.current.delete(share.id)
      setPending(null)
      await reload(false)
    } catch (err) {
      // network errors and 5xx keep the key so a retry is safe; 4xx is a final answer
      if (err instanceof Error && 'status' in err) {
        const status = Number(err.status)
        if (status >= 400 && status < 500) {
          keys.current.delete(share.id)
          void reload(false)
        }
      }
      setPayError(errorMessage(err))
    } finally {
      setPayingId(null)
    }
  }

  if (!homeId) {
    return (
      <main className="page">
        <div className="state-card">
          <h2>No home selected</h2>
          <p>Create a demo home with four members and one bill to try the page.</p>
          {createError && (
            <p className="error-text" role="alert">
              {createError}
            </p>
          )}
          <button
            type="button"
            className="btn primary"
            disabled={creating}
            onClick={createDemoHome}
          >
            {creating ? 'Creating…' : 'Create demo home'}
          </button>
        </div>
      </main>
    )
  }

  if (state.status === 'loading') {
    return (
      <main className="page" aria-busy="true">
        <div className="skeleton tall" />
        <div className="skeleton" />
        <div className="skeleton" />
      </main>
    )
  }

  if (state.status === 'error') {
    return (
      <main className="page">
        <div className="state-card" role="alert">
          <h2>Something went wrong</h2>
          <p>{state.message}. Please try again.</p>
          <button type="button" className="btn primary" onClick={() => void reload(true)}>
            Retry
          </button>
        </div>
      </main>
    )
  }

  const { bills, balances } = state
  const names = new Map(balances.map((b) => [b.memberId, b.name]))
  const total = bills.reduce((sum, b) => sum + b.totalCents, 0)
  const outstanding = balances.reduce((sum, b) => sum + b.outstandingCents, 0)
  const selected = bills.find((b) => b.id === selectedId) ?? null

  return (
    <main className="page">
      <header>
        <h1>HomeSplit</h1>
        <p className="muted">Here's what's happening with your household expenses.</p>
      </header>

      <section className="stats" aria-label="Summary">
        <div className="card">
          <span className="muted">Total expenses</span>
          <strong>{formatCents(total)}</strong>
        </div>
        <div className="card warn">
          <span className="muted">Outstanding</span>
          <strong>{formatCents(outstanding)}</strong>
        </div>
        <div className="card good">
          <span className="muted">Paid</span>
          <strong>{formatCents(total - outstanding)}</strong>
        </div>
        <div className="card">
          <span className="muted">Members</span>
          <strong>{balances.length}</strong>
        </div>
      </section>

      <section className="card">
        <h2>Recent bills</h2>
        {bills.length === 0 ? (
          <div className="state-card flat">
            <h3>No bills yet</h3>
            <p>Start tracking your shared household expenses.</p>
          </div>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Bill</th>
                  <th>Members</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {bills.map((bill) => {
                  const status = billStatus(bill)
                  return (
                    <tr key={bill.id}>
                      <td>{bill.title}</td>
                      <td>{bill.shares.length}</td>
                      <td>{formatCents(bill.totalCents)}</td>
                      <td>
                        <span className={`badge ${status.tone}`}>{status.label}</span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setSelectedId(bill.id === selectedId ? null : bill.id)}
                        >
                          {bill.id === selectedId ? 'Hide' : 'View details'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && (
        <section className="card">
          <h2>{selected.title}: split breakdown</h2>
          <ul className="shares">
            {selected.shares.map((share) => (
              <li key={share.id}>
                <span>{names.get(share.memberId) ?? 'Member'}</span>
                <span>{formatCents(share.amountCents)}</span>
                {share.paidAt ? (
                  <span className="badge good">
                    Paid on {new Date(share.paidAt).toLocaleDateString()}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => {
                      setPayError(null)
                      setPending({ bill: selected, share })
                    }}
                  >
                    Pay now
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Outstanding balances</h2>
        <ul className="shares">
          {balances.map((b) => (
            <li key={b.memberId}>
              <span>{b.name}</span>
              <span>{formatCents(b.outstandingCents)}</span>
              <span className={`badge ${b.outstandingCents === 0 ? 'good' : 'warn'}`}>
                {b.outstandingCents === 0 ? 'Settled' : 'Pending'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {pending && (
        <dialog open className="modal" aria-labelledby="confirm-title">
          <h2 id="confirm-title">Confirm your payment</h2>
          <dl>
            <dt>Bill</dt>
            <dd>{pending.bill.title}</dd>
            <dt>Member</dt>
            <dd>{names.get(pending.share.memberId) ?? 'Member'}</dd>
            <dt>Share</dt>
            <dd>{formatCents(pending.share.amountCents)}</dd>
          </dl>
          {payError && (
            <p className="error-text" role="alert">
              {payError}. The share is still unpaid.
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={payingId !== null}
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={payingId !== null}
              onClick={() => void confirmPayment()}
            >
              {payingId ? 'Paying…' : payError ? 'Try again' : 'Confirm payment'}
            </button>
          </div>
        </dialog>
      )}
    </main>
  )
}
