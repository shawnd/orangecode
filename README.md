# orangecode

An open source AI coding agent for the terminal, forked from [OpenCode](https://github.com/anomalyco/opencode). Run it with **`oc`**.

orangecode builds on OpenCode's provider support, agents, tools, MCP integrations, and client/server architecture, with additional controls for context, permissions, model selection, and session visibility. This is an independent fork, not an official OpenCode distribution.

## What's different

These features come from the fork commits added since the upstream base:

| Feature                             | How to use it                                                                                                                                                                     | Details                                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model-aware subagents               | Ask to use a connected model such as “Grok 4.7 max” for a subagent. The agent can discover setups with `models` and `models_search`, then pass `model` and `variant` to `task`.   | [Agents](packages/web/src/content/docs/agents.mdx#subagent-model-selection-orangecode), [tools](packages/web/src/content/docs/tools.mdx#orangecode-tools) |
| Earlier automatic compaction        | Set `compaction.threshold_percent` to compact at a percentage of the model's context window. Safe input/output limits still apply.                                                | [Configuration](packages/web/src/content/docs/config.mdx#compaction)                                                                                      |
| Agent-controlled context management | Ask how much context is in use, or ask the agent to compact and continue. `context_usage` reports the last completed turn; `compact` schedules compaction after the current turn. | [Tools](packages/web/src/content/docs/tools.mdx#orangecode-tools)                                                                                         |
| Persistent folder approvals         | Choose **Allow global** on an external-directory request to save its folder patterns across projects and restarts.                                                                | [Permissions](packages/web/src/content/docs/permissions.mdx#persistent-folder-approvals-orangecode)                                                       |
| Permissions management pane         | Open `/permissions` to inspect Config, Global, Agent, Session, Active, and Pending rules; edit saved rule actions and toggle auto-approval.                                       | [Permissions](packages/web/src/content/docs/permissions.mdx#permissions-pane-orangecode)                                                                  |
| Usage statistics                    | Open `/usage` or click the prompt's token/context indicator to view session counts, token breakdowns, and cost across all projects, this project, or this session.                | [TUI](packages/web/src/content/docs/tui.mdx#usage)                                                                                                        |
| Session and subagent cost           | Click the cost indicator to switch between the current session's cost and the total including descendant subagents. Forked sessions start with zero cost.                         | [TUI](packages/web/src/content/docs/tui.mdx#session-visibility-orangecode)                                                                                |
| Session visibility                  | Click a sidebar session ID to copy it and see session additions/deletions in the sidebar footer. Subagent permission prompts include the underlying tool details.                 | [TUI](packages/web/src/content/docs/tui.mdx#session-visibility-orangecode)                                                                                |
| Clickable LSP controls              | Enable or disable LSPs from the sidebar and save the setting for the current directory.                                                                                           | [TUI](packages/web/src/content/docs/tui.mdx#session-visibility-orangecode)                                                                                |
| Clipboard paste                     | Right-click the prompt to paste clipboard text or images.                                                                                                                         | [TUI](packages/web/src/content/docs/tui.mdx#clipboard-paste-orangecode)                                                                                   |
| Herdr pane splitting                | Run `/split` inside Herdr to open another `oc` TUI attached to the current backend and session.                                                                                   | [TUI](packages/web/src/content/docs/tui.mdx#split), [CLI](packages/web/src/content/docs/cli.mdx#orangecode-command)                                       |

## Installation

Build this repository to get the orangecode changes. The installers and packages published at `opencode.ai` and under `opencode-ai` distribute upstream OpenCode.

Requires **Bun 1.3.14+** and Git. From a terminal:

```bash
git clone https://github.com/shawnd/orangecode.git
cd orangecode
bun install
bun run --cwd packages/opencode script/build.ts --single --skip-install --skip-embed-web-ui
```

`--single` builds for the current platform. Omit `--skip-embed-web-ui` if you also want the web app embedded in the binary. Build artifacts retain the upstream names: `packages/opencode/dist/opencode-<platform>/bin/opencode`.

### Install the `oc` command (Linux x64)

The local installation keeps the binary at `~/.local/share/oc/bin/opencode` and exposes it through a small `~/.local/bin/oc` wrapper:

```bash
mkdir -p "$HOME/.local/share/oc/bin" "$HOME/.local/bin"
install -m 755 packages/opencode/dist/opencode-linux-x64/bin/opencode "$HOME/.local/share/oc/bin/opencode.new"
mv -f "$HOME/.local/share/oc/bin/opencode.new" "$HOME/.local/share/oc/bin/opencode"

cat > "$HOME/.local/bin/oc" <<'SH'
#!/usr/bin/env bash
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_CHANNEL_DB=1
exec "$HOME/.local/share/oc/bin/opencode" "$@"
SH
chmod +x "$HOME/.local/bin/oc"

oc --version
```

Make sure `~/.local/bin` is on your `PATH`. For other platforms, use the matching artifact directory (for example, `opencode-darwin-arm64`). The wrapper disables upstream automatic updates and uses the standard database rather than a channel-specific database. The binary replacement is atomic; restart existing sessions to load a rebuilt binary.

## Quick start

```bash
oc                                      # Open the TUI in the current directory
oc /path/to/project                     # Open a different project
oc --continue                           # Resume the latest session
oc --session ses_...                     # Resume a specific session
oc run "Explain this codebase"           # Run a prompt from the CLI
oc serve --port 4096                     # Start the API server
oc attach http://localhost:4096 --session ses_... --dir /path/to/project
```

In the TUI, use `/connect` to configure a provider, `/models` to pick a model, and `Tab` to switch primary agents. Open the command palette with `Ctrl+p` for available actions.

## Agents

- **build** — the default development agent with full tool access.
- **plan** — a restricted agent for analysis and planning, with permission checks for edits and shell commands.
- **general**, **explore**, and **scout** — subagents for multistep work, codebase exploration, and external documentation/dependency research. Invoke them with an `@` mention or ask the primary agent to delegate.

orangecode lets the primary agent discover connected model setups and choose a model and reasoning variant for each delegated task. See the [agent guide](packages/web/src/content/docs/agents.mdx#subagent-model-selection-orangecode).

## Configuration and documentation

Configuration retains OpenCode-compatible names: `opencode.json` / `opencode.jsonc`, `.opencode/`, `~/.config/opencode/`, and `OPENCODE_*` environment variables.

- [CLI commands](packages/web/src/content/docs/cli.mdx) and [terminal UI](packages/web/src/content/docs/tui.mdx)
- [Configuration](packages/web/src/content/docs/config.mdx), [permissions](packages/web/src/content/docs/permissions.mdx), and [keybindings](packages/web/src/content/docs/keybinds.mdx)
- [Agents](packages/web/src/content/docs/agents.mdx), [models](packages/web/src/content/docs/models.mdx), and [tools](packages/web/src/content/docs/tools.mdx)
- [MCP servers](packages/web/src/content/docs/mcp-servers.mdx), [skills](packages/web/src/content/docs/skills.mdx), and [plugins](packages/web/src/content/docs/plugins.mdx)

The [upstream documentation](https://opencode.ai/docs) covers shared OpenCode behavior. Use `oc` wherever those examples say `opencode`; the local guides above document the fork additions. Translated `README.*.md` files currently describe upstream OpenCode.

## Development

```bash
bun install
bun dev .
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflows and [AGENTS.md](AGENTS.md) for repository conventions. Tests and typechecks run from the relevant package directory.

## Credits and license

orangecode is based on [OpenCode](https://github.com/anomalyco/opencode) by Anomaly and its contributors. Licensed under [MIT](LICENSE).
