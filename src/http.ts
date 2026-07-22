import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export interface HttpServer {
  /** The base URL the server is listening on, e.g. http://localhost:4123. */
  readonly url: string;
  /** The MCP endpoint URL crew CLIs connect to, e.g. http://localhost:4123/mcp. */
  readonly mcpUrl: string;
  /** Stop listening and release the port. */
  close(): Promise<void>;
}

export interface ServeOptions {
  /** Port to bind; 0 picks an ephemeral free port (used in tests). */
  readonly port?: number;
  /** Path the MCP endpoint is served under. */
  readonly path?: string;
}

/**
 * Serve the mux MCP tool surface over streamable-HTTP on localhost using
 * web-standard `Request`/`Response`, wired to `Bun.serve`.
 *
 * Runs in stateless mode: shared server-owned state lives in the DB and other
 * injected dependencies, not in the MCP session, so each HTTP request is served
 * by a fresh `McpServer` + transport (the SDK forbids reusing a stateless
 * transport across requests). `createServer` mints that per-request server,
 * receiving the crew identity parsed from the connection URL (ADR-0001):
 * `/mcp` is the orchestrator's session connection, `/mcp/<crewName>` is a crew.
 */
export async function startHttpServer(
  createServer: (connectedCrew?: string) => McpServer,
  options: ServeOptions = {},
): Promise<HttpServer> {
  const path = options.path ?? "/mcp";

  const bun = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const connectedCrew = parseConnectedCrew(url.pathname, path);
      if (connectedCrew === null) {
        return new Response("Not found", { status: 404 });
      }

      const server = createServer(connectedCrew || undefined);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      await transport.close();
      await server.close();
      return response;
    },
  });

  const url = `http://localhost:${bun.port}`;
  return {
    url,
    mcpUrl: `${url}${path}`,
    async close() {
      await bun.stop(true);
    },
  };
}

/**
 * Resolve the connected crew from the request path (ADR-0001):
 *  - `<path>`             -> `""`   (orchestrator, session-scoped connection)
 *  - `<path>/<crewName>`  -> crew name
 *  - anything else        -> `null` (404)
 */
function parseConnectedCrew(pathname: string, path: string): string | null {
  if (pathname === path) {
    return "";
  }
  const prefix = `${path}/`;
  if (pathname.startsWith(prefix)) {
    const crewName = pathname.slice(prefix.length);
    return crewName.includes("/") ? null : decodeURIComponent(crewName);
  }
  return null;
}
