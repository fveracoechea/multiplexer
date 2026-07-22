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
 * transport across requests). `createServer` mints that per-request server.
 */
export async function startHttpServer(
  createServer: () => McpServer,
  options: ServeOptions = {},
): Promise<HttpServer> {
  const path = options.path ?? "/mcp";

  const bun = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== path) {
        return new Response("Not found", { status: 404 });
      }

      const server = createServer();
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
