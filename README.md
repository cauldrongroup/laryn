# Laryn

Laryn is a Windows-first Electron speech-to-text app. Press `Ctrl + Win` to start recording, press it again to stop, and the app sends the audio through a Cloudflare Worker that transcribes with Whisper via Workers AI behind AI Gateway. The Worker then lightly cleans the transcript with a conservative text model pass before the desktop app pastes it into the currently focused application.

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

The desktop defaults to the deployed Worker:

```powershell
https://laryn.mineperial.com
```

Only start a local Worker when you are actively developing Worker code:

```powershell
pnpm worker:dev
```

For normal desktop development, run:

```powershell
pnpm desktop:dev
```

For hot renderer development, run `pnpm desktop:dev:renderer` in one terminal and `pnpm desktop:dev:hot` in another.

## Cloudflare

Create an AI Gateway in Cloudflare and a D1 database named `laryn`, then apply the Worker migrations:

```powershell
pnpm --filter @laryn/worker exec wrangler d1 migrations apply laryn --local
pnpm --filter @laryn/worker exec wrangler d1 migrations apply laryn --remote
```

Update `apps/worker/wrangler.jsonc` with the real D1 `database_id`, then provide:

- `CLOUDFLARE_ACCOUNT_ID`
- `AI_GATEWAY_ID`
- `GROQ_API_KEY` when `TRANSCRIPTION_PROVIDER=groq`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `POLAR_ACCESS_TOKEN`
- `POLAR_WEBHOOK_SECRET`
- `POLAR_PRO_PRODUCT_ID`
- `PUBLIC_APP_URL`

The Worker uses Cloudflare AI Gateway for Groq speech-to-text when `TRANSCRIPTION_PROVIDER=groq`. Cleanup runs through Cloudflare-hosted text generation models using Workers AI neurons pricing.

Google OAuth callback URLs:

- Local: `http://localhost:8787/api/auth/callback/google`
- Production: `https://laryn.mineperial.com/api/auth/callback/google`

Polar is configured through the Better Auth plugin. The webhook endpoint is:

```text
https://laryn.mineperial.com/api/auth/polar/webhooks
```

Desktop clients now pair with an account using a device-code flow from the Settings drawer. The old shared `LARYN_DESKTOP_TOKEN` flow has been replaced by per-device tokens stored by Electron safe storage.

The Worker uses these model defaults:

- Speech-to-text provider: `groq`
- Groq speech-to-text: `whisper-large-v3-turbo`
- Workers AI speech-to-text fallback: `@cf/openai/whisper-large-v3-turbo`
- Speech-to-text language: `en`
- Speech-to-text hints: configurable with `TRANSCRIPTION_HINTS` for names, product terms, acronyms, and project vocabulary that are often misheard
- Cheap cleanup: `@cf/meta/llama-3.2-1b-instruct`
- Standard cleanup: `@cf/meta/llama-3.2-3b-instruct`
- Premium cleanup: `@cf/google/gemma-4-26b-a4b-it`
- Cleanup fallback: `@cf/meta/llama-3.1-8b-instruct-fast`
- Default cleanup tier: `off`
- Cleanup timeout: `3500ms`, then paste the raw transcript
- Groq transcription is routed through Cloudflare AI Gateway and metered with `LARYN_GROQ_WHISPER_MICRO_USD_PER_AUDIO_MINUTE` plus `LARYN_GROQ_MIN_BILLABLE_AUDIO_MS`.
- Pre-AI usage controls are configured with `LARYN_MONTHLY_USAGE_CAP_UNITS`, `LARYN_RATE_LIMIT_MAX_REQUESTS`, `LARYN_RATE_LIMIT_WINDOW_SECONDS`, and `LARYN_MAX_CONCURRENT_TRANSCRIPTIONS_PER_USER`.

For the lowest-cost setup, keep cleanup set to `off`. That uses only the speech-to-text call and skips the second text-generation cleanup call. Switch to `cheap` only when you want punctuation/capitalization cleanup.

Deploy with:

```powershell
pnpm worker:deploy
```

Validate the Worker bundle without deploying:

```powershell
pnpm worker:dry-run
```

GitHub Actions are split by purpose:

- `CI`: runs on push and PR, then typechecks, lints, and runs `wrangler deploy --dry-run`.
- `Worker Deploy`: manual production Worker deploy with the checked-in Wrangler CLI.
- `Desktop Release`: manual Windows installer and R2 auto-update publication.

Cloudflare Git-connected Worker build settings:

- Root directory: `/`
- Build command: `pnpm --filter @laryn/worker build`
- Deploy command: `pnpm --filter @laryn/worker run deploy`
- Version command: `pnpm --filter @laryn/worker run versions:upload`

Keep the root directory at `/` so pnpm can resolve the workspace package `@laryn/shared`. The filtered pnpm commands execute inside `apps/worker`, where `wrangler.jsonc` lives.

## Desktop releases

Desktop builds are published manually from `.github/workflows/desktop-release.yml`. Open the workflow in GitHub Actions, choose **Run workflow**, and enter the semver version to release.

The workflow expects these GitHub repository variables:

- `LARYN_R2_BUCKET`: the R2 bucket used for auto-update assets
- `LARYN_UPDATE_BASE_URL`: the public base URL for that bucket
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account id that owns the bucket

It also needs `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` repository secrets with R2 object write access. Each manual run builds the Windows NSIS installer and the macOS Apple Silicon DMG/ZIP, generates a friendly two-word update name, uploads the desktop assets to the GitHub Release, verifies `latest.yml` and `latest-mac.yml`, and publishes the update feeds plus `.exe`, `.dmg`, `.zip`, and `.blockmap` files to R2.

The hosted download page redirects through these update feeds:

- Windows: `/downloads/laryn-windows-latest.exe`
- macOS: `/downloads/laryn-mac-latest.dmg`

The macOS build is currently ad-hoc signed and not notarized. It is useful for early testing, but macOS users may need to approve the app in Privacy & Security on first launch.

Installed desktop builds check the R2 update feed after startup, download updates in the background, and install the downloaded update the next time Laryn restarts. When an update is ready, Settings shows an install button that restarts Laryn and applies it. The app version and generated update name are visible in Settings for debug purposes.

## Hotkey note

The requested binding is `Ctrl + Win`. Windows and Electron can be inconsistent with modifier-only global shortcuts, so the app tries `Control+Super` first and falls back to `Control+Super+Space`. The active binding is shown in the app.

## Open source readiness

Laryn is licensed under the Apache License, Version 2.0. See `LICENSE`.

The source license does not grant permission to use Laryn names, logos, domains, hosted services, production infrastructure, API credentials, signing keys, or private configuration. See `NOTICE` and `TRADEMARKS.md`.

Keep generated secrets in ignored files only, especially `apps/worker/.dev.vars` and `apps/desktop/.env`.

Run the redacted secret scanner before publishing or merging release changes:

```powershell
pnpm security:scan -- --history
pnpm security:scan -- --include-ignored
```

The ignored-file scan will fail when local secret files contain real values. That is expected; rotate any value that was ever committed and do not paste scanner output publicly.
