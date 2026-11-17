# Traffic Light for Orca

An Orca sidebar showing observed skill, plugin, MCP and tool activity from agents, with optional support for Orca chats. Inspired by [traffic-light](https://github.com/jueyi6/traffic-light) (MIT-0).

## What it shows

The panel lists skill, plugin and MCP names found in tool calls and skill file paths. A path reference alone does not prove execution. The list is incomplete and an absent name does not imply it was unused.

**In use** marks names detected during an ongoing agent turn in the current workspace, or during a running local terminal tool call. The badge clears when the turn or call ends. Detection may miss activity or match a referenced path that was not actually executed. If a terminal call's completion event is lost, its badge expires after five minutes; very long calls may therefore lose their badge early.


The panel shows the focused workspace's tool names and agent names, marked **Awaiting finish** when a start event was observed and **Finished** when a matching end event arrived. Finished does not indicate success. If an end event is lost, a call can remain pending. When a call ID is absent, an end is matched only if exactly one pending call for the same terminal, agent and tool fits; this is an inference, not proof. Ambiguous or unpaired events are marked **Uncertain**. Orca must supply a terminal identifier; without it, an event is omitted to avoid exposing another workspace's calls. Calls are filtered to terminals currently listed in the focused workspace, so calls from a closed terminal no longer appear. Up to 100 calls per terminal and 100 recently active terminals are held in memory, and are cleared when the worker restarts. Older calls may be evicted.

The plugin does not retain tool inputs or outputs. It does receive them from Orca as part of the hook events; only the agent name, tool name and identifiers are kept in memory. No data is sent to a server by this plugin.

## Optional current activity for native chats

The panel offers **Show current native chat activity**, disabled by default. When enabled and the panel is visible, the plugin runs `orca worktree ps --json` approximately every three seconds. Orca returns data for **all workspaces**, including agent prompts, tool inputs and assistant messages, to this plugin's worker process. The plugin displays only the current workspace's agent type, state, tool and detected resource names; it does not save, log or send the response or conversation contents. On macOS it also reads recent tool names and up to 8192 characters of each tool input, for at most 300 recent calls in up to four local native chat sessions in the current workspace, from Orca's local session journal. It does not query tool outputs or chat messages from the journal. Orca's internal journal schema is not a public API and can change; when unavailable or truncated the panel indicates this. Disable the switch to stop further reads. This requires a working local Orca CLI; failures are shown in the panel. The default command is `orca` on macOS and `orca-ide` on Linux. Windows has no default command; `ORCA_CLI_COMMAND` may specify a single executable path when available. The subprocess has a five-second timeout and a four-megabyte output limit.

The live view is sampled: brief calls can be missed, and tool names can be absent depending on what Orca and the agent expose. The journal adds a bounded recent history on supported macOS installations; it is not a complete record. The feature does not restrict model choice, but it cannot guarantee support for every provider or environment. The CLI snapshot may also include terminal agents.

## Limitations

Orca's hook API documents tool events for agents in local Orca terminals. SSH and WSL agents are not supported by those hooks; native chats use the optional view described above. This plugin cannot enumerate available skills, MCP servers, agents or tools, detect failures reliably, or report context occupancy and token costs. An empty list means no calls were observed, not that no tools exist or were used.

## Install

Requires Orca 1.4.248 or newer. Run `orca plugin install angelcrown24/orca-traffic-light` and review the requested access and fingerprint in Orca's output before following its approval instructions. The plugin uses a trusted worker and workspace read and its own settings access, plus tool before/after hooks. Orca also supports installing a local clone with `orca plugin install /absolute/path/to/clone`.

Open the **Traffic Light** panel in Orca's right sidebar. Terminal calls are visible only when observed while the worker is running; supported native chats may also show recent journal activity.

## Development

Run `orca plugin validate . --json`, `orca plugin test . --json`, and `orca plugin check . --json`.

## License

MIT-0. See [LICENSE](LICENSE).
