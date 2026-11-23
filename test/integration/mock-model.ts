/**
 * Mock model server for the integration tests: a loopback HTTP server that records each request and answers through a
 * handler. The mock provider fixture (`test/fixtures/mock-provider`) points OpenCode at it.
 */

export interface RecordedRequest {
  method: string
  path: string
  /** Lower-case header names. */
  headers: Record<string, string>
  body: any
}

export interface MockModel {
  /** Base URL that includes `/v1`. */
  readonly url: string
  readonly port: number
  /** All requests, in order. */
  readonly requests: RecordedRequest[]
  stop(): void
}

export interface MockModelInput {
  /** Handler for each request. Return `undefined` for 404. */
  handler: (request: RecordedRequest, raw: Request) => Response | Promise<Response> | undefined
}

export function startMockModel(input: MockModelInput): MockModel {
  const requests: RecordedRequest[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(raw) {
      const url = new URL(raw.url)
      const headers: Record<string, string> = {}
      raw.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
      let body: any
      if (raw.method !== "GET" && raw.method !== "HEAD") {
        const text = await raw.text()
        try {
          body = text === "" ? undefined : JSON.parse(text)
        } catch {
          body = text
        }
      }
      const recorded: RecordedRequest = { method: raw.method, path: url.pathname, headers, body }
      requests.push(recorded)
      const response = await input.handler(recorded, raw)
      return response ?? new Response("not found", { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    port: server.port ?? 0,
    requests,
    stop: () => void server.stop(true),
  }
}
