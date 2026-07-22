# Crew identity is bound to the MCP connection, not passed as a tool argument

The crew-facing `report(summary, status, reportPath?, prUrl?)` tool carries no
crew name, yet the server must attribute each report to the right crew's current
assignment. We bind crew identity to the MCP connection: each crew agent is
launched wired to a per-crew endpoint URL (`.../mcp/<crewName>`), and the server
reads the caller's identity from that connection rather than from a tool
argument.

The alternative - adding a `name` parameter to `report` - was rejected because
it would let a crew agent claim to be another crew, violating the guardrail that
crew must never impersonate one another (spec #11). Identity chosen by the server
at spawn time and fixed to the connection cannot be spoofed by the agent's own
output. The orchestrator connects to the plain session endpoint (`.../mcp`) and
so is never mistaken for a crew.
