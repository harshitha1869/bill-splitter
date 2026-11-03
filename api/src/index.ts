import { Hono } from 'hono'

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

// --- global JSON errors ---
app.notFound((c) => c.json({ error: 'not found' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'internal server error' }, 500)
})

export default app
