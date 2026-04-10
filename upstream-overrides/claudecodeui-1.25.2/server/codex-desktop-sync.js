import { promises as fs } from 'fs';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';

export const CODEX_DRAFT_PLACEHOLDER = `New\u2060 Thread`;
export const CODEX_DRAFT_DISPLAY_TITLE = 'New Thread';

const STATE_DB_PATTERN = /^state_(\d+)\.sqlite$/i;

function normalizeComparablePath(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const resolved = path.resolve(value);
  return process.platform === 'win32'
    ? resolved.replace(/\//g, '\\').toLowerCase()
    : resolved;
}

function stripWindowsLongPathPrefix(filePath) {
  if (typeof filePath !== 'string') {
    return filePath;
  }

  return filePath.startsWith('\\\\?\\')
    ? filePath.slice(4)
    : filePath;
}

function getCodexHomeDir() {
  return path.join(os.homedir(), '.codex');
}

function getCodexSessionsDir() {
  return path.join(getCodexHomeDir(), 'sessions');
}

function getCodexArchivedSessionsDir() {
  return path.join(getCodexHomeDir(), 'archived_sessions');
}

function getLocalTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function formatCurrentDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatRolloutPathTimestamp(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}`;
}

function getRolloutRelativePath(date, sessionId) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return path.join(year, month, day, `rollout-${formatRolloutPathTimestamp(date)}-${sessionId}.jsonl`);
}

function generateUuidV7(date = new Date()) {
  const timestampHex = BigInt(date.getTime()).toString(16).padStart(12, '0');
  const randomHex = crypto.randomBytes(10).toString('hex');
  const variantNibble = ((parseInt(randomHex[3], 16) & 0x3) | 0x8).toString(16);

  return [
    timestampHex.slice(0, 8),
    timestampHex.slice(8, 12),
    `7${randomHex.slice(0, 3)}`,
    `${variantNibble}${randomHex.slice(4, 7)}`,
    randomHex.slice(7, 19),
  ].join('-');
}

function parseSqliteDefaultValue(rawValue) {
  if (rawValue == null) {
    return null;
  }

  const value = String(rawValue).trim();
  if (value.toUpperCase() === 'NULL') {
    return null;
  }

  if (/^'.*'$/.test(value)) {
    return value.slice(1, -1).replace(/''/g, '\'');
  }

  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }

  return null;
}

function findLatestStateDbPath() {
  const codexHomeDir = getCodexHomeDir();

  if (!fsSync.existsSync(codexHomeDir)) {
    return null;
  }

  const entries = fsSync.readdirSync(codexHomeDir, { withFileTypes: true });
  const stateFiles = entries
    .filter((entry) => entry.isFile() && STATE_DB_PATTERN.test(entry.name))
    .map((entry) => {
      const match = entry.name.match(STATE_DB_PATTERN);
      return {
        version: Number(match?.[1] || 0),
        fullPath: path.join(codexHomeDir, entry.name),
      };
    })
    .sort((left, right) => right.version - left.version);

  return stateFiles[0]?.fullPath || null;
}

function openStateDb() {
  const stateDbPath = findLatestStateDbPath();
  if (!stateDbPath) {
    return null;
  }

  const db = new Database(stateDbPath);
  db.pragma('busy_timeout = 3000');
  return db;
}

function getThreadTableColumns(db) {
  return db.prepare('PRAGMA table_info(threads)').all();
}

function getThreadRowById(db, sessionId) {
  return db.prepare('SELECT * FROM threads WHERE id = ? LIMIT 1').get(sessionId) || null;
}

function getRecentThreadRows(db, limit = 50) {
  return db.prepare(
    'SELECT * FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?',
  ).all(limit);
}

function buildFallbackThreadRow(columnInfo, values) {
  const gitInfo = values.gitInfo || {};
  const row = {};

  for (const column of columnInfo) {
    row[column.name] = parseSqliteDefaultValue(column.dflt_value);
  }

  row.id = values.sessionId;
  row.rollout_path = values.rolloutPath ?? values.rollout_path ?? row.rollout_path ?? null;
  row.created_at = values.createdAtSec ?? values.created_at ?? row.created_at ?? null;
  row.updated_at = values.updatedAtSec ?? values.updated_at ?? row.updated_at ?? null;
  row.source = values.source ?? row.source ?? 'vscode';
  row.model_provider = values.modelProvider ?? values.model_provider ?? row.model_provider ?? 'openai';
  row.cwd = values.cwd ?? row.cwd ?? null;
  row.title = values.title ?? row.title ?? null;
  row.sandbox_policy = values.sandboxPolicyJson ?? values.sandbox_policy ?? row.sandbox_policy ?? '{"type":"danger-full-access"}';
  row.approval_mode = values.approvalMode ?? values.approval_mode ?? row.approval_mode ?? 'never';
  row.tokens_used = values.tokensUsed ?? values.tokens_used ?? row.tokens_used ?? 0;
  row.has_user_event = values.hasUserEvent ?? values.has_user_event ?? row.has_user_event ?? 0;
  row.archived = values.archived ?? row.archived ?? 0;
  row.archived_at = values.archivedAt ?? values.archived_at ?? row.archived_at ?? null;
  row.git_sha = gitInfo.sha ?? values.git_sha ?? row.git_sha ?? null;
  row.git_branch = gitInfo.branch ?? values.git_branch ?? row.git_branch ?? null;
  row.git_origin_url = gitInfo.originUrl ?? values.git_origin_url ?? row.git_origin_url ?? null;
  row.cli_version = values.cliVersion ?? values.cli_version ?? row.cli_version ?? '';
  row.first_user_message = values.firstUserMessage ?? values.first_user_message ?? values.title ?? row.first_user_message ?? null;
  row.agent_nickname = values.agent_nickname ?? row.agent_nickname ?? null;
  row.agent_role = values.agent_role ?? row.agent_role ?? null;
  row.memory_mode = values.memory_mode ?? row.memory_mode ?? 'enabled';
  row.model = values.model ?? row.model ?? null;
  row.reasoning_effort = values.reasoningEffort ?? values.reasoning_effort ?? row.reasoning_effort ?? null;
  row.agent_path = values.agent_path ?? row.agent_path ?? null;

  return row;
}

function upsertThreadRow(db, row) {
  const columns = getThreadTableColumns(db).map((column) => column.name);
  const assignments = columns
    .filter((column) => column !== 'id')
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');

  const sql = `
    INSERT INTO threads (${columns.join(', ')})
    VALUES (${columns.map((column) => `@${column}`).join(', ')})
    ON CONFLICT(id) DO UPDATE SET ${assignments}
  `;

  db.prepare(sql).run(row);
}

function extractMessageText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) => {
      if (item?.type === 'input_text' || item?.type === 'output_text' || item?.type === 'text') {
        return item.text || '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function replaceMessageText(entry, text) {
  const nextEntry = structuredClone(entry);
  const payload = nextEntry?.payload;

  if (!payload || payload.type !== 'message') {
    return nextEntry;
  }

  payload.content = [{ type: 'input_text', text }];
  return nextEntry;
}

function buildEnvironmentContextBlock(projectPath, date) {
  return [
    '<environment_context>',
    `  <cwd>${projectPath}</cwd>`,
    `  <shell>${process.platform === 'win32' ? 'powershell' : 'bash'}</shell>`,
    `  <current_date>${formatCurrentDate(date)}</current_date>`,
    `  <timezone>${getLocalTimezone()}</timezone>`,
    '</environment_context>',
  ].join('\n');
}

function getGitInfo(projectPath) {
  const runGit = (args) => {
    const result = spawnSync('git', args, {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true,
    });

    if (result.status !== 0) {
      return null;
    }

    const output = result.stdout?.trim();
    return output || null;
  };

  try {
    const sha = runGit(['rev-parse', 'HEAD']);
    const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    const originUrl = runGit(['config', '--get', 'remote.origin.url']);

    if (!sha && !branch && !originUrl) {
      return null;
    }

    return { sha, branch, originUrl };
  } catch {
    return null;
  }
}

function isVisibleUserMessageEntry(entry) {
  return (
    entry?.type === 'event_msg' &&
    entry.payload?.type === 'user_message' &&
    typeof entry.payload.message === 'string' &&
    entry.payload.message.trim().length > 0
  );
}

async function readCodexThreadMetadata(filePath) {
  const stat = await fs.stat(filePath);
  const fileStream = fsSync.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let sessionMeta = null;
  let firstTurnContext = null;
  let firstUserMessage = null;
  let lastTimestamp = null;
  let totalTokens = null;

  try {
    for await (const rawLine of rl) {
      if (!rawLine.trim()) {
        continue;
      }

      let entry;
      try {
        entry = JSON.parse(rawLine);
      } catch {
        continue;
      }

      if (entry.timestamp) {
        lastTimestamp = entry.timestamp;
      }

      if (entry.type === 'session_meta' && entry.payload && !sessionMeta) {
        sessionMeta = entry.payload;
      }

      if (entry.type === 'turn_context' && entry.payload && !firstTurnContext) {
        firstTurnContext = entry.payload;
      }

      if (!firstUserMessage && isVisibleUserMessageEntry(entry)) {
        firstUserMessage = normalizeCodexThreadTitle(entry.payload.message);
      }

      if (
        entry.type === 'event_msg' &&
        entry.payload?.type === 'token_count' &&
        entry.payload?.info?.total_token_usage?.total_tokens != null
      ) {
        totalTokens = entry.payload.info.total_token_usage.total_tokens;
      }
    }
  } finally {
    rl.close();
  }

  const createdAtMs = sessionMeta?.timestamp
    ? Date.parse(sessionMeta.timestamp)
    : stat.mtimeMs;
  const updatedAtMs = lastTimestamp
    ? Date.parse(lastTimestamp)
    : stat.mtimeMs;

  return {
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : stat.mtimeMs,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : stat.mtimeMs,
    cwd: sessionMeta?.cwd || firstTurnContext?.cwd || null,
    source: sessionMeta?.source || null,
    modelProvider: sessionMeta?.model_provider || null,
    cliVersion: sessionMeta?.cli_version || null,
    model: firstTurnContext?.model || null,
    reasoningEffort: firstTurnContext?.effort || null,
    sandboxPolicyJson: firstTurnContext?.sandbox_policy
      ? JSON.stringify(firstTurnContext.sandbox_policy)
      : null,
    approvalMode: firstTurnContext?.approval_policy || null,
    firstUserMessage: firstUserMessage || CODEX_DRAFT_DISPLAY_TITLE,
    totalTokens,
  };
}

async function searchRolloutFileById(rootDir, sessionId) {
  if (!rootDir || !fsSync.existsSync(rootDir)) {
    return null;
  }

  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries;

    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
        return fullPath;
      }
    }
  }

  return null;
}

async function findCodexRolloutPath(sessionId, options = {}) {
  const { includeArchived = true } = options;
  let db;

  try {
    db = openStateDb();
    if (db) {
      const row = getThreadRowById(db, sessionId);
      const dbPath = stripWindowsLongPathPrefix(row?.rollout_path);

      if (dbPath && fsSync.existsSync(dbPath)) {
        return dbPath;
      }
    }
  } finally {
    db?.close();
  }

  const directMatch = await searchRolloutFileById(getCodexSessionsDir(), sessionId);
  if (directMatch) {
    return directMatch;
  }

  if (includeArchived) {
    return searchRolloutFileById(getCodexArchivedSessionsDir(), sessionId);
  }

  return null;
}

async function readDraftTemplateEntries(filePath) {
  const fileStream = fsSync.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const entries = [];
  let sawTurnContext = false;
  let sawUserMessage = false;

  try {
    for await (const rawLine of rl) {
      if (!rawLine.trim()) {
        continue;
      }

      const entry = JSON.parse(rawLine);
      entries.push(entry);

      if (entry.type === 'turn_context') {
        sawTurnContext = true;
      }

      if (isVisibleUserMessageEntry(entry)) {
        sawUserMessage = true;
      }

      if (sawTurnContext && sawUserMessage) {
        break;
      }
    }
  } finally {
    rl.close();
  }

  return entries;
}

function createFallbackTemplateEntries(projectPath, sessionId, turnId, date) {
  const timestamp = date.toISOString();
  const environmentContext = buildEnvironmentContextBlock(projectPath, date);

  return [
    {
      timestamp,
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp,
        cwd: projectPath,
        originator: 'Codex Desktop',
        cli_version: '',
        source: 'vscode',
        model_provider: 'openai',
      },
    },
    {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: environmentContext }],
      },
    },
    {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: CODEX_DRAFT_PLACEHOLDER }],
      },
    },
    {
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: turnId,
      },
    },
    {
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: CODEX_DRAFT_PLACEHOLDER,
        images: [],
        local_images: [],
        text_elements: [],
      },
    },
    {
      timestamp,
      type: 'turn_context',
      payload: {
        turn_id: turnId,
        cwd: projectPath,
        current_date: formatCurrentDate(date),
        timezone: getLocalTimezone(),
        approval_policy: 'never',
        sandbox_policy: { type: 'danger-full-access' },
        model: null,
      },
    },
  ];
}

function transformDraftTemplate(entries, projectPath, date) {
  const sessionId = generateUuidV7(date);
  const turnId = generateUuidV7(date);
  const timestamp = date.toISOString();
  const environmentContext = buildEnvironmentContextBlock(projectPath, date);
  const gitInfo = getGitInfo(projectPath);
  const nextEntries = entries.map((entry) => structuredClone(entry));

  const firstPromptIndex = nextEntries.findIndex((entry) => isVisibleUserMessageEntry(entry));
  const lastPromptResponseIndex = nextEntries.reduce((lastMatch, entry, index) => {
    if (entry?.type !== 'response_item' || entry.payload?.type !== 'message' || entry.payload?.role !== 'user') {
      return lastMatch;
    }

    if (firstPromptIndex === -1 || index >= firstPromptIndex) {
      return index;
    }

    const text = extractMessageText(entry.payload.content);
    if (text.includes('<environment_context>')) {
      return lastMatch;
    }

    return index;
  }, -1);

  for (let index = 0; index < nextEntries.length; index += 1) {
    const entry = nextEntries[index];
    entry.timestamp = timestamp;

    if (entry.type === 'session_meta' && entry.payload) {
      entry.payload.id = sessionId;
      entry.payload.timestamp = timestamp;
      entry.payload.cwd = projectPath;
      if (gitInfo) {
        entry.payload.git = gitInfo;
      }
      continue;
    }

    if (entry.type === 'event_msg' && entry.payload?.type === 'task_started') {
      entry.payload.turn_id = turnId;
      continue;
    }

    if (entry.type === 'turn_context' && entry.payload) {
      entry.payload.turn_id = turnId;
      entry.payload.cwd = projectPath;
      entry.payload.current_date = formatCurrentDate(date);
      entry.payload.timezone = getLocalTimezone();
      continue;
    }

    if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'user') {
      const text = extractMessageText(entry.payload.content);
      if (text.includes('<environment_context>')) {
        nextEntries[index] = replaceMessageText(entry, environmentContext);
      } else if (index === lastPromptResponseIndex) {
        nextEntries[index] = replaceMessageText(entry, CODEX_DRAFT_PLACEHOLDER);
      }
      continue;
    }

    if (isVisibleUserMessageEntry(entry)) {
      entry.payload.message = CODEX_DRAFT_PLACEHOLDER;
      entry.payload.images = [];
      entry.payload.local_images = [];
      entry.payload.text_elements = [];
    }
  }

  return { sessionId, entries: nextEntries };
}

async function loadDraftTemplate(projectPath, date) {
  const normalizedProjectPath = normalizeComparablePath(projectPath);
  let templateRow = null;
  let templateFilePath = null;
  let db;

  try {
    db = openStateDb();
    if (db) {
      const recentRows = getRecentThreadRows(db, 100)
        .map((row) => ({
          ...row,
          rollout_path: stripWindowsLongPathPrefix(row.rollout_path),
        }))
        .filter((row) => row.rollout_path && fsSync.existsSync(row.rollout_path));

      templateRow =
        recentRows.find((row) => normalizeComparablePath(row.cwd) === normalizedProjectPath) ||
        recentRows[0] ||
        null;

      templateFilePath = templateRow?.rollout_path || null;
    }
  } finally {
    db?.close();
  }

  if (templateFilePath) {
    const templateEntries = await readDraftTemplateEntries(templateFilePath);
    if (templateEntries.length > 0) {
      return { templateEntries, templateRow };
    }
  }

  const fallbackSessionId = generateUuidV7(date);
  const fallbackTurnId = generateUuidV7(date);
  return {
    templateEntries: createFallbackTemplateEntries(projectPath, fallbackSessionId, fallbackTurnId, date),
    templateRow: null,
  };
}

export function isCodexDraftPlaceholderMessage(message) {
  return typeof message === 'string' && message === CODEX_DRAFT_PLACEHOLDER;
}

export function normalizeCodexThreadTitle(message) {
  if (typeof message !== 'string') {
    return null;
  }

  return isCodexDraftPlaceholderMessage(message)
    ? CODEX_DRAFT_DISPLAY_TITLE
    : message;
}

export async function syncCodexThreadState(sessionId, options = {}) {
  const {
    rolloutPath = null,
    preferredProjectPath = null,
    templateRow = null,
    createdAtSec = null,
    updatedAtSec = null,
  } = options;

  const resolvedRolloutPath = rolloutPath || await findCodexRolloutPath(sessionId);
  if (!resolvedRolloutPath || !fsSync.existsSync(resolvedRolloutPath)) {
    return false;
  }

  let db;
  try {
    db = openStateDb();
    if (!db) {
      return false;
    }

    const metadata = await readCodexThreadMetadata(resolvedRolloutPath);
    const gitInfo = getGitInfo(preferredProjectPath || metadata.cwd || templateRow?.cwd || process.cwd());
    const existingRow = getThreadRowById(db, sessionId);
    const columns = getThreadTableColumns(db);
    const baseRow = existingRow || templateRow || buildFallbackThreadRow(columns, {
      sessionId,
      rolloutPath: resolvedRolloutPath,
      createdAtSec: createdAtSec ?? Math.floor(metadata.createdAtMs / 1000),
      updatedAtSec: updatedAtSec ?? Math.floor(metadata.updatedAtMs / 1000),
      cwd: preferredProjectPath || metadata.cwd || process.cwd(),
      title: metadata.firstUserMessage || CODEX_DRAFT_DISPLAY_TITLE,
      firstUserMessage: metadata.firstUserMessage || CODEX_DRAFT_DISPLAY_TITLE,
      source: metadata.source,
      modelProvider: metadata.modelProvider,
      cliVersion: metadata.cliVersion,
      model: metadata.model,
      reasoningEffort: metadata.reasoningEffort,
      sandboxPolicyJson: metadata.sandboxPolicyJson,
      approvalMode: metadata.approvalMode,
      gitInfo,
      tokensUsed: metadata.totalTokens ?? 0,
    });

    const row = buildFallbackThreadRow(columns, {
      ...baseRow,
      sessionId,
      rolloutPath: resolvedRolloutPath,
      createdAtSec: existingRow?.created_at ?? createdAtSec ?? Math.floor(metadata.createdAtMs / 1000),
      updatedAtSec: updatedAtSec ?? Math.floor(metadata.updatedAtMs / 1000),
      cwd: preferredProjectPath || metadata.cwd || existingRow?.cwd || templateRow?.cwd || process.cwd(),
      title: metadata.firstUserMessage || existingRow?.title || templateRow?.title || CODEX_DRAFT_DISPLAY_TITLE,
      firstUserMessage:
        metadata.firstUserMessage ||
        existingRow?.first_user_message ||
        templateRow?.first_user_message ||
        CODEX_DRAFT_DISPLAY_TITLE,
      source: metadata.source || existingRow?.source || templateRow?.source || 'vscode',
      modelProvider: metadata.modelProvider || existingRow?.model_provider || templateRow?.model_provider || 'openai',
      cliVersion: metadata.cliVersion || existingRow?.cli_version || templateRow?.cli_version || '',
      model: metadata.model || existingRow?.model || templateRow?.model || null,
      reasoningEffort:
        metadata.reasoningEffort ||
        existingRow?.reasoning_effort ||
        templateRow?.reasoning_effort ||
        null,
      sandboxPolicyJson:
        metadata.sandboxPolicyJson ||
        existingRow?.sandbox_policy ||
        templateRow?.sandbox_policy ||
        '{"type":"danger-full-access"}',
      approvalMode:
        metadata.approvalMode ||
        existingRow?.approval_mode ||
        templateRow?.approval_mode ||
        'never',
      gitInfo: gitInfo || {
        sha: existingRow?.git_sha || templateRow?.git_sha || null,
        branch: existingRow?.git_branch || templateRow?.git_branch || null,
        originUrl: existingRow?.git_origin_url || templateRow?.git_origin_url || null,
      },
      tokensUsed: metadata.totalTokens ?? existingRow?.tokens_used ?? templateRow?.tokens_used ?? 0,
      archived: existingRow?.archived ?? templateRow?.archived ?? 0,
      archivedAt: existingRow?.archived_at ?? templateRow?.archived_at ?? null,
      hasUserEvent: existingRow?.has_user_event ?? templateRow?.has_user_event ?? 0,
    });

    upsertThreadRow(db, row);
    return true;
  } catch (error) {
    console.warn('[Codex Sync] Failed to sync thread state:', error.message);
    return false;
  } finally {
    db?.close();
  }
}

export async function createCodexDraftSession(projectPath) {
  const resolvedProjectPath = path.resolve(projectPath);
  await fs.access(resolvedProjectPath);
  const now = new Date();
  const { templateEntries, templateRow } = await loadDraftTemplate(resolvedProjectPath, now);
  const { sessionId, entries } = transformDraftTemplate(templateEntries, resolvedProjectPath, now);
  const finalRolloutPath = path.join(getCodexSessionsDir(), getRolloutRelativePath(now, sessionId));

  await fs.mkdir(path.dirname(finalRolloutPath), { recursive: true });
  await fs.writeFile(
    finalRolloutPath,
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );

  await syncCodexThreadState(sessionId, {
    rolloutPath: finalRolloutPath,
    preferredProjectPath: resolvedProjectPath,
    templateRow,
    createdAtSec: Math.floor(now.getTime() / 1000),
    updatedAtSec: Math.floor(now.getTime() / 1000),
  });

  return {
    sessionId,
    rolloutPath: finalRolloutPath,
    displayTitle: CODEX_DRAFT_DISPLAY_TITLE,
  };
}

export async function archiveCodexSession(sessionId) {
  const sourcePath = await findCodexRolloutPath(sessionId, { includeArchived: false });
  if (!sourcePath || !fsSync.existsSync(sourcePath)) {
    return false;
  }

  const sessionsDir = getCodexSessionsDir();
  const archivedDir = getCodexArchivedSessionsDir();
  const relativePath = path.relative(sessionsDir, sourcePath);
  const destinationPath = relativePath && !relativePath.startsWith('..')
    ? path.join(archivedDir, relativePath)
    : path.join(archivedDir, path.basename(sourcePath));

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.rename(sourcePath, destinationPath);

  let db;
  try {
    db = openStateDb();
    if (db) {
      const existingRow = getThreadRowById(db, sessionId);
      const columns = getThreadTableColumns(db);
      const nowSec = Math.floor(Date.now() / 1000);
      const row = buildFallbackThreadRow(columns, {
        ...(existingRow || {}),
        sessionId,
        rolloutPath: destinationPath,
        createdAtSec: existingRow?.created_at ?? nowSec,
        updatedAtSec: nowSec,
        cwd: existingRow?.cwd || process.cwd(),
        title: existingRow?.title || CODEX_DRAFT_DISPLAY_TITLE,
        firstUserMessage: existingRow?.first_user_message || CODEX_DRAFT_DISPLAY_TITLE,
        source: existingRow?.source || 'vscode',
        modelProvider: existingRow?.model_provider || 'openai',
        cliVersion: existingRow?.cli_version || '',
        model: existingRow?.model || null,
        reasoningEffort: existingRow?.reasoning_effort || null,
        sandboxPolicyJson: existingRow?.sandbox_policy || '{"type":"danger-full-access"}',
        approvalMode: existingRow?.approval_mode || 'never',
        gitInfo: {
          sha: existingRow?.git_sha || null,
          branch: existingRow?.git_branch || null,
          originUrl: existingRow?.git_origin_url || null,
        },
        tokensUsed: existingRow?.tokens_used ?? 0,
        archived: 1,
        archivedAt: nowSec,
        hasUserEvent: existingRow?.has_user_event ?? 0,
      });

      upsertThreadRow(db, row);
    }
  } catch (error) {
    console.warn('[Codex Sync] Failed to update archive state:', error.message);
  } finally {
    db?.close();
  }

  return true;
}
