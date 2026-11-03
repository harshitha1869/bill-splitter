export interface Share {
  id: string
  memberId: string
  amountCents: number
  paidAt: string | null
}

export interface Bill {
  id: string
  homeId: string
  title: string
  totalCents: number
  shares: Share[]
}

export interface Balance {
  memberId: string
  name: string
  outstandingCents: number
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const TIMEOUT_MS = 8000

function readError(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const { error } = data as { error?: unknown }
  return typeof error === 'string' ? error : null
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`/api${path}`, { ...init, signal: controller.signal })
    const data: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      throw new ApiError(readError(data) ?? `Request failed (${response.status})`, response.status)
    }
    return data as T
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('The server took too long to respond', 0)
    }
    throw new ApiError('Cannot reach the server', 0)
  } finally {
    clearTimeout(timer)
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong'
}
