# Traffic Light for Orca

An Orca sidebar for agent activity and a shared, on-demand library of local skills and MCP tools. Inspired by [traffic-light](https://github.com/jueyi6/traffic-light) (MIT-0).

## Shared library / 공용 도구

**Install once, choose for the task, load only when needed.** Traffic Light has three tabs: **Activity**, **Library**, and **How it works** (Korean labels follow Orca's language).

1. Open **Library / 공용 도구** and search the skills and MCP configurations already installed on this computer.
2. Choose up to 24 items for the current local workspace. Nothing is selected by default; browsing or selecting never starts an MCP server.
3. Press **Prepare use instructions / 사용 안내 만들기**, then copy the guide into the agent conversation you want to use.
4. The agent runs the bundled Node CLI with its existing shell tool. It reads only a requested skill, or discovers/calls only a selected MCP server.
5. **Shared runner activity** shows actual start/completion/failure events for these requests. A skill read records content delivery, not proof that a model keeps applying it.

This works through local shell execution, including agents backed by different model providers. It requires **Node.js 18+** on the machine running Orca and an agent allowed to execute local commands. It is not native MCP injection: Orca currently reserves plugin-provided MCP/skills contributions and offers no native-chat composer API. Existing provider configurations, sessions and authentication files are never rewritten. Existing MCP registrations a provider already loads remain that provider's responsibility; the plugin does not disable them.

```mermaid
flowchart TD
  Installed[Local skills and MCP configurations] --> Catalog[Metadata catalog]
  Catalog --> Selected[Workspace selection]
  Selected --> Guide[Short guide pasted into one conversation]
  Guide --> Runner[Local shared runner]
  Runner --> Skill[Read a selected skill on demand]
  Runner --> MCP[Connect a selected MCP on demand]
  Runner -. Request events .-> Activity[Traffic Light]
```

### What is discovered

Skills come from `~/.agents/skills`, `~/.codex/skills` (including `.system`), `~/.claude/skills`, `~/.gemini/skills`, and Antigravity skill folders. Canonical paths are deduplicated, so shared symlinks appear once. The plugin reads bounded local files to extract names/descriptions and detect source changes; it does not send the library's full content to a model. Skills over 64 KiB or beyond bounded traversal are omitted with a discovery note.

MCP entries come from Codex TOML, Claude's user configuration, Gemini CLI settings and Antigravity's configuration. Equivalent configurations are deduplicated; different credentials or commands remain separate. Provider badges mean **where an entry was found**, not a verified connection or a native compatibility guarantee. Commands, environment values, URLs and credentials are kept out of the panel. Availability means a supported configuration, not that the server is running.

The runner supports stdio and classic Streamable HTTP MCP protocols `2024-11-05`, `2025-03-26`, and `2025-06-18`. Legacy SSE, newer protocol-only servers, provider-managed OAuth, provider-native built-in tools, and unsupported per-tool restrictions are not silently converted. Disabled entries stay unavailable. A public API or separate adapter is needed for proprietary plugins and built-in features. Provider plugin caches, project-specific MCP settings and remote hosts are not enumerated in this release.

### Runtime and lifecycle

Preparing a bundle starts only a small loopback gateway; it does not connect any MCP servers. The gateway holds one MCP connection per selected server **per bundle** after it is requested, preserving that server's connection state between calls. Different bundles have different connections and working directories. A source configuration change requires preparing a new bundle rather than silently changing its identity or permissions.

Selections persist per workspace. Prepared bundles are immutable, remain valid when a selection is edited, and must be explicitly revoked before replacement. Revocation also cancels active requests in that bundle. Plugin reload/update/disable ends its bundles; prepare a fresh guide afterward, without restarting the agent conversation. Idle MCP connections expire after 15 minutes; the CLI's explicit `reconnect` starts a new connection and does not restore prior server state.

Failures are returned only to the calling CLI request. Requests have time/size limits and are not automatically retried. A timed-out or cancelled write may already have changed the external application. The plugin never claims those side effects were rolled back. It does not require Unity, Figma, or other applications to be running just to browse or prepare a selection.

Only selected metadata enters the initial guide/list. Skill text, requested schemas and tool results still consume model context/tokens when used; this feature does not make them free or control the model's own tool-selection behavior.

### Access and privacy

The trusted worker can read local capability files and run selected server commands with this OS user's access. A selection is an **allowlist, not a filesystem sandbox**. Underlying tools retain their own permissions; share a bundle only with a trusted agent/conversation. Reusing the same guide in two conversations shares that bundle's server state. Use a separate workspace/bundle for independent or sensitive work.

Bundle tokens are generated locally and stored in mode-0600 files under `~/.agents/traffic-light/bundles` (POSIX); only paths, never tokens, appear in the guide. The local gateway checks authorization and origin/host headers. Provider credentials are resolved from the original configuration/environment only when connecting and are not copied into bundle files. Copying the guide is an explicit button action using the platform clipboard helper. If clipboard support is unavailable, the guide remains selectable.

The gateway returns tool results to the invoking agent and keeps only bounded request name/status/timestamps for the panel. It does not persist arguments, results or server stderr. Invoked tools may contact their own services or produce their own logs. After an abrupt worker exit an expired bundle file can remain, but its old gateway token is no longer usable once the process is gone.

## Activity tab

The panel lists skill, plugin and MCP names found in tool calls and skill file paths. A path reference alone does not prove execution. The list is incomplete and an absent name does not imply it was unused.

The agent activity section also shows subagents and their reported states when Orca exposes them. A state Orca cannot verify is shown as unverified.

**In use** marks names detected during an ongoing agent turn in the current workspace, or during a running local terminal tool call. The badge clears when the turn or call ends. Detection may miss activity or match a referenced path that was not actually executed. If a terminal call's completion event is lost, its badge expires after five minutes; very long calls may therefore lose their badge early.


The panel shows the focused workspace's tool names and agent names, marked **Awaiting finish** when a start event was observed and **Finished** when a matching end event arrived. Finished does not indicate success. If an end event is lost, a call can remain pending. When a call ID is absent, an end is matched only if exactly one pending call for the same terminal, agent and tool fits; this is an inference, not proof. Ambiguous or unpaired events are marked **Uncertain**. Orca must supply a terminal identifier; without it, an event is omitted to avoid exposing another workspace's calls. Calls are filtered to terminals currently listed in the focused workspace, so calls from a closed terminal no longer appear. Up to 100 calls per terminal and 100 recently active terminals are held in memory, and are cleared when the worker restarts. Older calls may be evicted.

The plugin does not retain tool inputs or outputs. It does receive them from Orca as part of the hook events; only the agent name, tool name and identifiers are kept in memory. Activity monitoring does not send these observations to a server. The separate shared runner can connect to MCP endpoints you select and invoke.

## Optional current activity for native chats

The panel offers **Show current native chat activity**, disabled by default. When enabled and the panel is visible, the plugin runs `orca worktree ps --json` approximately every three seconds. Orca returns data for **all workspaces**, including agent prompts, tool inputs and assistant messages, to this plugin's worker process. The plugin displays only the current workspace's agent type, state, tool and detected resource names; it does not save, log or send the response or conversation contents. On macOS it also reads recent tool names and up to 8192 characters of each tool input, for at most 300 recent calls in up to four local native chat sessions in the current workspace, from Orca's local session journal. It does not query tool outputs or chat messages from the journal. Orca's internal journal schema is not a public API and can change; when unavailable or truncated the panel indicates this. Disable the switch to stop further reads. This requires a working local Orca CLI; failures are shown in the panel. The default command is `orca` on macOS and `orca-ide` on Linux. Windows has no default command; `ORCA_CLI_COMMAND` may specify a single executable path when available. The subprocess has a five-second timeout and a four-megabyte output limit.

The live view is sampled: brief calls can be missed, and tool names can be absent depending on what Orca and the agent expose. The journal adds a bounded recent history on supported macOS installations; it is not a complete record. The feature does not restrict model choice, but it cannot guarantee support for every provider or environment. The CLI snapshot may also include terminal agents.

## Limitations

Orca's hook API documents tool events for agents in local Orca terminals. SSH and WSL agents are not supported by those hooks; native chats use the optional view described above. The Activity tab is not an inventory and cannot reliably detect failures of native provider calls or report context occupancy/token costs. The Library tab separately discovers supported local configurations, and shared-runner events report their own request outcomes. An empty list means no calls were observed, not that no tools exist or were used.

## Install

Requires Orca 1.4.261 or newer; the shared runner additionally requires local Node.js 18+. Run `orca plugin install angelcrown24/orca-traffic-light` and review the requested access and fingerprint in Orca's output before following its approval instructions. The plugin uses a trusted worker and workspace read, its own settings and storage access, plus tool before/after hooks. Version 0.4 adds own-storage access for workspace selections. Orca also supports installing a local clone with `orca plugin install /absolute/path/to/clone`.

Open the **Traffic Light** panel in Orca's right sidebar. Terminal calls are visible only when observed while the worker is running; supported native chats may also show recent journal activity.

## Development

Run `node --test runtime/*.test.mjs`, `orca plugin validate . --json`, `orca plugin test . --json`, `orca plugin check . --json`, and `npx --package typescript tsc -p .`. Runtime tests use isolated temporary fixtures and synthetic MCP servers; they never rewrite real provider configuration. No npm install or build step is required for plugin users.

## License

MIT-0. See [LICENSE](LICENSE). The vendored smol-toml 1.9.1 parser retains its BSD-3-Clause license in [runtime/vendor/smol-toml.LICENSE](runtime/vendor/smol-toml.LICENSE).
