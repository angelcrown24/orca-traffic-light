# Traffic Light technical reference

For installation and a walkthrough of the sidebar, see the [README](../README.md).

To install a local checkout for development, run `orca plugin install /absolute/path/to/orca-traffic-light` and follow Orca’s approval prompt.

## Discovery and import

Traffic Light scans local user configuration. Each provider badge identifies where the entry was found. A successful connection is recorded separately when a tool is used.

| Source | Skill locations | MCP configuration |
| --- | --- | --- |
| Shared | `~/.agents/skills` | Private shared registry with references to the original provider configuration |
| Codex | `~/.codex/skills`, including `.system` | `~/.codex/config.toml` |
| Claude Code | `~/.claude/skills` | `~/.claude.json` |
| Gemini CLI | `~/.gemini/skills` | `~/.gemini/settings.json` |
| Antigravity | `~/.gemini/config/skills`, `~/.gemini/antigravity/skills` | `~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity/mcp_config.json` |

Discovery deduplicates canonical skill paths and equivalent MCP configurations. The importer groups entries by type and name and lets you compare source differences before choosing. Commands, URLs, environment values, and credentials stay out of the panel. The skill scan skips instruction files larger than 64 KiB and applies traversal limits. It covers local user directories. Project-specific MCP settings, provider plugin caches, and remote hosts fall outside this scan.

### Before importing a provider-specific source

Traffic Light checks the selected source for recognized runtime dependencies and restrictions. A skill might request a provider’s hooks or require explicit invocation. An MCP server might rely on provider-managed authentication, per-tool access rules or a transport the shared runner cannot use. In a group with several sources, each copy is assessed individually. The provider shown on an entry identifies where it was discovered.

**Copy adaptation request** prepares an English or Korean handoff for the agent that will implement the alternative. It identifies the selected source and explains the limitation. Copying is a clipboard action. You choose the receiving conversation and paste the request yourself. The receiving agent needs to inspect the original declarations, preserve the permissions and invocation rules, and try a representative operation in the target environment. Compatibility remains unverified until tested. The importer can recognize declared constraints, but it cannot determine every dependency embedded in prose, scripts or external services.

### Skill packages

Importing a skill copies its supporting files into a versioned shared snapshot. The path `~/.agents/skills/<name>` points to the current shared version. Missing provider entries can link to it. Existing provider packages and earlier snapshots are preserved. A change in the source appears as an update for explicit synchronization. The importer reports conflicting destinations for review.

