/**
 * Browser-side helpers. These talk to the dev-server API in `server/`, which
 * holds the credentials — no ClickHouse secrets exist in this file's bundle.
 */

export interface PingResult {
  version: string
  database: string
}

interface ApiFailure {
  ok: false
  error: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/clickhouse${path}`, init)
  const body = (await res.json()) as ({ ok: true } & T) | ApiFailure

  if (!body.ok) throw new Error(body.error)
  return body
}

export function ping(): Promise<PingResult> {
  return request<PingResult>('/ping')
}

export function query<Row = Record<string, unknown>>(
  sql: string,
  params?: Record<string, unknown>,
): Promise<{ rows: Row[] }> {
  return request<{ rows: Row[] }>('/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  })
}
