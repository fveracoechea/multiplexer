# The session key is carried in the MCP connection URL

The mux MCP server is a singleton: one process serves every project session
concurrently. Each project session's crew, assignments, and events must be
isolated by a session key stamped on every DB row and every tmux target. The
question is how the server learns which session key a given connection belongs
to.

We carry the session key in the connection URL path, extending ADR-0001's
per-crew path:

- `/mcp/<sessionKey>` - an orchestrator connection for that session
- `/mcp/<sessionKey>/<crewName>` - a crew connection for that session

The alternative - deriving the session key from the server's own PWD or an
environment variable - was rejected because a single shared server has one PWD
and one env, yet must serve many sessions at once. A per-connection mechanism
is required, and the URL path is the one the MCP HTTP transport already gives
us for free. The session key is chosen by the bootstrap from the user's
project directory name and baked into the MCP URL the Orchestrator and crew
agents are wired to at spawn time.

This extends ADR-0001 (crew identity bound to the connection) to carry the
session key the same way: both are chosen by the server at spawn time and
fixed to the connection, so neither can be spoofed by the agent's own output.
