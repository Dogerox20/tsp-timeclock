'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { google } = require('googleapis');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits
} = require('discord.js');

const required = [
  'API_SECRET',
  'DISCORD_BOT_TOKEN',
  'DISCORD_GUILD_ID',
  'DISCORD_APPROVAL_CHANNEL_ID',
  'GOOGLE_SPREADSHEET_ID'
];
const missing = required.filter((name) => !process.env[name]);
const hasSplitGoogleCredentials = process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY;
if (!hasSplitGoogleCredentials && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
  missing.push('split Google credentials, GOOGLE_SERVICE_ACCOUNT_JSON, or GOOGLE_SERVICE_ACCOUNT_FILE');
}
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const config = {
  port: Number(process.env.PORT || 3099),
  apiSecret: process.env.API_SECRET,
  guildId: process.env.DISCORD_GUILD_ID,
  approvalChannelId: process.env.DISCORD_APPROVAL_CHANNEL_ID,
  approverRoleIds: new Set((process.env.DISCORD_APPROVER_ROLE_IDS || '').split(',').map((id) => id.trim()).filter(Boolean)),
  spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
  credentialsFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
  credentialsJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  googleClientEmail: process.env.GOOGLE_CLIENT_EMAIL,
  googlePrivateKey: process.env.GOOGLE_PRIVATE_KEY,
  googleProjectId: process.env.GOOGLE_PROJECT_ID,
  rosterSheet: process.env.ROSTER_SHEET_NAME || 'Membership Tracker',
  rosterStartRow: Number(process.env.ROSTER_START_ROW || 9),
  nameColumn: (process.env.ROSTER_NAME_COLUMN || 'D').toUpperCase(),
  discordColumn: (process.env.ROSTER_DISCORD_COLUMN || 'E').toUpperCase(),
  hoursColumn: (process.env.ROSTER_HOURS_COLUMN || 'G').toUpperCase(),
  logSheet: process.env.HOURS_LOG_SHEET_NAME || 'Hours',
  auditLogEnabled: String(process.env.ENABLE_HOURS_AUDIT_LOG || 'false').toLowerCase() === 'true'
};

const dataFile = process.env.DATA_FILE
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH && path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'sessions.json'))
  || path.join(__dirname, 'data', 'sessions.json');
fs.mkdirSync(path.dirname(dataFile), { recursive: true });

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return { sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read session data:', error);
    return { sessions: [] };
  }
}

let state = loadState();
function saveState() {
  const temporary = `${dataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, dataFile);
}

let inlineCredentials;
if (config.googleClientEmail && config.googlePrivateKey) {
  inlineCredentials = {
    type: 'service_account',
    project_id: config.googleProjectId,
    client_email: config.googleClientEmail.trim(),
    private_key: config.googlePrivateKey.replace(/\\n/g, '\n').trim()
  };
} else if (config.credentialsJson) {
  try {
    inlineCredentials = JSON.parse(config.credentialsJson);
  } catch (error) {
    console.error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON:', error.message);
    process.exit(1);
  }
}

const auth = new google.auth.GoogleAuth({
  ...(inlineCredentials ? { credentials: inlineCredentials } : { keyFile: config.credentialsFile }),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });
const discord = new Client({ intents: [GatewayIntentBits.Guilds] });
const app = express();
app.use(express.json({ limit: '32kb' }));

function quoteSheet(name) {
  return `'${String(name).replaceAll("'", "''")}'`;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cleanId(value) {
  const id = String(value || '').replace(/^discord:/, '').trim();
  return /^\d{15,22}$/.test(id) ? id : null;
}

