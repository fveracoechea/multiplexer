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

/** A parsed MCP connection: the session key and, for a crew connection, the crew name. */
export interface ParsedConnection {
  /** Project/session isolation key, carried in the URL (ADR-0002). */
  readonly sessionKey: string;
  /** Crew name for a crew connection; undefined for the orchestrator. */
  readonly crewName?: string;
}

/**
 * Serve the multiplexer MCP tool surface over streamable-HTTP on localhost using
 * web-standard `Request`/`Response`, wired to `Bun.serve`.
 *
 * Runs in stateless mode: shared server-owned state lives in the DB and other
 * injected dependencies, not in the MCP session, so each HTTP request is served
 * by a fresh `McpServer` + transport (the SDK forbids reusing a stateless
 * transport across requests). `createServer` mints that per-request server,
 * receiving the session key and crew identity parsed from the connection URL
 * (ADR-0001, ADR-0002): `/mcp/<sessionKey>` is an orchestrator connection,
 * `/mcp/<sessionKey>/<crewName>` is a crew connection. The session key is
 * carried in the URL so a single shared server serves every project session
 * concurrently, each isolated by its own key (spec #22).
 */
export async function startHttpServer(
  createServer: (connection: ParsedConnection) => McpServer,
  options: ServeOptions = {},
): Promise<HttpServer> {
  const path = options.path ?? "/mcp";

  const bun = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const connection = parseConnection(url.pathname, path);
      if (connection === null) {
        return new Response("Not found", { status: 404 });
      }

      const server = createServer(connection);
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
 * Resolve the connection from the request path (ADR-0001, ADR-0002):
 *  - `<path>/<sessionKey>`            -> orchestrator for that session
 *  - `<path>/<sessionKey>/<crewName>` -> crew for that session
 *  - anything else                    -> `null` (404)
 *
 * The session key is carried in the URL so the shared server can attribute
 * every row to the right project session without per-connection env vars.
 */
export function parseConnection(pathname: string, path: string): ParsedConnection | null {
  const prefix = `${path}/`;
  if (!pathname.startsWith(prefix)) return null;

  const rest = pathname.slice(prefix.length);
  if (rest.length === 0) return null;

  const slash = rest.indexOf("/");
  if (slash === -1) {
    return { sessionKey: decodeURIComponent(rest) };
  }

  const sessionKey = rest.slice(0, slash);
  const crewName = rest.slice(slash + 1);
  // Crew names can't contain a slash (a nested path would be a 404).
  if (crewName.length === 0 || crewName.includes("/")) return null;
  return { sessionKey: decodeURIComponent(sessionKey), crewName: decodeURIComponent(crewName) };
}
