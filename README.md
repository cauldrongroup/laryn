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
- Premium/fallback cleanup: `@cf/meta/llama-3.1-8b-instruct-fast`
- Default cleanup tier: `off`
- Cleanup timeout: `3500ms`, then paste the raw transcript

For the lowest-cost setup, keep cleanup set to `off`. That uses only the speech-to-text call and skips the second text-generation cleanup call. Switch to `cheap` only when you want punctuation/capitalization cleanup.

Deploy with:

```powershell
pnpm worker:deploy
```

## Desktop releases

Windows installers are built manually from `.github/workflows/desktop-release.yml`. Open the workflow in GitHub Actions, choose **Run workflow**, and enter the semver version to release.

The workflow expects these GitHub repository variables:

- `LARYN_R2_BUCKET`: `laryn-updates`
- `LARYN_UPDATE_BASE_URL`: `https://pub-20b1f8f56fed41fdb74c874201491380.r2.dev`
- `CLOUDFLARE_ACCOUNT_ID`: `6d6529fc50727497faffecc2e510e191`

It also needs a `CLOUDFLARE_API_TOKEN` repository secret with R2 object write access. Each manual run builds the NSIS installer, generates a friendly two-word update name, uploads the installer assets to the GitHub Release, and publishes `latest.yml`, the `.exe`, and the `.blockmap` to R2 for background auto-updates.

Installed desktop builds check the R2 update feed after startup, download updates in the background, and install the downloaded update the next time Laryn restarts. The app version and generated update name are visible in Settings for debug purposes.

## Hotkey note

The requested binding is `Ctrl + Win`. Windows and Electron can be inconsistent with modifier-only global shortcuts, so the app tries `Control+Super` first and falls back to `Control+Super+Space`. The active binding is shown in the app.
