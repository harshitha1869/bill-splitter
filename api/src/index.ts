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

// --- global JSON errors ---
app.notFound((c) => c.json({ error: 'not found' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'internal server error' }, 500)
})

export default app
