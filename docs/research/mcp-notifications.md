# Can server-initiated MCP notifications become a model-visible turn?

**Research ticket:** wayfinder #2
**Question:** Can server-initiated MCP notifications become a MODEL-VISIBLE turn (something the LLM actually reasons about / acts on) in Claude Code or opencode, or do they only update the client application's UI / state / logs?
**Date:** 2026-07-20
**Sources:** Primary only - the MCP specification (modelcontextprotocol.io), Claude Code docs (code.claude.com/docs), opencode docs (opencode.ai/docs) and opencode source (github.com/sst/opencode).

---

## Bottom-line verdict

The pull-based assumption **holds for the five standard MCP server->client notification types** named in the ticket (`notifications/progress`, `notifications/message`, `notifications/resources/updated`, `notifications/resources/list_changed`, `notifications/tools/list_changed`). In both Claude Code and opencode, none of these are surfaced to the model as a new turn/event. They update the client app: logs, the tool/resource catalog, or UI. The model only sees MCP content when it (or the user) explicitly pulls it - i.e. by calling a tool and reading the result, or by referencing a resource/prompt.

**However, the blanket assumption ("no unprompted push into the LLM, ever") is FALSE for Claude Code.** Claude Code ships a proprietary extension - **Channels** (research preview) - that uses a *non-standard* notification method, `notifications/claude/channel`, transported over MCP but defined by Claude Code, not the MCP spec. A Channels notification is injected into the model's context as a `<channel>` tag and Claude acts on it as a new turn. This is a genuine server-initiated push into the model's reasoning loop. It is gated (research preview, allowlist, org policy, `--channels` opt-in) and it only works **while a session is open** - it cannot wake a closed/idle process - but within a running session it is exactly the reactive path the ticket asks about.

opencode has **no** equivalent MCP-notification-to-model path. Its only reactive "start a turn from outside" mechanism is its own HTTP server/SDK (`POST /session/:id/prompt_async` + SSE event bus), which is orthogonal to MCP.

**Implication for an orchestrator:** If you restrict yourself to standard MCP notifications, an orchestrator agent must be **pull-based** - a server cannot push a notification that the model reasons about. Reactivity is only achievable through host-specific extensions (Claude Code Channels) or a host's own API (opencode server/SDK), and even then only while the agent process is alive.

---

## 1. Per-notification-type: does it reach the model, or only the app/UI/logs?

### MCP spec: what these notifications are *for*

The spec defines the wire semantics but explicitly leaves the interaction model - including whether/how a notification reaches an LLM - to the host implementation.

| Notification | Purpose per spec | Payload | Source |
|---|---|---|---|
| `notifications/progress` | Progress updates for a long-running operation, scoped to a request's `progressToken`. "Either side can send progress notifications to provide updates about operation status." | `progressToken`, increasing `progress` | [progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress) |
| `notifications/message` | Server sends structured log messages to clients; verbosity gated by client via `logging/setLevel`. "servers sending notifications containing severity levels..." | level, logger, data | [logging](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging) |
| `notifications/resources/updated` | Sent to a client that has `resources/subscribe`d to a URI, when that resource changes. | `uri` only | [resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources) |
| `notifications/resources/list_changed` | Param-less cache-invalidation signal: the set of resources changed; client should re-`resources/list`. Gated on `resources.listChanged`. | none | [resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources) |
| `notifications/tools/list_changed` | Param-less signal: the set of tools changed; client should re-`tools/list`. Gated on `tools.listChanged`. | none | [tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) |

Crucially, the spec does **not** define how a client feeds any of these into an LLM. It repeatedly declines to: "the protocol itself does not mandate any specific user interaction model" (stated on the logging, resources, tools and prompts pages). Resources are "application-driven, with host applications determining how to incorporate context based on their needs" ([resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)). The architecture page assigns "context aggregation" and "AI/LLM integration" to the host as responsibilities but gives no normative rules for turning a notification into model context ([architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture)). So whether any notification reaches the model is entirely a client decision.

### Claude Code

