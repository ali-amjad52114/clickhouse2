/**
 * Connectivity check: node --env-file=.env scripts/check-connection.ts
 */
import { clickhouseConfig, closeClient, getClient } from '../server/clickhouse.ts'

const { url, username, database } = clickhouseConfig()
console.log(`Connecting to ${url} as ${username} (database: ${database})`)

try {
  const rows = await getClient().query({
    query: 'SELECT version() AS version, uptime() AS uptime_seconds, now() AS server_time',
    format: 'JSONEachRow',
  })
  const [info] = await rows.json<Record<string, string>>()
  console.log('Connected.')
  console.table(info)
} catch (error) {
  console.error('Connection failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await closeClient()
}
