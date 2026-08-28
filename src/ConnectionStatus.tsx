import { useEffect, useState } from 'react'
import { ping, type PingResult } from './api/clickhouse'
import './ConnectionStatus.css'

type State =
  | { status: 'loading' }
  | { status: 'connected'; info: PingResult }
  | { status: 'error'; message: string }

export function ConnectionStatus() {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false

    ping()
      .then((info) => {
        if (!cancelled) setState({ status: 'connected', info })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="ch-card">
      <h1>ClickHouse</h1>

      {state.status === 'loading' && (
        <p className="ch-status ch-status--pending">Connecting…</p>
      )}

      {state.status === 'connected' && (
        <>
          <p className="ch-status ch-status--ok">Connected</p>
          <dl className="ch-details">
            <dt>Server version</dt>
            <dd>{state.info.version}</dd>
            <dt>Database</dt>
            <dd>{state.info.database}</dd>
          </dl>
        </>
      )}

      {state.status === 'error' && (
        <>
          <p className="ch-status ch-status--error">Not connected</p>
          <pre className="ch-error">{state.message}</pre>
        </>
      )}
    </section>
  )
}
