import { describe, expect, it } from 'vitest'
import { call, createHome } from './helpers'

interface Share {
  id: string
  memberId: string
  amountCents: number
  paidAt: string | null
}

interface Bill {
  id: string
  shares: Share[]
}

interface Balances {
  balances: { memberId: string; name: string; outstandingCents: number }[]
}

async function makeBill(memberNames: string[], totalCents: number) {
  const { homeId, members } = await createHome(memberNames)
  const bill = await call<Bill>('POST', `/api/homes/${homeId}/bills`, {
    body: { title: 'Electricity', totalCents },
  })
  return { homeId, members, bill }
}

function pay(billId: string, shareId: string, key?: string) {
  return call<Share>('POST', `/api/bills/${billId}/shares/${shareId}/pay`, {
    headers: key ? { 'Idempotency-Key': key } : {},
  })
}

describe('extra edge cases', () => {
  it('lets only one of two simultaneous payments with different keys win', async () => {
    const { homeId, bill } = await makeBill(['Asha', 'Ben'], 1000)
    const share = bill.body.shares[0]
    if (!share) throw new Error('no share')

    const [a, b] = await Promise.all([
      pay(bill.body.id, share.id, crypto.randomUUID()),
      pay(bill.body.id, share.id, crypto.randomUUID()),
    ])

    expect([a.status, b.status].sort()).toEqual([200, 409])

    const balances = await call<Balances>('GET', `/api/homes/${homeId}/balances`)
    expect(balances.body.balances.map((x) => x.outstandingCents)).toEqual([0, 500])
  })

  it('answers 200 with the same paidAt for two simultaneous requests with the same key', async () => {
    const { bill } = await makeBill(['Asha', 'Ben'], 1000)
    const share = bill.body.shares[0]
    if (!share) throw new Error('no share')
    const key = crypto.randomUUID()

    const [a, b] = await Promise.all([
      pay(bill.body.id, share.id, key),
      pay(bill.body.id, share.id, key),
    ])

    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.body.paidAt).toBe(b.body.paidAt)
  })

  it('gives 0 cents to members when the total is smaller than the member count', async () => {
    const { bill } = await makeBill(['A', 'B', 'C', 'D', 'E'], 2)
    expect(bill.body.shares.map((s) => s.amountCents)).toEqual([1, 1, 0, 0, 0])
  })

  it('returns 404 when the share belongs to a different bill', async () => {
    const first = await makeBill(['Asha', 'Ben'], 1000)
    const second = await makeBill(['Cara', 'Dev'], 1000)
    const foreignShare = second.bill.body.shares[0]
    if (!foreignShare) throw new Error('no share')

    const res = await pay(first.bill.body.id, foreignShare.id, crypto.randomUUID())
    expect(res.status).toBe(404)
  })

  it('rejects an Idempotency-Key that is too long', async () => {
    const { bill } = await makeBill(['Asha'], 500)
    const share = bill.body.shares[0]
    if (!share) throw new Error('no share')

    const res = await pay(bill.body.id, share.id, 'x'.repeat(300))
    expect(res.status).toBe(400)
  })
})
