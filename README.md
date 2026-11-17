# Traffic Light for Orca

A small Orca sidebar showing observed tool calls from local terminal agents. Inspired by [traffic-light](https://github.com/jueyi6/traffic-light) (MIT-0).

## What it shows

The panel shows the focused workspace's tool names and agent names, marked **Awaiting finish** when a start event was observed and **Finished** when its matching end event arrived. Finished does not indicate success. If an end event is lost, a call can remain pending. Orca must supply terminal and call identifiers; events without them are omitted to avoid matching unrelated calls. Calls are filtered to terminals currently listed in the focused workspace, so calls from a closed terminal no longer appear. Up to 100 calls per terminal and 100 recently active terminals are held in memory, and are cleared when the worker restarts. Older calls may be evicted.

The plugin does not retain tool inputs or outputs. It does receive them from Orca as part of the hook events; only the agent name, tool name and identifiers are kept in memory. No data is sent to a server by this plugin.

## Limitations

Orca's hook API documents tool events for agents in local Orca terminals. SSH and WSL agents are not supported by those hooks; native chat coverage is not established. This plugin cannot enumerate available skills, MCP servers, agents or tools, detect failures reliably, or report context occupancy and token costs. An empty list means no calls were observed, not that no tools exist or were used.

## Install

Requires Orca 1.4.248 or newer. Run `orca plugin install angelcrown24/orca-traffic-light` and review the requested access and fingerprint in Orca's output before following its approval instructions. The plugin uses a trusted worker and workspace read access, plus tool before/after hooks. Orca also supports installing a local clone with `orca plugin install /absolute/path/to/clone`.

Open the **Traffic Light** panel in Orca's right sidebar. Only calls observed while the worker is running can appear.

## Development

Run `orca plugin validate . --json`, `orca plugin test . --json`, and `orca plugin check . --json`.

## License

MIT-0. See [LICENSE](LICENSE).
