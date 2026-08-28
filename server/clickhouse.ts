import { createClient, type ClickHouseClient } from '@clickhouse/client'

export type Env = Record<string, string | undefined>

/**
 * Builds the ClickHouse connection URL and credentials from environment
 * variables. This module is server-only — it must never be imported from
 * anything under `src/`, or the password would be bundled into the browser.
 */
export function clickhouseConfig(env: Env = process.env) {
  const host = env.CLICKHOUSE_HOST
  const password = env.CLICKHOUSE_PASSWORD

  if (!host) throw new Error('CLICKHOUSE_HOST is not set (see .env.example)')
  if (password === undefined) {
    throw new Error('CLICKHOUSE_PASSWORD is not set (see .env.example)')
  }

  const secure = env.CLICKHOUSE_SECURE !== 'false'
  const port = env.CLICKHOUSE_PORT ?? (secure ? '8443' : '8123')

  return {
    url: `${secure ? 'https' : 'http'}://${host}:${port}`,
    username: env.CLICKHOUSE_USER ?? 'default',
    password,
    database: env.CLICKHOUSE_DATABASE ?? 'default',
  }
}

let client: ClickHouseClient | undefined

/** Lazily creates a singleton client — the connection pool is reused. */
export function getClient(env: Env = process.env): ClickHouseClient {
  if (!client) {
    client = createClient({
      ...clickhouseConfig(env),
      // ClickHouse Cloud idles services; give the first query room to wake one.
      request_timeout: 30_000,
    })
  }
  return client
}

export async function closeClient() {
  await client?.close()
  client = undefined
}
