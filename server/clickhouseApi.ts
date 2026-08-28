import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { getClient, type Env } from './clickhouse.ts'

const MAX_BODY_BYTES = 100_000

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(json)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

/**
 * Dev-server API that keeps ClickHouse credentials on the Node side.
 * The browser calls these endpoints; it never sees the password.
 *
 * Queries run with `readonly: 1`, so this endpoint cannot be used to modify
 * data even though it accepts arbitrary SQL. It is bound to the Vite dev
 * server only — a production deployment needs its own backend.
 */
export function clickhouseApi(env: Env): Plugin {
  return {
    name: 'clickhouse-api',
    configureServer(server) {
      server.middlewares.use('/api/clickhouse', async (req, res, next) => {
        const route = (req.url ?? '/').split('?')[0]

        try {
          if (route === '/ping' && req.method === 'GET') {
            const rows = await getClient(env).query({
              query: 'SELECT version() AS version, currentDatabase() AS database',
              format: 'JSONEachRow',
            })
            const [info] = await rows.json<{ version: string; database: string }>()
            return send(res, 200, { ok: true, ...info })
          }

          if (route === '/query' && req.method === 'POST') {
            const body = (await readJsonBody(req)) as {
              sql?: unknown
              params?: Record<string, unknown>
            }
            if (typeof body.sql !== 'string' || !body.sql.trim()) {
              return send(res, 400, { ok: false, error: 'Missing "sql" string' })
            }

            const rows = await getClient(env).query({
              query: body.sql,
              query_params: body.params,
              format: 'JSONEachRow',
              clickhouse_settings: { readonly: '1' },
            })
            return send(res, 200, { ok: true, rows: await rows.json() })
          }

          return next()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return send(res, 500, { ok: false, error: message })
        }
      })
    },
  }
}
