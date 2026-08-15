# dsh-gemini-bridge

Global [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that drives your **logged-in Google Gemini web app** (`gemini.google.com`, including your **Gemini Pro** subscription) through Edge's Chrome DevTools Protocol (CDP). It turns Gemini into a second brain you can use from any session:

| Tool | What it does |
| --- | --- |
| `gemini_ask` | Ask Gemini anything. The web app can search the web itself, so you get live information; optionally attach any local file (image / PDF / text / code) and optionally continue an existing conversation (`chat_id`). |
| `gemini_vision` | Multimodal analysis of a local image (OCR, charts, UI, objects). |
| `gemini_screen` | Capture the current screen (the automation Edge window is minimized first) and analyze it. |
| `gemini_chats` | List your Gemini conversation history (title + ID). |
| `gemini_chat_read` | Read the full content (user turns + Gemini replies) of one conversation. |

The plugin also registers a **Gemini LLM provider** (`gemini-bridge` / model `gemini-web`): select it in the model picker and the conversation is driven by your Gemini Pro web account — and because the model declares `image` input support, **you can paste an image directly into the composer** and Gemini sees it (no extra tool call needed). This works around the harness's hard rule that text-only models reject image input.

## How it works

- A **bridge script** (`lib/gemini-bridge.mjs`) launches/attaches to **Microsoft Edge** with a dedicated automation profile and a CDP debugging port, drives `gemini.google.com`, uploads files, types prompts, and reads replies.
- The plugin spawns the bridge with **unconfined** subprocess privileges — the DSH file sandbox would otherwise break Edge's own child processes.
- Your Gemini login is stored in a dedicated Edge profile (`~/.dsh/gemini-bridge/edge-profile`), so you sign in **once** and it is reused everywhere.

## Requirements

- Windows with **Microsoft Edge** (Chromium engine) installed.
- Node.js ≥ 22 (global `WebSocket`/`fetch`).
- Logged into `gemini.google.com` with a Google account (Pro recommended) in the automation window on first use.

## Install (global)

The plugin registers into the **host composition** so the tools are visible in every session:

```powershell
# 1. Put the package where the harness can resolve it
#    (copy into the profile's node_modules, or npm link)
npm install <path-to-this-package> --prefix "$env:USERPROFILE\.dsh\profiles"
# or: copy this directory to "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-gemini-bridge"

# 2. Install the bridge script to the DSH home
node scripts/install-global.mjs

# 3. Register the plugin row in the host composition
#    edit "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml", add:
#      - insert:
#          - id: gemini-bridge
#            name: 'dsh-gemini-bridge'

# 4. Restart the web app; the five gemini_* tools become available in every session.
```

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `DSH_GEMINI_NODE` | `process.execPath` | Node executable used to run the bridge. |
| `DSH_GEMINI_EDGE` | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | Path to the Edge binary. |

The bridge listens on CDP port **9229** with a dedicated profile under `~/.dsh/gemini-bridge/edge-profile`.

## First use

The first tool call opens an Edge automation window at `gemini.google.com` — sign in there **once** with your Google account (the one with Gemini Pro). The session persists in the dedicated profile and is reused by every later call.

## License

MIT
