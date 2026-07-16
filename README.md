# TSP Time Clock

This resource records `/clockin` and `/clockout` sessions by Discord ID. Clocking out—or leaving the server—posts an approval request in Discord. An approved request adds the duration to the matching roster row and appends an audit entry to the `Hours` sheet.

## Requirements

- FiveM server artifact with Lua 5.4 support
- Node.js 20 or newer on the machine running the service
- A Discord bot in the Shoreline Discord server
- A Google Cloud service account with edit access to the membership spreadsheet
- A sheet tab named `Hours`

## 1. Prepare Google Sheets

1. In Google Cloud, create a project and enable the Google Sheets API.
2. Create a service account and download its JSON key to a private location outside the FiveM resources folder.
3. Share the membership spreadsheet with the service account email as **Editor**.
4. Create an `Hours` tab. Row 1 may use these headings:

   `Session ID | Discord ID | Member | Clock In | Clock Out | Hours | Status | Reviewed By`

The defaults match the supplied roster image: member name in column D, Discord ID in E, and total Hours in G, starting at row 9. Blank section rows are supported.

## 2. Prepare Discord

1. Create a bot in the Discord Developer Portal and add it to the server.
2. Give it `View Channel`, `Send Messages`, `Embed Links`, and `Read Message History` in the approval channel.
3. Copy the server, approval-channel, and approving-role IDs.

The bot does not require privileged gateway intents. Administrators can always review; otherwise a member needs one of the configured approver roles.

## 3. Configure and run the service

From `tsp-timeclock/service`:

```powershell
Copy-Item .env.example .env
npm install
npm start
```

Fill every required value in `.env`. `GOOGLE_SPREADSHEET_ID` is the long ID between `/d/` and `/edit` in the spreadsheet URL.

Use a long random value for `API_SECRET`. Keep `.env`, the Google key, and the Discord token private. The service listens only on `127.0.0.1` by default and stores durable session state in `service/data/sessions.json`.

`HOURS_VALUE_MODE=decimal` writes totals such as `2.25`. Set it to `duration` to display totals as `[h]:mm` in Sheets.

## 4. Configure FiveM

Add this before `ensure tsp-timeclock` in `server.cfg`, using the same secret as `.env`:

```cfg
set tsp_timeclock_api_url "http://127.0.0.1:3099"
set tsp_timeclock_api_secret "replace-with-the-same-long-random-secret"
ensure tsp-timeclock
```

If the Node service runs on another machine, expose it through a private network or HTTPS reverse proxy and change the URL. Do not expose an unencrypted public HTTP endpoint.

## Railway deployment

The repository includes a production Dockerfile and `railway.json`. The deployed service runs both the Discord bot and the API used by FiveM.

1. In Railway, select **New Project**, **Deploy from GitHub repo**, then choose `Dogerox20/tsp-timeclock`.
2. Add a public domain to the service under **Settings > Networking**.
3. Add a Railway volume mounted at `/data`. This preserves active and pending sessions across redeployments.
4. Add these Railway variables:

   - `API_SECRET`
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_GUILD_ID`
   - `DISCORD_APPROVAL_CHANNEL_ID`
   - `DISCORD_APPROVER_ROLE_IDS`
   - `GOOGLE_SPREADSHEET_ID`
   - `GOOGLE_SERVICE_ACCOUNT_JSON`
   - `ROSTER_SHEET_NAME=Membership Tracker`
   - `ROSTER_START_ROW=9`
   - `ROSTER_NAME_COLUMN=D`
   - `ROSTER_DISCORD_COLUMN=E`
   - `ROSTER_HOURS_COLUMN=G`
   - `HOURS_LOG_SHEET_NAME=Hours`
   - `HOURS_VALUE_MODE=decimal`
   - `DATA_FILE=/data/sessions.json` (optional; Railway also detects the attached volume automatically)

Do not manually set `PORT`; Railway supplies it. Paste the entire downloaded Google service-account JSON into `GOOGLE_SERVICE_ACCOUNT_JSON`. Railway stores it as a secret variable.

After Railway provides a domain, point FiveM at it:

```cfg
set tsp_timeclock_api_url "https://your-service.up.railway.app"
set tsp_timeclock_api_secret "the-same-value-as-railway-api-secret"
ensure tsp-timeclock
```

The Railway health check uses `/health`. A healthy response reports both API availability and whether Discord is connected.

## Behavior and safeguards

- Discord ID must exist on the roster before clock-in.
- A member cannot have two active sessions.
- `/clockout` and disconnect both close the active session.
- Approvals are serialized and session IDs prevent a second button click from adding time twice.
- The roster is checked again at approval time.
- Pending sessions and unposted Discord messages survive service restarts.
- Approved and denied entries are appended to the `Hours` audit tab.

## Test checklist

1. Start the Node service, then the FiveM resource.
2. Run `/clockin` with a rostered Discord account.
3. Run `/clockout` and confirm the Discord message appears.
4. Approve it and confirm both the roster Hours cell and `Hours` audit tab update.
5. Repeat once by disconnecting instead of running `/clockout`.
6. Confirm a non-approver cannot use the Discord buttons.