| Notification | Reaches model? | What actually happens | Source |
|---|---|---|---|
| `notifications/tools/list_changed` (also resources/prompts list_changed) | No | Claude Code "automatically refreshes the available capabilities from that server" - internal catalog refresh, not a model turn. The model only sees the updated capability list on its next turn if it uses them. | [mcp](https://code.claude.com/docs/en/mcp) |
| `notifications/message` (logging) | Not documented as reaching the model | Docs are silent on surfacing server logs to the model; treat as app/log-level. | (silent - see note) |
| `notifications/resources/updated` / `resources/subscribe` | Not documented | Docs describe resources as `@`-mention pull ("reference using @ mentions... Type `@` in your prompt to see available resources"). No documented autonomous push of resource updates to the model. | [mcp](https://code.claude.com/docs/en/mcp) |
| `notifications/progress` | Not documented as a model turn | No documentation that progress becomes model-visible; consistent with spec (progress is a UI/status concern). | (silent - see note) |
| **`notifications/claude/channel` (NON-standard, Claude Code extension)** | **Yes** | Injected into the model context as `<channel source="...">...</channel>`; "Claude reads the event and replies", "Claude start[s] responding: reading files, running commands." | [channels-reference](https://code.claude.com/docs/en/channels-reference), [channels](https://code.claude.com/docs/en/channels) |

Note on "silent": Where marked, the Claude Code docs do not state that the notification is surfaced to the model. Absence of documentation is not proof it is never surfaced, but there is no primary evidence that these standard notifications become model turns; the only documented model-facing push path is Channels.

The Channels distinction is essential: the docs are explicit that a **standard** MCP server is pull-only - "Standard MCP server ... Claude queries it during a task; nothing is pushed to the session" ([channels](https://code.claude.com/docs/en/channels), "How channels compare" table). Channels are described as filling exactly that gap: "Channels fill the gap ... by pushing events ... into your already-running local session." And Channels ride a Claude Code-specific method, not a spec method: a channel server must "Declare the `claude/channel` capability" and "Emit `notifications/claude/channel` events"; the reference notes "the transport is standard MCP but the method and schema are Claude Code extensions" ([channels-reference](https://code.claude.com/docs/en/channels-reference)).

### opencode

opencode's docs frame MCP purely as a way to add **tools**: "Add local and remote MCP tools", "MCP tools are automatically available to the LLM alongside built-in tools" ([mcp-servers](https://opencode.ai/docs/mcp-servers/)). The docs do not mention notifications, progress, logging, resources, or list_changed at all.

Source code ([packages/opencode/src/mcp/index.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/mcp/index.ts), [catalog.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/mcp/catalog.ts) on the `dev` branch) confirms which notifications are handled and where they go:

| Notification | Reaches model? | What actually happens (source) |
|---|---|---|
| `notifications/message` (logging) | No | Handler routes to `Effect.logDebug/logInfo/...` tagged "MCP server log" - opencode's own log output only. |
| `notifications/tools/list_changed` | No | Handler re-fetches tool defs, updates the cached catalog, and publishes an internal `ToolsChanged` bus event. Refreshes catalog/UI; no model turn. |
| `notifications/progress` | No | `onprogress` is a **no-op** attached only so the SDK sends a progress token to reset the request timeout. Surfaced nowhere. |
| `notifications/resources/updated`, `resources/list_changed` | No | **No handler registered at all.** |

The only inbound server-initiated paths in opencode terminate in logs, catalog refresh, or connection-close - none re-enters the model loop. The model sees MCP content only as **results of a tool the model itself called** (`client.callTool` in `catalog.ts`) or as prompts/resources pulled in on demand.

---

## 2. Do progress notifications require an outstanding request (so they cannot reach an idle client)?

**Yes.** The spec's "Behavior Requirements" for Progress state verbatim:

> "Progress notifications MUST only reference tokens that: were provided in an active request; are associated with an in-progress operation." ([progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress))

and "Progress notifications MUST stop after completion." A `progressToken` only exists because the receiver placed it in the `_meta` of a request it is currently waiting on. There is no spec mechanism for an unsolicited progress notification, so a progress notification **cannot reach an idle client with no pending request**. (The 2025-11-25 task-augmented-request extension keeps the token valid for a task's lifetime but does not change this - it is still tied to an originating request.)

This reinforces the verdict: progress is the *least* capable of the notifications for reactivity - it is definitionally bound to an in-flight request, so it can never be the trigger for a new, unprompted model turn.

---

## 3. Is there a resource-subscription, elicitation, or sampling path that lets a server prompt the model unprompted?

### Resource subscriptions
No. `resources/subscribe` + `notifications/resources/updated` is defined by the spec only as a signal that the client *may* re-`resources/read`; the message-flow diagram shows update -> client re-reads. The spec defines **no** obligation to push updated contents into an LLM ([resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)). Neither Claude Code (resources are `@`-mention pull) nor opencode (no `resources/updated` handler at all) turns a resource update into a model turn.

### Sampling (`sampling/createMessage`)
This is the spec feature that most looks like "server drives the model": "servers to request LLM sampling ... from language models via clients", enabling "servers to implement agentic behaviors ... nested inside other MCP server features" ([sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)). **But:**
- It is a **request nested inside a server operation the client already initiated** (e.g. during a tool call), not an unsolicited wake-up of an idle client.
- The spec requires human-in-the-loop: "there SHOULD always be a human in the loop with the ability to deny sampling requests" ([sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)).
- **Claude Code does not support sampling** - it is an open feature request, not implemented ([anthropics/claude-code#1785](https://github.com/anthropics/claude-code/issues/1785)); the MCP docs page makes no mention of sampling.
- **opencode does not support sampling** - the `sampling: {}` client capability is **commented out / disabled** in `CLIENT_OPTIONS` ([index.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/mcp/index.ts)), so it never advertises sampling and will not service `sampling/createMessage`.

### Elicitation (`elicitation/create`)
Server-initiated request for **user** input, routed through the client with mandatory user control ("clients MUST provide UI ... respect user privacy and provide clear decline and cancel options") ([elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)). It targets the human, not the model's autonomous reasoning, and like sampling it is nested inside an existing server operation, not an idle-client wake-up. opencode has `elicitation: {}` **commented out / disabled** ([index.ts](https://github.com/sst/opencode/blob/dev/packages/opencode/src/mcp/index.ts)); Claude Code docs do not document elicitation-driven model turns.

### The one real "prompt the model unprompted" path
Claude Code **Channels** (`notifications/claude/channel`) - covered in section 1. It is the only verified path where a server-initiated message becomes a model-visible turn. It is a Claude Code extension, not MCP-spec sampling/elicitation/subscription, and it only works within a live session:

> "Events only arrive while the session is open, so for an always-on setup you run Claude in a background process or persistent terminal." ([channels](https://code.claude.com/docs/en/channels))

> "Notifications are not acknowledged ... If the session hasn't loaded your server as a channel, or the organization policy blocks it, events are dropped silently." ([channels-reference](https://code.claude.com/docs/en/channels-reference))

> "Events queue into the session and are processed in order. If several notifications arrive while Claude is busy, they're delivered together on the next turn and Claude handles them as a group." ([channels-reference](https://code.claude.com/docs/en/channels-reference))

---

## Claims that could NOT be fully verified from primary sources

- **Claude Code handling of `notifications/message` (server logs) and `notifications/progress`:** the docs do not explicitly state whether these are surfaced to the model or only to logs/UI. There is no primary evidence they become model turns, and the "standard MCP server ... nothing is pushed" statement plus the existence of Channels as the dedicated push path strongly imply they do not - but the docs are silent on the exact routing, so this is inference, not a documented statement.
- **opencode:** the MCP-internals findings (which notifications are handled and where they go) come from **source code on the `dev` branch**, not from opencode's docs, which are silent on notifications entirely. Source is authoritative for behavior but may change; the disabled sampling/elicitation capabilities are commented out in current source and could be enabled later.
- **MCP `list_changed` wording** for tools/prompts was captured from the 2025-06-18 spec pages; the language is carried forward unchanged into the current 2025-11-25 spec (current version per [versioning](https://modelcontextprotocol.io/specification/versioning)).

---

## Sources

MCP specification (modelcontextprotocol.io):
- Progress: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress
- Logging (`notifications/message`): https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging
- Resources (subscribe / updated / list_changed): https://modelcontextprotocol.io/specification/2025-11-25/server/resources
- Tools (`tools/list_changed`): https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- Prompts (`prompts/list_changed`): https://modelcontextprotocol.io/specification/2025-06-18/server/prompts
- Sampling: https://modelcontextprotocol.io/specification/2025-11-25/client/sampling
- Elicitation: https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- Architecture: https://modelcontextprotocol.io/specification/2025-06-18/architecture
- Versioning: https://modelcontextprotocol.io/specification/versioning

Claude Code (code.claude.com/docs):
- MCP: https://code.claude.com/docs/en/mcp
- Channels: https://code.claude.com/docs/en/channels
- Channels reference: https://code.claude.com/docs/en/channels-reference
- Sampling feature request (not implemented): https://github.com/anthropics/claude-code/issues/1785

opencode:
- MCP servers docs: https://opencode.ai/docs/mcp-servers/
- Server/SDK docs: https://opencode.ai/docs/server/
- MCP client source: https://github.com/sst/opencode/blob/dev/packages/opencode/src/mcp/index.ts
- MCP catalog source: https://github.com/sst/opencode/blob/dev/packages/opencode/src/mcp/catalog.ts
