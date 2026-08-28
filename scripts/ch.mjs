#!/usr/bin/env node
// Reusable ClickHouse query runner.
//   node scripts/ch.mjs "SELECT 1"
//   node scripts/ch.mjs "SELECT ..." --format=JSON|Pretty|CSV|TSV
//   echo "SELECT 1" | node scripts/ch.mjs
// Credentials come from .env (never passed on the command line).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createClient } from '@clickhouse/client'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const {
  CLICKHOUSE_HOST, CLICKHOUSE_PORT = '8443', CLICKHOUSE_USER = 'default',
  CLICKHOUSE_PASSWORD = '', CLICKHOUSE_DATABASE = 'default', CLICKHOUSE_SECURE = 'true',
} = process.env

export const client = createClient({
  url: `${CLICKHOUSE_SECURE === 'true' ? 'https' : 'http'}://${CLICKHOUSE_HOST}:${CLICKHOUSE_PORT}`,
  username: CLICKHOUSE_USER,
  password: CLICKHOUSE_PASSWORD,
  database: CLICKHOUSE_DATABASE,
})

const args = process.argv.slice(2)
const formatArg = args.find((a) => a.startsWith('--format='))
const sql = args.filter((a) => !a.startsWith('--')).join(' ').trim()
  || readFileSync(0, 'utf8').trim()

if (!sql) {
  console.error('usage: node scripts/ch.mjs "<SQL>" [--format=JSONEachRow|Pretty|CSV|TSV]')
  process.exit(2)
}

const format = formatArg ? formatArg.split('=')[1] : 'Pretty'
const isSelect = /^\s*(select|show|describe|desc|explain|with|exists)\b/i.test(sql)

try {
  if (isSelect) {
    const rs = await client.query({ query: sql, format })
    process.stdout.write(await rs.text())
  } else {
    await client.command({ query: sql })
    console.log('OK')
  }
} catch (err) {
  console.error(`ClickHouse error: ${err.message}`)
  process.exitCode = 1
} finally {
  await client.close()
}
