import { Hono } from 'hono'
import { splitCents } from './split'

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) => c.json({ status: 'ok' }))

// --- helpers ---
function parseName(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const { name } = body as { name?: unknown }
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  return trimmed.length > 0 ? trimmed : null
}

// --- routes ---
app.post('/api/homes', async (c) => {
  const body: unknown = await c.req.json().catch(() => null)
  const name = parseName(body)
  if (name === null) return c.json({ error: 'name must be a non-empty string' }, 422)

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, name).run()
  return c.json({ id, name }, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) return c.json({ error: 'home not found' }, 404)

  const body: unknown = await c.req.json().catch(() => null)
  const name = parseName(body)
  if (name === null) return c.json({ error: 'name must be a non-empty string' }, 422)

  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO members (id, home_id, name, position)
     SELECT ?, ?, ?, COALESCE(MAX(position), 0) + 1
     FROM members WHERE home_id = ?`,
  )
    .bind(id, homeId, name, homeId)
    .run()
  return c.json({ id, homeId, name }, 201)
})
interface MemberRow {
  id: string
}

interface BillInput {
  title: string
  totalCents: number
}

function parseBillInput(body: unknown): BillInput | null {
  if (typeof body !== 'object' || body === null) return null
  const { title, totalCents } = body as { title?: unknown; totalCents?: unknown }

  if (typeof title !== 'string' || title.trim().length === 0) return null
  if (typeof totalCents !== 'number') return null
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) return null

  return { title: title.trim(), totalCents }
}

app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')

  // 1. home must exist
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) return c.json({ error: 'home not found' }, 404)

  // 2 + 3. parse and validate the body
  const body: unknown = await c.req.json().catch(() => null)
  const input = parseBillInput(body)
  if (input === null) {
    return c.json(
      { error: 'title must be non-empty and totalCents must be a positive whole number' },
      422,
    )
  }

  // 4. members in the order they were added
  const { results: members } = await c.env.DB.prepare(
    'SELECT id FROM members WHERE home_id = ? ORDER BY position',
  )
    .bind(homeId)
    .all<MemberRow>()
  if (members.length === 0) return c.json({ error: 'home has no members' }, 422)

  // 5. split in whole cents
  const amounts = splitCents(input.totalCents, members.length)

  // 6. build ids and rows, then write everything in one transaction
  const billId = crypto.randomUUID()
  const shares = members.map((member, index) => {
    const amountCents = amounts[index]
    if (amountCents === undefined) throw new Error('split result does not match members')
    return { id: crypto.randomUUID(), memberId: member.id, amountCents, paidAt: null }
  })

  const billInsert = c.env.DB.prepare(
    'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
  ).bind(billId, homeId, input.title, input.totalCents)

  const shareInserts = shares.map((share, index) =>
    c.env.DB.prepare(
      'INSERT INTO shares (id, bill_id, member_id, amount_cents, position) VALUES (?, ?, ?, ?, ?)',
    ).bind(share.id, billId, share.memberId, share.amountCents, index + 1),
  )

  await c.env.DB.batch([billInsert, ...shareInserts])

  // 7. respond
  return c.json(
    { id: billId, homeId, title: input.title, totalCents: input.totalCents, shares },
    201,
  )
})
interface ShareRow {
  id: string
  member_id: string
  amount_cents: number
  paid_at: string | null
  idempotency_key: string | null
}

interface BalanceRow {
  member_id: string
  name: string
  outstanding_cents: number
}

function shareResponse(row: ShareRow, paidAt: string) {
  return { id: row.id, memberId: row.member_id, amountCents: row.amount_cents, paidAt }
}

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  // 1. header check first
  const key = c.req.header('Idempotency-Key')?.trim()
  if (!key) return c.json({ error: 'Idempotency-Key header is required' }, 400)
  if (key.length > 255) return c.json({ error: 'Idempotency-Key is too long' }, 400)

  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const paidAt = new Date().toISOString()

  // 2. let the database decide who wins: only an unpaid row can match
  const result = await c.env.DB.prepare(
    `UPDATE shares SET paid_at = ?, idempotency_key = ?
     WHERE id = ? AND bill_id = ? AND paid_at IS NULL`,
  )
    .bind(paidAt, key, shareId, billId)
    .run()

  // 3. read the row back to build the answer
  const share = await c.env.DB.prepare(
    `SELECT id, member_id, amount_cents, paid_at, idempotency_key
     FROM shares WHERE id = ? AND bill_id = ?`,
  )
    .bind(shareId, billId)
    .first<ShareRow>()

  if (!share || share.paid_at === null) return c.json({ error: 'share not found' }, 404)

  // 4. we won the update
  if (result.meta.changes === 1) return c.json(shareResponse(share, share.paid_at), 200)

  // 5. already paid: same key is a replay, different key is a conflict
  if (share.idempotency_key === key) return c.json(shareResponse(share, share.paid_at), 200)
  return c.json({ error: 'share already paid with a different key' }, 409)
})

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) return c.json({ error: 'home not found' }, 404)

  const { results } = await c.env.DB.prepare(
    `SELECT m.id AS member_id, m.name AS name,
            COALESCE(SUM(s.amount_cents), 0) AS outstanding_cents
     FROM members m
     LEFT JOIN shares s ON s.member_id = m.id AND s.paid_at IS NULL
     WHERE m.home_id = ?
     GROUP BY m.id, m.name, m.position
     ORDER BY m.position`,
  )
    .bind(homeId)
    .all<BalanceRow>()

  return c.json({
    balances: results.map((row) => ({
      memberId: row.member_id,
      name: row.name,
      outstandingCents: row.outstanding_cents,
    })),
  })
})


interface BillRow {
  id: string
  title: string
  total_cents: number
}

interface BillShareRow {
  id: string
  bill_id: string
  member_id: string
  amount_cents: number
  paid_at: string | null
}

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) return c.json({ error: 'home not found' }, 404)

  const { results: bills } = await c.env.DB.prepare(
    'SELECT id, title, total_cents FROM bills WHERE home_id = ? ORDER BY created_at, id',
  )
    .bind(homeId)
    .all<BillRow>()

  const { results: shares } = await c.env.DB.prepare(
    `SELECT s.id, s.bill_id, s.member_id, s.amount_cents, s.paid_at
     FROM shares s JOIN bills b ON b.id = s.bill_id
     WHERE b.home_id = ?
     ORDER BY s.position`,
  )
    .bind(homeId)
    .all<BillShareRow>()

  return c.json({
    bills: bills.map((bill) => ({
      id: bill.id,
      homeId,
      title: bill.title,
      totalCents: bill.total_cents,
      shares: shares
        .filter((s) => s.bill_id === bill.id)
        .map((s) => ({
          id: s.id,
          memberId: s.member_id,
          amountCents: s.amount_cents,
          paidAt: s.paid_at,
        })),
    })),
  })
})
// --- global JSON errors ---
app.notFound((c) => c.json({ error: 'not found' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'internal server error' }, 500)
})

export default app
