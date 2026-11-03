export function splitCents(totalCents: number, memberCount: number): number[] {
  if (!Number.isSafeInteger(memberCount) || memberCount <= 0) {
    throw new Error('memberCount must be a positive whole number')
  }

  const base = Math.floor(totalCents / memberCount)
  const remainder = totalCents % memberCount

  return Array.from({ length: memberCount }, (_, index) => (index < remainder ? base + 1 : base))
}
