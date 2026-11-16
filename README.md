# Antigravity Generative UI Agent

An interactive Antigravity workbench powered by [`agy acp`](https://antigravity.google/docs) and [OpenUI](https://github.com/thesysdev/openui) (`@openuidev/react-ui`, `@openuidev/react-lang`, `@openuidev/lang-core`, `@agentclientprotocol/sdk`) where every response renders as live charts, forms, tables, and dashboards—while keeping Antigravity CLI feature parity.

## Features

- **Generative UI via OpenUI Lang**: Appends the OpenUI component specification generated locally from `src/library.ts` into `agy acp` via `_meta.antigravity.systemPrompt.append` (no OpenUI Cloud API key required). Renders charts, tables, interactive forms (`@ToAssistant`), KPI cards, tabs, steps, callouts, and code blocks as tokens stream.
- **Full Antigravity CLI Parity via `agy acp`**:
  - **Starts in `auto` mode** by default, with live header selectors for **Model**, **Thinking Level** (`low`, `medium`, `high`), and **Execution Mode** (`auto`, `default`, `accept-edits`, `plan`).
  - **Interactive Permission Prompts (`session/request_permission`)**: Surfaces ACP tool approval cards directly above the composer.
  - **`/` Slash Commands & Skills Autocomplete**: Dynamically populated from ACP `available_commands_update` (`/goal`, `/compact`, `/schedule`, `/browser`, `/plan`, `/grill-me`, `/teamwork`, `/learn`, `/boost`, plus all installed/workspace skills), plus app shortcuts (`/usage`, `/mcp`, `/sessions`, `/workspace`, `/clear`).
  - **`@` File Picker**: Workspace-aware file autocomplete across `cwd` and `--add-dir` (`additionalDirectories`).
  - **`!` Direct Shell Execution**: Run `!command` in the workspace and render output as an OpenUI terminal card.
  - **MCP Server Management**: View, enable, disable, add, and remove global `agy mcp` servers or inject per-session ACP `mcpServers`.
  - **Session History & Resume**: Browse and resume historical Antigravity CLI/ACP sessions via `session/list` and `session/load`.
  - **`ask_question` Form Synthesis & Resilient Fallback**: Converts `ask_question` tool payloads into interactive OpenUI Forms and falls back cleanly to styled Markdown cards for non-OpenUI outputs.

## Commands

```bash
npm install
npm run dev         # Runs `npm run generate` then starts Next.js dev server
npm run build       # Generates OpenUI spec and builds production bundle
npm run start       # Runs production server
npm run typecheck   # TypeScript verification
npm test            # Vitest unit tests
```