function cleanName(value) {
  return String(value || 'Unknown').replace(/[<>`\r\n]/g, '').trim().slice(0, 80) || 'Unknown';
}

function durationLabel(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

async function rosterMember(discordId) {
  const range = `${quoteSheet(config.rosterSheet)}!${config.nameColumn}${config.rosterStartRow}:${config.discordColumn}`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: config.spreadsheetId, range });
  const rows = response.data.values || [];
  const nameIndex = 0;
  const discordIndex = columnNumber(config.discordColumn) - columnNumber(config.nameColumn);

  for (let index = 0; index < rows.length; index += 1) {
    const rosterId = String(rows[index][discordIndex] || '').replace(/\D/g, '');
    if (rosterId === discordId) {
      return { row: config.rosterStartRow + index, name: cleanName(rows[index][nameIndex]) };
    }
  }
  return null;
}

function columnNumber(column) {
  return [...column].reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0);
}

function approvalComponents(session, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`timeclock:approve:${session.id}`).setLabel('Approve').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`timeclock:deny:${session.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(disabled)
  )];
}

function sessionEmbed(session) {
  const color = session.status === 'approved' ? 0x198754 : session.status === 'denied' ? 0xdc3545 : 0xffc107;
  const embed = new EmbedBuilder()
    .setTitle(`Time Entry • ${session.status.toUpperCase()}`)
    .setColor(color)
    .addFields(
      { name: 'Employee', value: session.rosterName, inline: true },
      { name: 'Discord', value: `<@${session.discordId}>`, inline: true },
      { name: 'Duration', value: durationLabel(session.durationMs), inline: true },
      { name: 'Clock In', value: `<t:${Math.floor(new Date(session.clockIn).getTime() / 1000)}:F>` },
      { name: 'Clock Out', value: `<t:${Math.floor(new Date(session.clockOut).getTime() / 1000)}:F>` },
      { name: 'Ended By', value: session.reason === 'disconnect' ? 'Player disconnected' : session.reason === 'service_restart' ? 'Service restart recovery' : '/clockout' }
    )
    .setFooter({ text: `Session ${session.id}` });

  if (session.reviewedBy) {
    embed.addFields({ name: session.status === 'approved' ? 'Approved By' : 'Denied By', value: `<@${session.reviewedBy}>` });
  }
  return embed;
}

async function postApproval(session) {
  const channel = await discord.channels.fetch(config.approvalChannelId);
  if (!channel || !channel.isTextBased()) throw new Error('The approval channel is not a text channel.');
  const message = await channel.send({ embeds: [sessionEmbed(session)], components: approvalComponents(session) });
  session.discordMessageId = message.id;
  saveState();
}

async function notifyMember(session) {
  try {
    const approved = session.status === 'approved';
    const user = await discord.users.fetch(session.discordId);
    const embed = new EmbedBuilder()
      .setTitle(approved ? 'Time Entry Approved' : 'Time Entry Denied')
      .setColor(approved ? 0x198754 : 0xdc3545)
      .setDescription(approved
        ? 'Your time entry was approved and added to your roster hours.'
        : 'Your time entry was denied and was not added to your roster hours.')
      .addFields(
        { name: 'Duration', value: durationLabel(session.durationMs), inline: true },
        { name: 'Clock In', value: `<t:${Math.floor(new Date(session.clockIn).getTime() / 1000)}:F>` },
        { name: 'Clock Out', value: `<t:${Math.floor(new Date(session.clockOut).getTime() / 1000)}:F>` }
      )
      .setFooter({ text: `Session ${session.id}` });
    await user.send({ embeds: [embed] });
  } catch (error) {
    console.warn(`Could not DM ${session.discordId} about session ${session.id}: ${error.message}`);
  }
}

function canReview(interaction) {
  if (interaction.guildId !== config.guildId) return false;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  return [...config.approverRoleIds].some((roleId) => interaction.member?.roles?.cache?.has(roleId));
}

function parseHours(value) {
  if (typeof value === 'number') return value * 24;
  const text = String(value || '').trim();
  if (!text) return 0;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const match = text.match(/^(\d+):([0-5]\d)(?::([0-5]\d))?$/);
  return match
    ? Number(match[1]) + Number(match[2]) / 60 + Number(match[3] || 0) / 3600
    : 0;
}

let approvalQueue = Promise.resolve();
async function applyApproval(session, adminId) {
  const member = await rosterMember(session.discordId);
  if (!member) throw new Error(`Discord ID ${session.discordId} is no longer on the roster.`);

  const cell = `${quoteSheet(config.rosterSheet)}!${config.hoursColumn}${member.row}`;
  const current = await sheets.spreadsheets.values.get({ spreadsheetId: config.spreadsheetId, range: cell, valueRenderOption: 'UNFORMATTED_VALUE' });
  const existingHours = parseHours(current.data.values?.[0]?.[0]);
  const sessionHours = session.durationMs / 3600000;
  const totalHours = existingHours + sessionHours;
  const sheetValue = totalHours / 24;

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: cell,
    valueInputOption: 'RAW',
    requestBody: { values: [[sheetValue]] }
  });

  const metadata = await sheets.spreadsheets.get({ spreadsheetId: config.spreadsheetId, fields: 'sheets(properties(sheetId,title))' });
  const roster = metadata.data.sheets.find((entry) => entry.properties.title === config.rosterSheet);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: { requests: [{ repeatCell: {
      range: { sheetId: roster.properties.sheetId, startRowIndex: member.row - 1, endRowIndex: member.row, startColumnIndex: columnNumber(config.hoursColumn) - 1, endColumnIndex: columnNumber(config.hoursColumn) },
      cell: { userEnteredFormat: { numberFormat: { type: 'DURATION', pattern: '[h]:mm:ss' } } },
      fields: 'userEnteredFormat.numberFormat'
    } }] }
  });

  session.status = 'approved';
  session.reviewedBy = adminId;
  session.reviewedAt = new Date().toISOString();
  session.approvedHours = sessionHours;
  saveState();
  await notifyMember(session);

  if (config.auditLogEnabled) {
    try {
      await appendAudit(session, member.name, 'Approved', adminId);
    } catch (error) {
      console.error(`Hours were applied, but audit logging failed for ${session.id}:`, error);
    }
  }
}

