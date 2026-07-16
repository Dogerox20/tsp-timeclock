# TSP Clockbot

Discord approval bot and Google Sheets API for The Shoreline Project's FiveM time clock. The FiveM Lua resource is distributed separately; this repository contains only the Railway-hosted bot.

## What it does

- Receives authenticated clock-in and clock-out requests from FiveM.
- Matches members to the roster by Discord ID.
- Posts Approve and Deny buttons in the configured Discord channel.
- Adds approved durations to the member's existing Hours cell.
- Stores hours as numeric Google Sheets durations formatted `[hh]:mm:ss`.
- DMs members after approval or denial.
- Persists active and pending sessions on a Railway volume.

## Discord bot setup

1. Create an application and bot in the Discord Developer Portal.
2. Add the bot to the Shoreline Discord server.
3. In the approval channel, grant it `View Channel`, `Send Messages`, `Embed Links`, and `Read Message History`.
4. Copy the bot token, server ID, approval-channel ID, and approving-role IDs.

The bot does not require privileged gateway intents. Discord administrators may always review entries; other reviewers need a role listed in `DISCORD_APPROVER_ROLE_IDS`.

## Google Sheets setup

1. Enable the Google Sheets API in a Google Cloud project.
2. Create a service account and download its JSON key.
3. Share the membership spreadsheet with the service account's `client_email` as an Editor.
4. Keep Discord IDs as text in the configured roster column.

The Shoreline defaults are member name in D, Discord ID in E, Hours in G, and data beginning at row 9. Blank section rows are supported.

## Railway deployment

1. Create a Railway project from `Dogerox20/tsp-timeclock`.
2. Generate a public domain under **Settings > Networking**.
3. Attach a persistent volume mounted at `/data`.
4. Add these variables:

```text
API_SECRET=
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
DISCORD_APPROVAL_CHANNEL_ID=
DISCORD_APPROVER_ROLE_IDS=
GOOGLE_SPREADSHEET_ID=
GOOGLE_PROJECT_ID=
GOOGLE_CLIENT_EMAIL=
GOOGLE_PRIVATE_KEY=
ROSTER_SHEET_NAME=
ROSTER_START_ROW=9
ROSTER_NAME_COLUMN=D
ROSTER_DISCORD_COLUMN=E
ROSTER_HOURS_COLUMN=G
ENABLE_HOURS_AUDIT_LOG=false
DATA_FILE=/data/sessions.json
```

Do not set `PORT`; Railway supplies it. The application listens on `0.0.0.0` and exposes `/health`.

Copy `project_id`, `client_email`, and `private_key` from the downloaded service-account JSON into their matching variables. `GOOGLE_PRIVATE_KEY` accepts real line breaks or literal `\n` characters. Never commit the key, Discord token, or API secret.

`API_SECRET` must exactly match `tsp_timeclock_api_secret` in the FiveM server configuration.

## Optional audit tab

The Shoreline roster uses the Hours column on the main sheet, so keep:

```text
ENABLE_HOURS_AUDIT_LOG=false
```

To append approval history to a separate tab, create that tab and set:

```text
ENABLE_HOURS_AUDIT_LOG=true
HOURS_LOG_SHEET_NAME=Hours
```

## Local development

```powershell
Copy-Item .env.example .env
pnpm install
pnpm start
```

Session state defaults to `data/sessions.json`. The file, `.env`, and `node_modules` are excluded from Git.

## Health check

Open:

```text
https://your-service.up.railway.app/health
```

A healthy deployment returns:

```json
{"ok":true,"discordReady":true}
```