Check the skill’s declared requirements against the software and tools available to the consuming agent. Packages with recognized provider-specific controls stay with their native provider. Examples include Claude hooks, forked context, `disable-model-invocation`, and Codex’s explicit-only policy in `agents/openai.yaml`. The importer can check package declarations. Provider policy, local dependencies, and requirements described in free text still depend on the environment. [Agent Skills specification](https://agentskills.io/specification) · [Claude Code skills](https://code.claude.com/docs/en/skills) · [Codex skills](https://developers.openai.com/codex/skills/)

### MCP servers

The shared registry records the source location and approved fingerprint. The runner resolves credentials from the original configuration or environment when the server is requested. If the source changes, synchronize it and apply the selection to new connections.

The runner supports stdio and Streamable HTTP with MCP protocol versions `2024-11-05`, `2025-03-26`, and `2025-06-18`. Legacy SSE, servers that require a newer protocol, provider-managed OAuth, proprietary built-ins, and unsupported per-tool policies require a compatible native connector or adapter. Disabled entries stay unavailable. Stdio commands receive basic operating-system variables and environment entries explicitly supplied or inherited by their configuration.

## Agent connection

**Connect** installs a managed block in `~/.agents/AGENTS.md` and the launcher at `~/.agents/traffic-light/auto-cli.mjs`. Setup preserves instruction symlinks and installs short bridges in the Codex, Gemini, and Claude user instruction files where needed. Gemini and Antigravity share the `~/.gemini/GEMINI.md` bridge. The plugin backs up existing instructions and reports a conflict if a managed block has been edited. These operations leave provider MCP and authentication settings intact.

Automatic access follows the caller’s canonical working directory. The closest enabled parent workspace supplies the selection. Each conversation starts its own handle and retains the approved selection for the life of that handle. The plugin restores saved grants after checking their fingerprints. A changed or missing source pauses automatic access until reviewed. An already-running native agent may need a manual guide to discover the launcher. It can use the guide in the same conversation.

| Operation | Effect |
| --- | --- |
| `start` | Creates a conversation handle in the current workspace. |
| `search` | Returns up to ten matching metadata entries. |
| `recommend` | Returns up to three approved skills or MCP servers ranked for a short task. The local Kev model is used when available, with a keyword fallback. |
| `skill` | Reads the chosen skill’s instructions. |
| `tools` / `call` | Discovers tools on the chosen MCP server or invokes one advertised tool. |
| `end` | Releases the conversation handle and its connections. |

Use the same handle when following a recommendation. A Jev badge requires a linked skill read or tool invocation. Browsing tools, matching a keyword, or calling Jev directly does not attach the badge to a later request. The panel keeps shared request history in memory until the plugin reloads.

The local loopback gateway opens one connection to each requested MCP server per bundle. Separate bundles have distinct connections and working directories. A server’s tool schemas and a skill’s contents are loaded on demand. Providers may independently load their own native catalogs. External HTTP applications can share their own state across connections.

Idle MCP connections expire after 15 minutes. An explicit `reconnect` starts a new connection. Applying a changed selection affects new handles. Turning off automatic access revokes the workspace’s existing automatic handles and cancels running requests. Manual bundles can be revoked separately. A reload, update, or disable expires handles, and the agent can start a fresh one in the same conversation. Requests have time and size limits. The runner does not retry automatically. A cancelled or timed-out write may already have changed the external application.

## Activity sources

### Local terminals

The worker observes tool before/after events from agents in local Orca terminals. Terminal hooks exclude SSH and WSL. The panel filters to terminals currently present in the focused workspace. A terminal leaving that workspace also leaves the view.

**Awaiting finish** indicates an observed start. **Finished** indicates the matching end. If a call ID is missing, an end matches only a single pending call with the same terminal, agent, and tool. Ambiguous and unpaired events show **Uncertain**. An unmatched start can remain pending. The **In use** badge for such a terminal call expires after five minutes, which can also expire a very long running call’s badge early. The worker holds up to 100 calls per terminal and 100 recently active terminals in memory.

### Native chats

**Activity → Settings & privacy → Show chat activity** enables polling while the Activity tab is visible. Approximately every three seconds, the worker reads `orca worktree ps --json`. The response can include prompts, inputs, and assistant replies from all workspaces. Only the focused workspace’s activity labels are shown. Disabling the setting stops further reads.

On macOS the reader also queries Orca’s local chat journal for the focused workspace. It samples up to four local chats, prioritizing running and recently updated sessions. Per chat, it examines up to 300 recent calls and up to 8,192 characters of each tool input for recognizable names. The recent tools list shows up to 30 calls across those chats. The query excludes chat messages and tool outputs. The internal journal schema can change, and the UI indicates unavailable or truncated history. Codex, Claude, and Antigravity native chat coverage depends on the events Orca reports.

The default CLI is `orca` on macOS and `orca-ide` on Linux. On Windows, or for a different installation, set `ORCA_CLI_COMMAND` to the path of a single executable. The status command has a five-second timeout and a four-megabyte output limit.

Detection uses call metadata and skill-path references. A detected path shows that a skill was referenced. A completed skill read shows that its instructions reached the caller. Neither establishes how long a model followed the instructions. Brief activity can fall between samples. Native failure reporting depends on the provider. The panel does not measure model context usage or token costs.

## Permissions and local data

The plugin uses a trusted worker, workspace read access, its own settings and storage, and Orca’s tool hooks. Import can create shared files and links. Connect can update agent instructions and run selected local server commands with your account’s permissions. Workspace selection controls which capabilities the runner offers. It does not sandbox those commands or other processes running as the same user.

Connection secrets live in private files under `~/.agents/traffic-light` with mode `0600` on POSIX. Local gateways check authorization, host, and origin headers. Another running plugin instance cannot take over a live automatic connection. If a process exits abruptly, an expired bundle file can remain, but the stopped gateway can no longer accept its token.

The activity monitor does not persist, log, or transmit the chat contents it inspects. The shared runner returns tool results to the invoking agent. Its bounded panel records contain identifiers, names, timestamps, recommendation links, and status. It does not persist tool arguments, results, or server stderr. Invoked tools may contact their own services and produce their own logs.