async function applyDenial(session, adminId) {
  session.status = 'denied';
  session.reviewedBy = adminId;
  session.reviewedAt = new Date().toISOString();
  saveState();
  await notifyMember(session);
  if (config.auditLogEnabled) await appendAudit(session, session.rosterName, 'Denied', adminId);
}

async function appendAudit(session, rosterName, status, adminId) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `${quoteSheet(config.logSheet)}!A:H`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[session.id, session.discordId, rosterName, session.clockIn, session.clockOut, Math.round(session.durationMs / 36000) / 100, status, adminId]] }
  });
}

discord.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() || !interaction.customId.startsWith('timeclock:')) return;
  if (!canReview(interaction)) {
    await interaction.reply({ content: 'You do not have permission to review time entries.', ephemeral: true });
    return;
  }

  const [, action, sessionId] = interaction.customId.split(':');
  const session = state.sessions.find((entry) => entry.id === sessionId);
  if (!session) {
    await interaction.reply({ content: 'That session no longer exists.', ephemeral: true });
    return;
  }
  if (session.status !== 'pending') {
    await interaction.reply({ content: `This entry was already ${session.status}.`, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    approvalQueue = approvalQueue.catch(() => {}).then(() => action === 'approve' ? applyApproval(session, interaction.user.id) : applyDenial(session, interaction.user.id));
    await approvalQueue;
    await interaction.message.edit({ embeds: [sessionEmbed(session)], components: approvalComponents(session, true) });
    await interaction.editReply(`Time entry ${session.status}.`);
  } catch (error) {
    console.error('Review failed:', error);
    await interaction.editReply(`Could not review this entry: ${error.message}`);
  }
});

app.use('/api', (request, response, next) => {
  if (!safeEqual(request.get('X-Timeclock-Secret'), config.apiSecret)) {
    response.status(401).json({ error: 'Unauthorized.' });
    return;
  }
  next();
});

app.get('/health', (_request, response) => response.json({ ok: true, discordReady: discord.isReady() }));

app.post('/api/clockin', async (request, response) => {
  try {
    const discordId = cleanId(request.body.discordId);
    if (!discordId) return response.status(400).json({ error: 'A valid Discord identifier is required.' });
    const existing = state.sessions.find((session) => session.discordId === discordId && session.status === 'active');
    if (existing) return response.status(409).json({ error: 'You are already clocked in.' });
    const member = await rosterMember(discordId);
    if (!member) return response.status(403).json({ error: 'Your Discord ID was not found on the membership roster.' });

    const session = {
      id: crypto.randomUUID(),
      discordId,
      rosterName: member.name,
      playerName: cleanName(request.body.playerName),
      serverId: Number(request.body.serverId) || null,
      clockIn: new Date().toISOString(),
      status: 'active'
    };
    state.sessions.push(session);
    saveState();
    response.status(201).json({ sessionId: session.id, rosterName: session.rosterName });
  } catch (error) {
    console.error('Clock-in failed:', error);
    response.status(500).json({ error: 'Could not verify the membership roster.' });
  }
});

app.post('/api/clockout', async (request, response) => {
  try {
    const discordId = cleanId(request.body.discordId);
    const session = state.sessions.find((entry) => entry.status === 'active' && ((request.body.sessionId && entry.id === request.body.sessionId) || (discordId && entry.discordId === discordId)));
    if (!session) return response.status(404).json({ error: 'No active clock-in was found.' });

    session.clockOut = new Date().toISOString();
    session.durationMs = Math.max(0, new Date(session.clockOut) - new Date(session.clockIn));
    session.reason = ['command', 'disconnect'].includes(request.body.reason) ? request.body.reason : 'command';
    session.status = 'pending';
    saveState();
    try {
      await postApproval(session);
    } catch (error) {
      console.error(`Session ${session.id} is pending but its approval message was not posted yet:`, error);
    }
    response.json({ sessionId: session.id, durationLabel: durationLabel(session.durationMs) });
  } catch (error) {
    console.error('Clock-out failed:', error);
    response.status(500).json({ error: 'The clock-out could not be saved.' });
  }
});

discord.once('clientReady', async () => {
  console.log(`Discord bot ready as ${discord.user.tag}`);
  const unposted = state.sessions.filter((session) => session.status === 'pending' && !session.discordMessageId);
  for (const session of unposted) {
    try { await postApproval(session); } catch (error) { console.error(`Could not repost session ${session.id}:`, error); }
  }
});

app.listen(config.port, '0.0.0.0', () => console.log(`Time-clock API listening on 0.0.0.0:${config.port}`));
discord.login(process.env.DISCORD_BOT_TOKEN);
