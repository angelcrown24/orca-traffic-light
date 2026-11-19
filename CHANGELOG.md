# Release history

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
