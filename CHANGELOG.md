# Release history

## [v0.11.2](https://github.com/angelcrown24/orca-traffic-light/releases/tag/v0.11.2) · Show tool names under each working chat

- Session activity displays named live tools, including reads, searches, edits, shell calls and identified MCP tools. Concurrent calls to the same read or edit tool share a count under their owner.
- A working chat keeps recently used tool names visible between calls. Repeated uses show their count, and selecting a tool shows its latest outcome.
- The workspace resource section is now labeled **Skills, plugins & MCP**. The selected chat’s tool tree remains above it.

## [v0.11.1](https://github.com/angelcrown24/orca-traffic-light/releases/tag/v0.11.1) · Keep working chats visible between calls

- Session activity shows the main agent as **Working** while it continues its turn, including Antigravity chats between tool calls.
- An open chat turn can show cumulative tool calls, commands and change records. A running file-edit call has its own row and clears when the edit finishes.

## [v0.11.0](https://github.com/angelcrown24/orca-traffic-light/releases/tag/v0.11.0) · See delegated work as a tree

- Session activity opens with the selected chat or terminal at the root. Parallel agents, nested agents and running commands appear under their reported owners.
- Branches expand and collapse in place. Working and monitoring states remain visible in the English and Korean sidebar.
- The illustrated Activity guide shows parallel agents and nested work, plus a separate example of the direct child status available from Antigravity.

## [v0.10.1](https://github.com/angelcrown24/orca-traffic-light/releases/tag/v0.10.1) · Clearer activity and more reliable shared tools

- Activity puts resources in use first, pages longer lists and shows a single empty state. A manually selected session that closes prompts you to choose another.
- Native tool history checks the workspace that owns each journal. A finished parent’s tool badge clears while its delegated work can stay visible. Reused call IDs from different terminal agents retain separate histories.
- Importing one provider’s copy keeps the other variants visible. Library search and source reviews survive terminal updates in the same workspace. The diagram counts registered copies that are awaiting an update or conflict review.
- The shared runner handles MCP server pings and tool-list changes on stdio and open HTTP response streams. Skill reads deliver the same content that passed verification.

## [v0.10.0](https://github.com/angelcrown24/orca-traffic-light/releases/tag/v0.10.0) · Watch the selected session

- **Session activity** brings running shell calls, background commands and active subagents together. On macOS it follows the selected local chat or split terminal when Orca reports its identity. You can also choose a session manually.
- A live terminal shows **Connected**. Completed agents and idle children leave the session view.
- **Recent tool calls** shows the latest 30 calls across the workspace. **Clear list** hides earlier entries across panel reloads while jobs continue running.
- The English and Korean panels and the illustrated README cover the new session view.

## [v0.9.0](https://github.com/angelcrown24/orca-traffic-light/releases/tag/v0.9.0) · Follow delegated work in Antigravity chats

- A new opt-in setting on macOS reads child status and its report time from the local Antigravity CLI index. This covers native Gemini chats running through Antigravity, including delegated work that continues after the parent replies.
- Agent activity shows the last observed subagent call beneath its parent when child status is unavailable.
- Live child agents can appear from either roster format Orca supplies. Monitoring has its own status, and background commands are excluded from the subagent count.

## [v0.8.0](https://github.com/angelcrown24/orca-traffic-light/releases/tag/v0.8.0) · Review provider-specific sources before import

- Import identifies recognized provider requirements and explains which part the shared runner cannot reproduce.
- Copy a request for a target agent to build and test a compatible alternative. The request is available in English and Korean.
- When several providers have the same item, the import decision applies to the individual source. Compatible copies remain available.

## [v0.7.2](https://github.com/angelcrown24/orca-traffic-light/releases/tag/v0.7.2) · English fallback and visual setup guide

- Activity, Library and How it works follow Orca's language. Korean locales use Korean. English, other languages and an unspecified locale use English.
- The [README](README.md) walks through installation and the first workspace connection, with English screenshots of all three tabs.

## [v0.7.1](https://github.com/angelcrown24/orca-traffic-light/releases/tag/v0.7.1) · Inline Jev badges

Jev attribution moved onto the existing skill, MCP server and tool call rows. A running item can show both **Jev** and **In use**. Suggestions alone add no rows.

## [v0.7.0](https://github.com/angelcrown24/orca-traffic-light/releases/tag/v0.7.0) · Cross-provider activity

Native chat monitoring recognizes both Orca session ID formats used by Codex, Claude and Antigravity. Each sampled chat gets a place in recent calls. The shared runner links Jev recommendations to observed skill reads and MCP calls in the same conversation.

## [v0.6.0](https://github.com/angelcrown24/orca-traffic-light/releases/tag/v0.6.0) · Grouped imports and recommendations

The Library groups import candidates by name and type. Compare provider copies, choose a source and request a skill recommendation from a short task description.

## [v0.5.1](https://github.com/angelcrown24/orca-traffic-light/releases/tag/v0.5.1) · Library navigation

Search, filters and selection actions share one compact list. Expand an entry to inspect its source and sharing options.

## [v0.5.0](https://github.com/angelcrown24/orca-traffic-light/releases/tag/v0.5.0) · Workspace connections and synchronization

Shell-capable agents can use the workspace selection via shared instructions and a per-conversation handle. Import provider skills and MCP references into a shared store and inspect the counts in **How it works**.

## [v0.4.0](https://github.com/angelcrown24/orca-traffic-light/releases/tag/v0.4.0) · On-demand shared tools

Added the Library and a local runner that reads selected skills and connects to selected MCP servers on demand. Introduced English and Korean tab labels.

## Earlier tags

| Version | Change |
| --- | --- |
| [v0.3.4](https://github.com/angelcrown24/orca-traffic-light/tree/v0.3.4) | Show live subagents and MCP activity. |
| [v0.3.3](https://github.com/angelcrown24/orca-traffic-light/tree/v0.3.3) | Mark resources observed during active agent turns. |
| [v0.3.2](https://github.com/angelcrown24/orca-traffic-light/tree/v0.3.2) | Simplify detected resource labels. |
| [v0.3.1](https://github.com/angelcrown24/orca-traffic-light/tree/v0.3.1) | Improve the Activity panel layout. |
| [v0.3.0](https://github.com/angelcrown24/orca-traffic-light/tree/v0.3.0) | Recognize skills, plugins and MCP activity. |
| [v0.2.0](https://github.com/angelcrown24/orca-traffic-light/tree/v0.2.0) | Add native chat and cross-agent monitoring. |
| [v0.1.0](https://github.com/angelcrown24/orca-traffic-light/tree/v0.1.0) | First release of the terminal activity panel. |
