# Laryn

Laryn is a Windows-first Electron speech-to-text app. Press `Ctrl + Win` to start recording, press it again to stop, and the app sends the audio through a Cloudflare Worker that transcribes with Deepgram Nova-3 via Workers AI behind AI Gateway. The Worker then lightly cleans the transcript with a conservative text model pass before the desktop app pastes it into the currently focused application.

## Apps

- `apps/desktop`: Electron + Vite desktop client.
- `apps/worker`: Cloudflare Worker transcription API.
- `packages/shared`: Shared API types.

## Setup

```powershell
pnpm install
Copy-Item apps\desktop\.env.example apps\desktop\.env
Copy-Item apps\worker\.dev.vars.example apps\worker\.dev.vars
```

Set the Worker variables in `apps/worker/.dev.vars`, then start it:

```powershell
pnpm worker:dev
```

Set `LARYN_WORKER_URL` in `apps/desktop/.env` to the local Worker URL shown by Wrangler, then run:

```powershell
pnpm desktop:dev
```

## Cloudflare

Create an AI Gateway in Cloudflare, then provide:

- `AI_GATEWAY_ID`
- `LARYN_DESKTOP_TOKEN`

The Worker uses the `AI` binding in `wrangler.jsonc`, so model calls run through Workers AI with AI Gateway observability instead of a hand-built REST URL.

The Worker uses these model defaults:

- Speech-to-text: `@cf/deepgram/nova-3`
- Standard cleanup: `@cf/qwen/qwen3-30b-a3b-fp8`
- Cheap cleanup fallback: `@cf/ibm-granite/granite-4.0-h-micro`
- Premium cleanup: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`

Deploy with:

```powershell
pnpm worker:deploy
```

## Hotkey note

The requested binding is `Ctrl + Win`. Windows and Electron can be inconsistent with modifier-only global shortcuts, so the app tries `Control+Super` first and falls back to `Control+Super+Space`. The active binding is shown in the app.
