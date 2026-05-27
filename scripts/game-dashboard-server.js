#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dashboardRoot = path.resolve(__dirname, '..');
const dashboardObstacleCatalogPath = path.join(dashboardRoot, 'shared', 'obstacle-catalog.json');
const marbleRaceObstacleCatalogPath = path.resolve(dashboardRoot, '..', 'marble-race', 'src', 'obstacle-catalog.json');
if (existsSync(marbleRaceObstacleCatalogPath)) {
  mkdirSync(path.dirname(dashboardObstacleCatalogPath), { recursive: true });
  copyFileSync(marbleRaceObstacleCatalogPath, dashboardObstacleCatalogPath);
}
const obstacleCatalogData = JSON.parse(readFileSync(dashboardObstacleCatalogPath, 'utf8'));
const configPath = process.env.GAME_DASHBOARD_CONFIG || path.join(dashboardRoot, 'config', 'games.json');
const dashboardConfig = JSON.parse(readFileSync(configPath, 'utf8'));
const PORT = Number(process.env.GAME_DASHBOARD_PORT || process.env.MARBLE_DASHBOARD_PORT || dashboardConfig.dashboard?.port || 8888);
const HOST = process.env.GAME_DASHBOARD_HOST || process.env.MARBLE_DASHBOARD_HOST || dashboardConfig.dashboard?.host || '127.0.0.1';
const HTTPS_ENABLED = ['1', 'true', 'yes', 'on'].includes(String(process.env.GAME_DASHBOARD_HTTPS || process.env.MARBLE_DASHBOARD_HTTPS || '').toLowerCase());
const HTTPS_CERT_PATH = process.env.GAME_DASHBOARD_HTTPS_CERT || process.env.MARBLE_DASHBOARD_HTTPS_CERT || dashboardConfig.dashboard?.httpsCert || '';
const HTTPS_KEY_PATH = process.env.GAME_DASHBOARD_HTTPS_KEY || process.env.MARBLE_DASHBOARD_HTTPS_KEY || dashboardConfig.dashboard?.httpsKey || '';
const DASHBOARD_PASSWORD = String(process.env.GAME_DASHBOARD_PASSWORD || process.env.MARBLE_DASHBOARD_PASSWORD || dashboardConfig.dashboard?.password || '');
const DASHBOARD_AUTH_USER = String(process.env.GAME_DASHBOARD_AUTH_USER || process.env.MARBLE_DASHBOARD_AUTH_USER || dashboardConfig.dashboard?.authUser || 'bert');
const DASHBOARD_LAUNCH_AGENT_LABEL = process.env.GAME_DASHBOARD_LAUNCH_AGENT_LABEL || 'com.bert.game-dashboard';
const DASHBOARD_LAUNCH_AGENT_PLIST = process.env.GAME_DASHBOARD_LAUNCH_AGENT_PLIST || '/Users/bert/Library/LaunchAgents/com.bert.game-dashboard.plist';
const RENDER_PORT_START = Number(process.env.GAME_RENDER_PORT_START || process.env.MARBLE_RENDER_PORT_START || dashboardConfig.dashboard?.renderPortStart || 4300);
const games = (dashboardConfig.games || []).map((game) => {
  const projectRoot = path.resolve(game.projectRoot);
  const server = game.server || {};
  return {
    ...game,
    projectRoot,
    recordingsDir: path.resolve(game.recordingsDir || path.join(projectRoot, 'recordings')),
    server: {
      host: server.host || '127.0.0.1',
      port: Number(server.port || 5173),
      url: server.url || `http://${server.host || '127.0.0.1'}:${Number(server.port || 5173)}`,
      startCommand: server.startCommand || 'npm run dev -- --host 127.0.0.1 --port 5173',
    },
    render: {
      command: game.render?.command || 'npm run render:auto-cup',
    },
    thumbnail: {
      command: game.thumbnail?.command || 'node scripts/generate-youtube-thumbnail.js',
    },
  };
});
const activeGame = games[0];
if (!activeGame) throw new Error(`No games configured in ${configPath}`);
const rootDir = activeGame.projectRoot;
const recordingsDir = activeGame.recordingsDir;
const ACTIVE_SERVER_HOST = activeGame.server.host;
const ACTIVE_SERVER_PORT = activeGame.server.port;
const ACTIVE_SERVER_URL = activeGame.server.url;
const scheduleDataDir = path.join(dashboardRoot, 'data');
const schedulePath = process.env.GAME_DASHBOARD_SCHEDULE_PATH || path.join(scheduleDataDir, 'schedule.json');
const scheduleRunStatePath = process.env.GAME_DASHBOARD_SCHEDULE_RUN_STATE_PATH || path.join(scheduleDataDir, 'schedule-runs.json');
const SCHEDULE_WORKER_INTERVAL_MS = Math.max(60_000, Number(process.env.GAME_DASHBOARD_SCHEDULE_INTERVAL_MS || 5 * 60_000));
const SCHEDULE_WEEKDAYS = [
  { value: 1, key: 'mon', label: 'Mon', zh: '星期一' },
  { value: 2, key: 'tue', label: 'Tue', zh: '星期二' },
  { value: 3, key: 'wed', label: 'Wed', zh: '星期三' },
  { value: 4, key: 'thu', label: 'Thu', zh: '星期四' },
  { value: 5, key: 'fri', label: 'Fri', zh: '星期五' },
  { value: 6, key: 'sat', label: 'Sat', zh: '星期六' },
  { value: 0, key: 'sun', label: 'Sun', zh: '星期日' },
];
const SCHEDULE_RECURRENCES = [
  { value: 'weekly', label: 'Weekly', zh: '每週' },
  { value: 'daily', label: 'Daily', zh: '每日' },
];

mkdirSync(recordingsDir, { recursive: true });
mkdirSync(scheduleDataDir, { recursive: true });

const LOCAL_DASHBOARD_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function requestHostName(req) {
  const rawHost = String(req.headers.host || '').trim().toLowerCase();
  if (!rawHost) return '';
  if (rawHost.startsWith('[')) return rawHost.slice(0, rawHost.indexOf(']') + 1);
  return rawHost.split(':')[0];
}

function isLocalDashboardRequest(req) {
  const hostName = requestHostName(req);
  return !hostName || LOCAL_DASHBOARD_HOSTS.has(hostName);
}

function safeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hasValidDashboardPassword(req) {
  const header = String(req.headers.authorization || '');
  if (!header.toLowerCase().startsWith('basic ')) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return safeEqualString(user, DASHBOARD_AUTH_USER) && safeEqualString(password, DASHBOARD_PASSWORD);
}

function requireDashboardAuth(req, res) {
  if (isLocalDashboardRequest(req)) return true;
  if (!DASHBOARD_PASSWORD) {
    res.writeHead(403, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end('Remote dashboard access is disabled until GAME_DASHBOARD_PASSWORD is configured.\n');
    return false;
  }
  if (hasValidDashboardPassword(req)) return true;
  res.writeHead(401, {
    'www-authenticate': 'Basic realm="Game Dashboard", charset="UTF-8"',
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end('Password required for non-local dashboard access.\n');
  return false;
}

const OBSTACLE_CATEGORIES = obstacleCatalogData.categories;
const OBSTACLE_TYPES = obstacleCatalogData.types;

const OBSTACLE_DISTRIBUTION_MODES = [
  { value: 'random', label: '完全隨機', description: 'Each obstacle independently picks a random enabled type and distance.' },
  { value: 'zoned', label: '障礙物分區', description: 'Track length is split into zones; each zone uses one obstacle type only.' },
];

const BACKGROUND_RECORD_MODES = [
  { value: 'continuous', key: 'multiple', label: 'Multiple', description: 'Background record several single races; regenerate track between races.' },
  { value: 'cup', key: 'cup', label: 'Cup Mode', description: 'Background tournament render using QF / SF / Final timing.' },
];

const DENSITY_PRESETS = [
  { value: 'none', label: 'None / 無' },
  { value: 'standard', label: 'Standard / 標準' },
  { value: 'many', label: 'Many / 多' },
  { value: 'extreme', label: 'Extreme / 高密度' },
];

const SCHEDULE_ACTIONS = [
  {
    value: 'youtube-marble-long-video',
    label: 'Youtube - Marble Long Video',
    description: 'Generate and upload a 10-minute horizontal Marble Rush video.',
    payload: {
      game: 'marble-rush',
      kind: 'youtube-upload',
      titleHint: 'Marble Long Video',
      dynamicAttributes: {
        multipleRaceCount: { strategy: 'randomInt', min: 6, max: 10 },
        obstacleTypes: { strategy: 'randomSample', count: 4, source: 'availableObstacleTypes' },
      },
      renderOptions: {
        recordMode: 'continuous',
        multipleRaceCount: { dynamic: 'randomInt', min: 6, max: 10 },
        lengthMode: 'target-duration',
        targetMinutes: 10,
        targetSeconds: 600,
        trackLength: 350,
        stageTrackLabel: 'Unified 350m',
        density: 'many',
        obstacleDistribution: 'random',
        obstacleTypes: { dynamic: 'randomSample', count: 4, source: 'availableObstacleTypes' },
        format: 'mp4',
        comparisonWebm: true,
        videoCapture: 'canvas',
        videoCanvasLayout: 'horizontal',
        thumbnail: true,
        uploadYoutube: true,
        youtubePrivacy: 'public',
        qualityPreset: '1080p-smooth',
        qualityLabel: '1080p Smooth · 1920×1080 · 60fps · CRF18 · veryfast',
        width: 1920,
        height: 1080,
        fps: 60,
        crf: 18,
        captureScale: 1,
        videoPreset: 'veryfast',
        ttsVoice: 'Alex',
        renderPort: 4300,
      },
    },
  },
  {
    value: 'youtube-marble-short-video',
    label: 'Youtube - Marble Short Video',
    description: 'Generate and upload a 1-3 minute vertical Marble Rush short.',
    payload: {
      game: 'marble-rush',
      kind: 'youtube-upload',
      titleHint: 'Marble Short Video',
      dynamicAttributes: {
        trackLength: { strategy: 'randomInt', min: 300, max: 500, step: 10 },
        obstacleTypes: { strategy: 'randomSample', count: 4, source: 'availableObstacleTypes' },
      },
      renderOptions: {
        recordMode: 'continuous',
        multipleRaceCount: 1,
        lengthMode: 'target-duration',
        targetMinutes: 3,
        targetSeconds: 180,
        trackLength: { dynamic: 'randomInt', min: 300, max: 500, step: 10 },
        density: 'many',
        obstacleDistribution: 'random',
        obstacleTypes: { dynamic: 'randomSample', count: 4, source: 'availableObstacleTypes' },
        format: 'mp4',
        comparisonWebm: true,
        videoCapture: 'canvas',
        videoCanvasLayout: 'vertical',
        thumbnail: true,
        uploadYoutube: true,
        youtubePrivacy: 'public',
        qualityPreset: '1080p-smooth',
        qualityLabel: '1080p Smooth · 1080×1920 · 60fps · CRF18 · veryfast',
        width: 1080,
        height: 1920,
        fps: 60,
        crf: 18,
        captureScale: 1,
        videoPreset: 'veryfast',
        ttsVoice: 'Alex',
        renderPort: 4300,
      },
    },
  },
];


const THUMBNAIL_TITLE_PRESETS = [
  '30 Marbles, 1 Winner',
  '30 Marbles Race!',
  'Marble Race Chaos!',
  'Insane Marble Race!',
  'Will It Crash?',
  'Crazy Marble Race!',
  'Marble Rush!',
  'Big Marble Race!',
  'Fast Marble Race!',
  'Epic Marble Battle!',
  'Marble Race Challenge!',
  'Can It Win?',
  '30 Marbles vs Track!',
  'Marble Madness!',
  'Race to the Finish!',
  'Ultimate Marble Race!',
  'New Obstacle!',
  'New Marble Challenge!',
  'Marble Race Update!',
  'Unexpected Marble Win!',
  'Huge Marble Chaos!',
  'Marble Track Mayhem!',
  'Only 1 Marble Wins!',
  'Can the Marble Survive?',
  'The Craziest Race!',
  'Marble Race FAIL?!',
  'One Race, Many Marbles',
  'Speed Marble Battle!',
  'Marble Race in Action!',
  'Best Marble Race Yet!',
  'Last Marble Standing!',
  'Impossible Marble Run!',
  'This Track Is Wild!',
  'Marble Disaster Incoming!',
  'No Way It Wins!',
  'Tiny Marble, Big Race!',
  'Watch This Marble!',
  'Rainbow Marble Battle!',
  'Marble Knockout!',
  'Don’t Fall Off!',
  'Super Marble Race!',
  'Marble Power Run!',
  'Toy Marble Showdown!',
  'Fun Marble Challenge!',
  'Happy Marble Race!',
  'Boss Level Marble!',
  'Marble Royale!',
  'Track Battle Begins!',
  'Marble Speedrun!',
  'Final Marble Wins!',
  'Beat This Track!',
  'Impossible Track Challenge!',
  'Can It Finish?',
  'Survive the Track!',
  'One Marble Challenge!',
  'Who Will Survive?',
  'Wait For It!',
  'The Ending Is Crazy!',
  'Will It Make It?',
  'Nobody Saw This!',
  'First Hit Chaos!',
  'Crash or Win?',
  'Marble Trap Test!',
  'Sudden Marble Comeback!',
  'Closest Race Ever!',
  'Tiny Balls, Huge Chaos!',
  'Obstacle Mayhem!',
  'Can Red Win?',
  'Track of Doom!',
  'Mega Marble Challenge!',
  'Last Second Win!',
  'Wild Marble Finish!',
  'Marbles vs Madness!',
  'Don’t Blink!',
  'This Marble Escaped!',
  'Crazy Track Battle!',
  'Ultimate Marble Chaos!',
  'Fastest Marble Wins!',
  'One Marble Survives!',
  'Which Marble Wins?',
];

const CUP_STAGE_TRACK_LENGTHS = {
  'quarter-final': 600,
  'semi-final': 600,
  final: 600,
};
const CUP_STAGE_TRACK_LABEL = 'Cup unified 600m';
const RACE_SECONDS_PER_METER = 90 / 300;
const FINAL_RACE_NODE_GATE_SECONDS = 18;
const WALL_CLOCK_CAPTURE_FACTOR = 1.85;
function estimateMaxRaceSecondsForTrackLength(trackLength) {
  return Math.max(45, Math.min(1200, Math.ceil(trackLength * RACE_SECONDS_PER_METER)));
}

const CUP_VIDEO_DEFAULTS = {
  targetSeconds: 600,
  targetMinutes: 10,
  trackLength: 600,
  stageTrackLengths: CUP_STAGE_TRACK_LENGTHS,
  timeout: 1800,
  label: 'Dashboard default supports target video duration or fixed per-race track length; render script owns per-race timeout unless explicitly overridden outside dashboard',
};

const jobs = new Map();
let nextJobId = 1;
let nextRenderPort = RENDER_PORT_START;

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function htmlResponse(res, body) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function notFound(res) {
  jsonResponse(res, 404, { ok: false, error: 'not-found' });
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('request-too-large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function defaultSchedule() {
  return { version: 1, updatedAt: new Date().toISOString(), items: [] };
}

function normalizeScheduleTime(value = {}, fallback = { hour: 9, minute: 0 }) {
  const rawHour = Number(value.hour ?? fallback.hour);
  const rawMinute = Number(value.minute ?? fallback.minute);
  const hour = Number.isFinite(rawHour) ? Math.max(0, Math.min(23, Math.round(rawHour))) : fallback.hour;
  const minute = Number.isFinite(rawMinute) ? Math.max(0, Math.min(55, Math.round(rawMinute / 5) * 5)) : fallback.minute;
  return { hour, minute };
}

function normalizeScheduleTimes(item = {}) {
  const rawTimes = Array.isArray(item.times) ? item.times : [];
  const sourceTimes = rawTimes.length ? rawTimes : [{ hour: item.hour, minute: item.minute }];
  const seen = new Set();
  const times = [];
  for (const entry of sourceTimes) {
    const time = normalizeScheduleTime(entry);
    const key = `${time.hour}:${time.minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    times.push(time);
  }
  if (!times.length) times.push({ hour: 9, minute: 0 });
  times.sort((a, b) => (a.hour - b.hour) || (a.minute - b.minute));
  return times;
}

function schedulePrimaryTime(item = {}) {
  const times = normalizeScheduleTimes(item);
  return times[0] || { hour: 9, minute: 0 };
}

function normalizeScheduleItem(item = {}, index = 0) {
  const id = String(item.id || `schedule-${Date.now()}-${index}-${crypto.randomBytes(3).toString('hex')}`).slice(0, 80);
  const title = String(item.title || item.name || 'New item').trim().slice(0, 120) || 'New item';
  const defaultAction = SCHEDULE_ACTIONS[0]?.value || 'youtube-marble-long-video';
  const requestedAction = String(item.action || defaultAction).trim().slice(0, 80) || defaultAction;
  const action = SCHEDULE_ACTIONS.some((entry) => entry.value === requestedAction) ? requestedAction : defaultAction;
  const recurrence = SCHEDULE_RECURRENCES.some((entry) => entry.value === item.recurrence) ? item.recurrence : 'weekly';
  const rawWeekday = Number(item.weekday ?? item.dayOfWeek ?? 1);
  const weekdayValues = new Set(SCHEDULE_WEEKDAYS.map((day) => day.value));
  const weekday = Number.isFinite(rawWeekday) && weekdayValues.has(Math.round(rawWeekday)) ? Math.round(rawWeekday) : 1;
  const times = normalizeScheduleTimes(item);
  const primaryTime = times[0] || { hour: 9, minute: 0 };
  return {
    id, title, action, recurrence, weekday, hour: primaryTime.hour, minute: primaryTime.minute, times,
    enabled: item.enabled !== false,
    notes: String(item.notes || '').slice(0, 500),
    payload: item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload) ? item.payload : {},
    createdAt: item.createdAt || new Date().toISOString(),
    updatedAt: item.updatedAt || new Date().toISOString(),
  };
}

function normalizeSchedule(value = {}) {
  const items = Array.isArray(value.items) ? value.items.map(normalizeScheduleItem) : [];
  items.sort((a, b) => {
    const aTime = schedulePrimaryTime(a);
    const bTime = schedulePrimaryTime(b);
    return (a.recurrence === b.recurrence ? 0 : a.recurrence === 'daily' ? -1 : 1) || (a.weekday - b.weekday) || (aTime.hour - bTime.hour) || (aTime.minute - bTime.minute) || a.title.localeCompare(b.title);
  });
  return { version: 1, updatedAt: new Date().toISOString(), items };
}

function loadSchedule() {
  if (!existsSync(schedulePath)) return defaultSchedule();
  try { return normalizeSchedule(JSON.parse(readFileSync(schedulePath, 'utf8'))); }
  catch (error) { return { ...defaultSchedule(), error: error.message }; }
}

function saveSchedule(schedule) {
  const normalized = normalizeSchedule(schedule);
  writeFileSync(schedulePath, `${JSON.stringify(normalized, null, 2)}
`);
  return normalized;
}

function defaultScheduleRunState() {
  return { version: 1, updatedAt: new Date().toISOString(), lastRunByItem: {}, runs: [] };
}

function loadScheduleRunState() {
  if (!existsSync(scheduleRunStatePath)) return defaultScheduleRunState();
  try {
    const parsed = JSON.parse(readFileSync(scheduleRunStatePath, 'utf8'));
    return {
      version: 1,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      lastRunByItem: parsed.lastRunByItem && typeof parsed.lastRunByItem === 'object' && !Array.isArray(parsed.lastRunByItem) ? parsed.lastRunByItem : {},
      runs: Array.isArray(parsed.runs) ? parsed.runs.slice(-120) : [],
    };
  } catch (error) {
    return { ...defaultScheduleRunState(), error: error.message };
  }
}

function saveScheduleRunState(state) {
  const normalized = {
    version: 1,
    updatedAt: new Date().toISOString(),
    lastRunByItem: state.lastRunByItem || {},
    runs: Array.isArray(state.runs) ? state.runs.slice(-120) : [],
  };
  writeFileSync(scheduleRunStatePath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function formatHongKongTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}-hkt`;
}

function renderKindSlug(options = {}) {
  return String(options.videoCanvasLayout || '').toLowerCase() === 'vertical' ? 'short-video' : 'long-video';
}

function renderBaseName(options = {}, date = new Date()) {
  return `${formatHongKongTimestamp(date)}-${renderKindSlug(options)}`;
}

function renderTitleSlug(options = {}, fallbackParts = []) {
  return renderBaseName(options);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function estimateRaceCount(recordMode, multipleRaceCount) {
  if (recordMode === 'continuous') return Math.max(1, multipleRaceCount || 5);
  if (recordMode === 'cup') return 3;
  return 1;
}

function estimateNonRaceSeconds(recordMode, raceCount) {
  if (recordMode === 'cup') return 164;
  if (recordMode === 'continuous') return 2 + Math.max(0, raceCount - 1) * 10 + FINAL_RACE_NODE_GATE_SECONDS;
  return 7;
}

function estimateOutputVideoSeconds({ recordMode, raceCount, trackLength }) {
  return Math.ceil((estimateMaxRaceSecondsForTrackLength(trackLength) * raceCount) + estimateNonRaceSeconds(recordMode, raceCount));
}

function estimateEncodeFactor(videoPreset) {
  return ({
    ultrafast: 0.15,
    superfast: 0.2,
    veryfast: 0.35,
    faster: 0.5,
    fast: 0.7,
    medium: 0.9,
    slow: 1.2,
    slower: 1.8,
    veryslow: 2.5,
  })[videoPreset] ?? 0.5;
}

function estimateWallClockSeconds(options) {
  const outputSeconds = estimateOutputVideoSeconds(options);
  const captureSeconds = outputSeconds * WALL_CLOCK_CAPTURE_FACTOR;
  const comparisonSeconds = options.format === 'mp4' ? outputSeconds * 0.08 : 0;
  const encodeSeconds = outputSeconds * estimateEncodeFactor(options.videoPreset);
  const thumbnailSeconds = options.thumbnail ? 8 : 0;
  const fixedSeconds = 25;
  return Math.ceil(captureSeconds + comparisonSeconds + encodeSeconds + thumbnailSeconds + fixedSeconds);
}

function calculateTrackLengthForDuration({ targetSeconds, recordMode, multipleRaceCount }) {
  const raceCount = estimateRaceCount(recordMode, multipleRaceCount);
  const nonRaceSeconds = estimateNonRaceSeconds(recordMode, raceCount);
  const raceSeconds = Math.max(35, (targetSeconds - nonRaceSeconds) / raceCount);
  const metersPerSecond = 4.6;
  return Math.max(80, Math.min(3000, Math.round((raceSeconds * metersPerSecond) / 10) * 10));
}

function normalizeOptions(input = {}) {
  const cupName = String(input.cupName || '').trim().slice(0, 80);
  const recordMode = BACKGROUND_RECORD_MODES.some((mode) => mode.value === input.recordMode) ? input.recordMode : 'continuous';
  const multipleRaceCount = Math.max(1, Math.min(99, Math.round(Number(input.multipleRaceCount) || 5)));
  const density = DENSITY_PRESETS.some((item) => item.value === input.density) ? input.density : 'many';
  const requestedTypes = Array.isArray(input.obstacleTypes) ? input.obstacleTypes : [];
  const allowedTypes = new Set(OBSTACLE_TYPES.map((item) => item.value));
  const obstacleTypes = requestedTypes.filter((type) => allowedTypes.has(type));
  const format = input.format === 'webm' ? 'webm' : 'mp4';
  const videoCapture = input.videoCapture === 'playwright' ? 'playwright' : 'canvas';
  const cupSize = Math.max(2, Math.min(99, Math.round(Number(input.cupSize) || 12)));
  const qualityPreset = ['1080p-smooth', '1080p', '1440p', '4k'].includes(input.qualityPreset) ? input.qualityPreset : '1080p-smooth';
  const renderPerformanceProfile = input.renderPerformanceProfile === 'turbo60' ? 'turbo60' : 'turbo60';
  const qualitySettings = {
    '1080p-smooth': { width: 1920, height: 1080, crf: 18, captureScale: 1, fps: 60, videoPreset: 'veryfast', label: '1080p Smooth · 1920×1080 · 60fps · CRF18 · veryfast' },
    '1080p': { width: 1920, height: 1080, crf: 18, captureScale: 1, fps: 60, videoPreset: 'veryfast', label: '1080p · 60fps · fast encode' },
    '1440p': { width: 2560, height: 1440, crf: 20, captureScale: 1, fps: 60, videoPreset: 'faster', label: 'High 1440p · 60fps · faster encode' },
    '4k': { width: 3840, height: 2160, crf: 20, captureScale: 1, fps: 60, videoPreset: 'faster', label: 'Ultra 4K · 60fps · faster encode' },
  }[qualityPreset];
  const lengthMode = input.lengthMode === 'fixed-track' ? 'fixed-track' : 'target-duration';
  const targetMinutes = clampNumber(input.targetMinutes, 1, 120, CUP_VIDEO_DEFAULTS.targetMinutes);
  const targetSeconds = Math.round(targetMinutes * 60);
  const manualTrackLength = Math.max(80, Math.min(3000, Math.round(Number(input.trackLength) || CUP_VIDEO_DEFAULTS.trackLength)));
  const trackLength = lengthMode === 'target-duration'
    ? calculateTrackLengthForDuration({ targetSeconds, recordMode, multipleRaceCount })
    : manualTrackLength;
  const maxRaceSeconds = estimateMaxRaceSecondsForTrackLength(trackLength);
  const videoCanvasLayout = String(input.videoCanvasLayout || 'horizontal').toLowerCase() === 'vertical' ? 'vertical' : 'horizontal';
  const defaultCanvasSize = videoCanvasLayout === 'vertical'
    ? { width: 1080, height: 1920 }
    : { width: qualitySettings.width, height: qualitySettings.height };
  const width = Math.max(720, Math.min(3840, Math.round(Number(input.width) || defaultCanvasSize.width)));
  const height = Math.max(720, Math.min(3840, Math.round(Number(input.height) || defaultCanvasSize.height)));
  const crf = Math.max(10, Math.min(24, Math.round(Number(input.crf) || qualitySettings.crf)));
  const captureScale = Math.max(1, Math.min(2, Number(input.captureScale) || qualitySettings.captureScale));
  const fps = Math.max(24, Math.min(120, Math.round(Number(input.fps) || qualitySettings.fps)));
  const videoPreset = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].includes(input.videoPreset) ? input.videoPreset : qualitySettings.videoPreset;
  const raceCount = estimateRaceCount(recordMode, multipleRaceCount);
  const dynamicTimeout = Math.ceil((maxRaceSeconds * raceCount) + estimateNonRaceSeconds(recordMode, raceCount) + 300);
  const requestedTimeout = Number(input.timeout);
  const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0 && requestedTimeout !== CUP_VIDEO_DEFAULTS.timeout
    ? Math.max(120, Math.min(7200, requestedTimeout))
    : Math.max(120, Math.min(7200, dynamicTimeout));
  const audio = input.audio !== false;
  const thumbnail = input.thumbnail !== false;
  const uploadYoutube = input.uploadYoutube === true;
  const youtubePrivacy = ['private', 'unlisted', 'public'].includes(String(input.youtubePrivacy || '').toLowerCase())
    ? String(input.youtubePrivacy).toLowerCase()
    : 'private';
  const estimatedOutputSeconds = estimateOutputVideoSeconds({ recordMode, raceCount, trackLength });
  const estimatedWallClockSeconds = estimateWallClockSeconds({
    recordMode,
    raceCount,
    trackLength,
    format,
    videoPreset,
    thumbnail,
  }) + (uploadYoutube ? Math.ceil((estimatedOutputSeconds * 0.15) + 60) : 0);
  const thumbnailTitle = String(input.thumbnailTitle || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const ttsVoice = String(input.ttsVoice || 'Alex').replace(/[^\w .'-]/g, '').trim().slice(0, 48) || 'Alex';
  const dryRun = input.dryRun === true || input.__dryRun === true;
  const obstacleDistribution = OBSTACLE_DISTRIBUTION_MODES.some((mode) => mode.value === input.obstacleDistribution) ? input.obstacleDistribution : 'random';
  return {
    recordMode,
    multipleRaceCount,
    videoCanvasLayout,
    obstacleDistribution,
    cupName,
    density,
    obstacleTypes,
    format,
    videoCapture,
    cupSize,
    lengthMode,
    targetSeconds,
    targetMinutes,
    raceCount,
    trackLength,
    manualTrackLength,
    calculatedTrackLength: trackLength,
    estimatedMaxRaceSeconds: maxRaceSeconds,
    estimatedOutputSeconds,
    estimatedWallClockSeconds,
    qualityPreset,
    renderPerformanceProfile,
    qualityLabel: qualitySettings.label,
    width,
    height,
    crf,
    captureScale,
    fps,
    videoPreset,
    timeout,
    stageTrackLengths: {
      'quarter-final': trackLength,
      'semi-final': trackLength,
      final: trackLength,
    },
    stageTrackLabel: `Unified ${trackLength}m`,
    audio,
    thumbnail,
    uploadYoutube,
    youtubePrivacy,
    thumbnailTitle,
    ttsVoice,
    dryRun,
  };
}

function estimateJobProgress(job) {
  if (!job) return { percent: 0, label: 'No job' };
  if (job.status === 'completed') return { percent: 100, label: 'Completed' };
  if (job.status === 'failed') return { percent: 100, label: 'Failed' };
  if (job.status === 'stopping') return { percent: 99, label: 'Stopping' };
  const elapsedSeconds = Math.max(0, (Date.now() - Date.parse(job.startedAt || job.createdAt || new Date().toISOString())) / 1000);
  const estimateSeconds = Math.max(
    60,
    Number(job.options?.estimatedWallClockSeconds)
      || Number(job.options?.timeout)
      || Number(job.options?.targetSeconds)
      || 600,
  );
  const outputSeconds = Math.max(1, Number(job.options?.estimatedOutputSeconds) || Number(job.options?.targetSeconds) || 600);
  const percent = Math.max(1, Math.min(95, Math.round((elapsedSeconds / estimateSeconds) * 100)));
  const mode = job.options?.recordMode === 'continuous' ? `Multiple ${job.options?.multipleRaceCount || ''}` : job.options?.recordMode === 'cup' ? 'Cup Mode' : 'Single';
  return {
    percent,
    elapsedSeconds: Math.round(elapsedSeconds),
    targetSeconds: outputSeconds,
    estimateSeconds,
    estimatedOutputSeconds: outputSeconds,
    estimatedWallClockSeconds: estimateSeconds,
    label: `${mode} · ${Math.round(elapsedSeconds)}s / ~${estimateSeconds}s render estimate · output ~${outputSeconds}s`,
  };
}

function recordingUrl(filePath) {
  const relative = path.relative(recordingsDir, filePath).split(path.sep).join('/');
  return `/recordings/${relative.split('/').map(encodeURIComponent).join('/')}`;
}

function recordingDisplayName(filePath) {
  return path.relative(recordingsDir, filePath).split(path.sep).join('/');
}

function getCompanionOutputs(output, options = {}) {
  if (!output || options.format !== 'mp4') return [];
  const comparisonWebm = path.resolve(`${output.replace(/\.[^.]+$/, '')}.comparison.webm`);
  return [{
    kind: 'comparison-webm',
    label: 'Comparison WebM',
    path: comparisonWebm,
    name: recordingDisplayName(comparisonWebm),
    exists: existsSync(comparisonWebm),
    size: existsSync(comparisonWebm) ? statSync(comparisonWebm).size : 0,
    url: recordingUrl(comparisonWebm),
  }];
}

function publicJob(job) {
  const outputExists = Boolean(job.output && existsSync(job.output));
  const thumbnail = job.thumbnail || (job.output ? `${job.output.replace(/\.[^.]+$/, '')}.thumbnail.jpg` : null);
  const thumbnailExists = Boolean(thumbnail && existsSync(thumbnail));
  const youtubeMetadata = job.youtubeMetadata || (job.output ? `${job.output.replace(/\.[^.]+$/, '')}.youtube.json` : null);
  const youtubeMetadataExists = Boolean(youtubeMetadata && existsSync(youtubeMetadata));
  const youtubeUpload = job.youtubeUpload || (job.output ? `${job.output.replace(/\.[^.]+$/, '')}.youtube-upload.json` : null);
  const youtubeUploadExists = Boolean(youtubeUpload && existsSync(youtubeUpload));
  let youtubeUploadInfo = null;
  if (youtubeUploadExists) {
    try {
      const parsed = JSON.parse(readFileSync(youtubeUpload, 'utf8'));
      youtubeUploadInfo = {
        videoId: parsed.videoId || null,
        url: parsed.url || null,
        studioUrl: parsed.studioUrl || null,
        privacyStatus: parsed.privacyStatus || null,
        title: parsed.title || null,
        dryRun: Boolean(parsed.dryRun),
      };
    } catch {}
  }
  const renderLog = job.renderLog || (job.output ? `${job.output.replace(/\.[^.]+$/, '')}.render.log` : null);
  const renderLogExists = Boolean(renderLog && existsSync(renderLog));
  const size = outputExists ? statSync(job.output).size : 0;
  const canStop = ['running', 'starting'].includes(job.status) && Boolean(job.child);
  const stopUrl = canStop ? `/api/jobs/${encodeURIComponent(job.id)}/stop` : null;
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    options: job.options,
    output: job.output,
    outputName: job.output ? recordingDisplayName(job.output) : null,
    outputFolder: job.output ? recordingDisplayName(path.dirname(job.output)) : null,
    thumbnail,
    thumbnailName: thumbnail ? recordingDisplayName(thumbnail) : null,
    thumbnailExists,
    thumbnailUrl: thumbnailExists ? recordingUrl(thumbnail) : null,
    youtubeMetadata,
    youtubeMetadataName: youtubeMetadata ? recordingDisplayName(youtubeMetadata) : null,
    youtubeMetadataExists,
    youtubeMetadataUrl: youtubeMetadataExists ? recordingUrl(youtubeMetadata) : null,
    youtubeUpload,
    youtubeUploadName: youtubeUpload ? recordingDisplayName(youtubeUpload) : null,
    youtubeUploadExists,
    youtubeUploadUrl: youtubeUploadExists ? recordingUrl(youtubeUpload) : null,
    youtubeUploadInfo,
    renderLog,
    renderLogName: renderLog ? recordingDisplayName(renderLog) : null,
    renderLogExists,
    renderLogUrl: renderLogExists ? recordingUrl(renderLog) : null,
    outputExists,
    companionOutputs: getCompanionOutputs(job.output, job.options),
    size,
    renderPort: job.renderPort,
    command: job.command,
    error: job.error,
    progress: estimateJobProgress(job),
    log: job.log.slice(-16000),
    canStop,
    stopUrl,
  };
}

function listRecordingFiles(dir = recordingsDir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listRecordingFiles(full, relative);
    return [{ name: relative, full }];
  });
}

function listRecordings() {
  if (!existsSync(recordingsDir)) return [];
  return listRecordingFiles()
    .filter(({ name }) => /\.(webm|mp4|jpe?g|png|json)$/i.test(name))
    .filter(({ name }) => !/\.metadata\.json$/i.test(name))
    .map(({ name, full }) => {
      const st = statSync(full);
      const base = name.replace(/\.[^.]+$/, '');
      const dir = path.dirname(name) === '.' ? '' : path.dirname(name);
      const candidate = (suffix) => path.join(recordingsDir, dir, `${path.basename(base)}${suffix}`);
      const thumbnailPath = candidate('.thumbnail.jpg');
      const youtubePath = candidate('.youtube.json');
      return {
        name,
        path: full,
        folder: dir || '.',
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
        url: recordingUrl(full),
        isVideo: /\.(webm|mp4)$/i.test(name),
        isThumbnail: /\.(?:thumbnail|test-thumbnail)\.jpe?g$/i.test(name),
        isYoutubeMetadata: /\.youtube\.json$/i.test(name),
        thumbnailExists: /\.(webm|mp4)$/i.test(name) && existsSync(thumbnailPath),
        thumbnailUrl: recordingUrl(thumbnailPath),
        youtubeMetadataExists: /\.(webm|mp4)$/i.test(name) && existsSync(youtubePath),
        youtubeMetadataUrl: recordingUrl(youtubePath),
        youtubeUploadExists: /\.(webm|mp4)$/i.test(name) && existsSync(candidate('.youtube-upload.json')),
        youtubeUploadUrl: recordingUrl(candidate('.youtube-upload.json')),
      };
    })
    .sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))
    .slice(0, 30);
}


function splitCommand(command) {
  const matches = String(command || '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return matches.map((part) => part.replace(/^(['"])(.*)\1$/, '$2'));
}

function commandText(command, extraArgs = []) {
  return [command, ...extraArgs].filter(Boolean).join(' ');
}


function safeRecordingName(name, allowedPattern = /\.(webm|mp4)$/i) {
  const value = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!value || value.includes('..') || path.isAbsolute(value) || !allowedPattern.test(value)) return '';
  const full = path.resolve(recordingsDir, value);
  const root = path.resolve(recordingsDir);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) return '';
  return existsSync(full) ? value : '';
}

function normalizeThumbnailTestOptions(input = {}) {
  const recordings = listRecordings().filter((rec) => rec.isVideo);
  const requested = safeRecordingName(input.videoName || input.name || input.input || '');
  const videoName = requested || recordings[0]?.name || '';
  const title = String(input.title || input.thumbnailTitle || 'CRAZY FIRST HIT')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'CRAZY FIRST HIT';
  const videoCanvasLayout = String(input.videoCanvasLayout || input.layout || '').toLowerCase() === 'vertical' ? 'vertical' : 'horizontal';
  const dryRun = input.dryRun === true || input.__dryRun === true;
  return { videoName, title, videoCanvasLayout, dryRun };
}

function generateThumbnailTest(input = {}) {
  const options = normalizeThumbnailTestOptions(input);
  if (!options.videoName) throw new Error('no video recording found; render or copy one .webm/.mp4 into recordings/ first');
  const videoPath = path.join(recordingsDir, options.videoName);
  const videoBase = options.videoName.replace(/\.[^.]+$/, '');
  const videoDir = path.dirname(videoPath);
  const videoStem = path.basename(videoBase);
  const thumbnailPath = path.join(videoDir, `${videoStem}.test-thumbnail.jpg`);
  const metadataPath = `${thumbnailPath}.metadata.json`;
  const youtubeMetadataPath = path.join(videoDir, `${videoStem}.test-youtube.json`);
  const metadata = {
    title: options.title,
    thumbnailTitle: options.title,
    cupName: options.title,
    generatedFrom: videoPath,
    broadcastEvents: [
      { title: 'First Hit Chaos', detail: options.title, kind: 'obstacle', time: 2.0, progress: 0.18 },
      { title: 'Huge Overtake', detail: options.title, kind: 'overtake', time: 4.0, progress: 0.28 },
    ],
  };
  const baseArgs = splitCommand(activeGame.thumbnail.command);
  const [thumbnailBin, ...thumbnailBaseRest] = baseArgs;
  const extraArgs = [
    `--input=${videoPath}`,
    `--output=${thumbnailPath}`,
    `--metadata=${metadataPath}`,
    '--frame-strategy=mid-highlight',
    `--safe-crop=${options.videoCanvasLayout === 'vertical' ? 'vertical-shorts-clean' : 'composite-no-live-event'}`,
    '--max-words=6',
    `--width=${options.videoCanvasLayout === 'vertical' ? 1080 : 1280}`,
    `--height=${options.videoCanvasLayout === 'vertical' ? 1920 : 720}`,
    `--title=${options.title}`,
    `--youtube-metadata-output=${youtubeMetadataPath}`,
  ];
  const args = [...thumbnailBaseRest, ...extraArgs];
  const command = `${thumbnailBin || 'node'} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`;
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      videoName: options.videoName,
      title: options.title,
      videoCanvasLayout: options.videoCanvasLayout,
      thumbnailName: recordingDisplayName(thumbnailPath),
      thumbnailUrl: recordingUrl(thumbnailPath),
      youtubeMetadataName: recordingDisplayName(youtubeMetadataPath),
      youtubeMetadataUrl: recordingUrl(youtubeMetadataPath),
      command,
    };
  }
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const result = spawnSync(thumbnailBin || 'node', args, { cwd: rootDir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error([result.stdout, result.stderr].filter(Boolean).join('\n') || `thumbnail command exited ${result.status}`);
  }
  return {
    ok: true,
    dryRun: false,
    videoName: options.videoName,
    title: options.title,
    videoCanvasLayout: options.videoCanvasLayout,
    thumbnailName: recordingDisplayName(thumbnailPath),
    thumbnailUrl: recordingUrl(thumbnailPath),
    youtubeMetadataName: recordingDisplayName(youtubeMetadataPath),
    youtubeMetadataUrl: recordingUrl(youtubeMetadataPath),
    youtubeMetadataSize: existsSync(youtubeMetadataPath) ? statSync(youtubeMetadataPath).size : 0,
    size: existsSync(thumbnailPath) ? statSync(thumbnailPath).size : 0,
    log: [result.stdout, result.stderr].filter(Boolean).join('\n').slice(-8000),
    command,
  };
}

function startRender(options) {
  const id = String(nextJobId++);
  const createdAt = new Date();
  const outputBaseName = renderBaseName(options, createdAt);
  const typeSlug = renderKindSlug(options);
  const bundleName = outputBaseName;
  const bundleDir = path.join(recordingsDir, bundleName);
  const output = path.join(bundleDir, `${outputBaseName}.${options.format}`);
  const thumbnail = path.join(bundleDir, `${outputBaseName}.thumbnail.jpg`);
  const youtubeMetadata = path.join(bundleDir, `${outputBaseName}.youtube.json`);
  const youtubeUpload = path.join(bundleDir, `${outputBaseName}.youtube-upload.json`);
  const renderLog = path.join(bundleDir, `${outputBaseName}.log`);
  const renderPort = nextRenderPort++;
  const renderUrl = `http://127.0.0.1:${renderPort}`;
  const baseRenderArgs = splitCommand(activeGame.render.command);
  const renderExtraArgs = [
    `--output=${output}`,
    `--format=${options.format}`,
    `--mode=${options.recordMode}`,
    `--multiple-race-count=${options.multipleRaceCount}`,
    `--cup-size=${options.cupSize}`,
    `--track-length=${options.trackLength}`,
    `--target-seconds=${options.targetSeconds}`,
    `--length-mode=${options.lengthMode}`,
    `--obstacle-preset=${options.density}`,
    `--obstacle-distribution=${options.obstacleDistribution}`,
    `--width=${options.width}`,
    `--height=${options.height}`,
    `--fps=${options.fps}`,
    `--crf=${options.crf}`,
    `--capture-scale=${options.captureScale}`,
    `--video-preset=${options.videoPreset}`,
    `--render-performance-profile=${options.renderPerformanceProfile || 'turbo60'}`,
    `--timeout=${options.timeout}`,
    `--tts-voice=${options.ttsVoice}`,
    `--thumbnail=${options.thumbnail ? 'true' : 'false'}`,
    `--thumbnail-output=${thumbnail}`,
    `--youtube-metadata-output=${youtubeMetadata}`,
    `--upload-youtube=${options.uploadYoutube ? 'true' : 'false'}`,
    `--youtube-privacy=${options.youtubePrivacy}`,
    `--youtube-upload-output=${youtubeUpload}`,
    `--video-capture=${options.videoCapture}`,
    `--video-canvas=${options.videoCanvasLayout || 'horizontal'}`,
    '--thumbnail-frame-strategy=mid-highlight',
    `--thumbnail-safe-crop=${options.videoCanvasLayout === 'vertical' ? 'vertical-shorts-clean' : 'composite-no-live-event'}`,
    '--thumbnail-max-words=6',
    `--port=${renderPort}`,
    `--url=${renderUrl}`,
  ];
  if (options.thumbnailTitle) renderExtraArgs.push(`--thumbnail-title=${options.thumbnailTitle}`);
  if (options.obstacleTypes.length) renderExtraArgs.push(`--obstacle-types=${options.obstacleTypes.join(',')}`);
  if (!options.audio) renderExtraArgs.push('--audio=false');
  const [renderBin, ...renderBaseRest] = baseRenderArgs;
  // Insert -- separator for npm run so extra args reach the script (only if not already present)
  const needsNpmSeparator = (renderBaseRest.includes('run') || renderBaseRest.includes('exec')) && !renderBaseRest.includes('--');
  const args = [...renderBaseRest, ...(needsNpmSeparator ? ['--'] : []), ...renderExtraArgs];

  const job = {
    id,
    status: options.dryRun ? 'completed' : 'running',
    createdAt: createdAt.toISOString(),
    startedAt: createdAt.toISOString(),
    finishedAt: options.dryRun ? createdAt.toISOString() : null,
    exitCode: options.dryRun ? 0 : null,
    signal: null,
    options,
    output,
    outputFolder: bundleDir,
    outputTitle: outputBaseName,
    outputTypeSlug: typeSlug,
    thumbnail,
    youtubeMetadata,
    youtubeUpload,
    renderLog,
    renderPort,
    command: `${renderBin || 'npm'} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`,
    log: options.dryRun ? `[dry-run] Would run from ${rootDir}\n[dry-run] ${`${renderBin || 'npm'} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`}\n` : '',
    error: null,
    child: null,
  };
  jobs.set(id, job);

  mkdirSync(bundleDir, { recursive: true });
  if (options.dryRun) {
    writeFileSync(renderLog, job.log);
    return job;
  }

  const child = spawn(renderBin || 'npm', args, {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
    detached: true,
  });
  child.unref();
  job.child = child;

  const append = (chunk) => {
    const text = chunk.toString();
    job.log += text;
    appendFileSync(renderLog, text);
    if (job.log.length > 60000) job.log = job.log.slice(-60000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (error) => {
    job.status = 'failed';
    job.error = error.message;
    job.finishedAt = new Date().toISOString();
  });
  child.on('exit', (code, signal) => {
    job.exitCode = code;
    job.signal = signal;
    job.finishedAt = new Date().toISOString();
    job.status = code === 0 ? 'completed' : 'failed';
    if (code !== 0 && !job.error) job.error = `render exited with ${code ?? signal}`;
    appendFileSync(renderLog, `\n[dashboard] render job ${job.status} exit=${code ?? ''} signal=${signal ?? ''} finishedAt=${job.finishedAt}\n`);
    updateScheduleRunForJob(job);
  });

  return job;
}

function stopJob(job) {
  if (!job || job.status !== 'running' || !job.child) return false;
  job.child.kill('SIGTERM');
  job.status = 'stopping';
  job.finishedAt = new Date().toISOString();
  return true;
}

const scheduleWorker = {
  intervalMs: SCHEDULE_WORKER_INTERVAL_MS,
  startedAt: null,
  lastCheckedAt: null,
  nextCheckAt: null,
  lastResult: null,
  running: false,
  timer: null,
};

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function scheduleSlotForDate(date = new Date()) {
  const minute = Math.floor(date.getMinutes() / 5) * 5;
  return {
    dateKey: localDateKey(date),
    weekday: date.getDay(),
    hour: date.getHours(),
    minute,
    slotKey: `${localDateKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

function scheduleItemDueInSlot(item, slot) {
  if (!item.enabled) return false;
  const matchesTime = normalizeScheduleTimes(item).some((time) => Number(time.hour) === slot.hour && Number(time.minute) === slot.minute);
  if (!matchesTime) return false;
  if (item.recurrence === 'daily') return true;
  return Number(item.weekday) === Number(slot.weekday);
}

function scheduleRunKey(item, slot) {
  return `${item.id}@${slot.slotKey}`;
}

function randomIntFromSpec(spec = {}) {
  const min = Math.round(Number(spec.min ?? 0));
  const max = Math.round(Number(spec.max ?? min));
  const step = Math.max(1, Math.round(Number(spec.step || 1)));
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const count = Math.floor((hi - lo) / step) + 1;
  return lo + (Math.floor(Math.random() * count) * step);
}

function randomSampleFromSpec(spec = {}) {
  const source = spec.source === 'availableObstacleTypes' ? OBSTACLE_TYPES.map((item) => item.value) : Array.isArray(spec.values) ? spec.values : [];
  const pool = [...new Set(source)].filter(Boolean);
  const count = Math.max(0, Math.min(pool.length, Math.round(Number(spec.count ?? pool.length))));
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool.slice(0, count);
}

function resolveScheduleDynamicValue(value) {
  if (Array.isArray(value)) return value.map(resolveScheduleDynamicValue);
  if (!value || typeof value !== 'object') return value;
  const strategy = value.strategy || value.dynamic;
  if (strategy === 'randomInt') return randomIntFromSpec(value);
  if (strategy === 'randomSample') return randomSampleFromSpec(value);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveScheduleDynamicValue(entry)]));
}

function resolveSchedulePayload(payload = {}) {
  return resolveScheduleDynamicValue(JSON.parse(JSON.stringify(payload || {})));
}

function appendScheduleRun(entry) {
  const state = loadScheduleRunState();
  const runs = Array.isArray(state.runs) ? state.runs : [];
  runs.push(entry);
  state.runs = runs.slice(-120);
  if (entry.runKey) state.lastRunByItem[entry.itemId] = entry.runKey;
  return saveScheduleRunState(state);
}

function latestScheduleRunsByItem(runs = []) {
  const latest = {};
  for (const run of runs) {
    if (!run?.itemId) continue;
    const current = latest[run.itemId];
    const runTime = Date.parse(run.finishedAt || run.checkedAt || 0);
    const currentTime = Date.parse(current?.finishedAt || current?.checkedAt || 0);
    if (!current || runTime >= currentTime) latest[run.itemId] = run;
  }
  return latest;
}

function scheduleRunTimeDisplayKey(run = {}) {
  const slot = run.slot || {};
  const weekday = Number(slot.weekday);
  const hour = Number(slot.hour);
  const minute = Number(slot.minute);
  if (!run.itemId || !Number.isFinite(weekday) || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return `${run.itemId}@${weekday}@${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function latestScheduleRunsByItemTime(runs = []) {
  const latest = {};
  for (const run of runs) {
    const key = scheduleRunTimeDisplayKey(run);
    if (!key) continue;
    const current = latest[key];
    const runTime = Date.parse(run.finishedAt || run.checkedAt || 0);
    const currentTime = Date.parse(current?.finishedAt || current?.checkedAt || 0);
    if (!current || runTime >= currentTime) latest[key] = run;
  }
  return latest;
}

function updateScheduleRunForJob(job) {
  const source = job?.options?.scheduleSource;
  if (!source?.runId) return null;
  const state = loadScheduleRunState();
  const runs = Array.isArray(state.runs) ? state.runs : [];
  const index = runs.findIndex((run) => run.id === source.runId || (run.jobId === job.id && run.runKey === source.runKey));
  if (index < 0) return null;
  runs[index] = {
    ...runs[index],
    status: job.status === 'completed' ? 'completed' : 'failed',
    finishedAt: job.finishedAt || new Date().toISOString(),
    exitCode: job.exitCode,
    signal: job.signal,
    error: job.error || null,
    outputName: job.output ? recordingDisplayName(job.output) : null,
  };
  state.runs = runs;
  return saveScheduleRunState(state);
}

function publicScheduleWorkerStatus() {
  const state = loadScheduleRunState();
  return {
    running: Boolean(scheduleWorker.timer),
    busy: scheduleWorker.running,
    intervalMs: scheduleWorker.intervalMs,
    intervalMinutes: Math.round(scheduleWorker.intervalMs / 60000),
    startedAt: scheduleWorker.startedAt,
    lastCheckedAt: scheduleWorker.lastCheckedAt,
    nextCheckAt: scheduleWorker.nextCheckAt,
    lastResult: scheduleWorker.lastResult,
    runStatePath: scheduleRunStatePath,
    recentRuns: (state.runs || []).slice(-20).reverse(),
    latestRunByItem: latestScheduleRunsByItem(state.runs || []),
    latestRunByItemTime: latestScheduleRunsByItemTime(state.runs || []),
  };
}

function findRunningRenderJob() {
  return Array.from(jobs.values()).find((job) => job.status === 'running' || job.status === 'stopping');
}

function executeScheduleAction(item, slot, { dryRun = false } = {}) {
  const actionDefinition = SCHEDULE_ACTIONS.find((entry) => entry.value === item.action);
  const mergedPayload = {
    ...(actionDefinition?.payload || {}),
    ...(item.payload || {}),
    renderOptions: {
      ...(actionDefinition?.payload?.renderOptions || {}),
      ...(item.payload?.renderOptions || {}),
    },
  };
  const payload = resolveSchedulePayload(mergedPayload);
  const runKey = scheduleRunKey(item, slot);
  const baseEntry = {
    id: `schedule-run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    itemId: item.id,
    title: item.title,
    action: item.action,
    runKey,
    slot: { ...slot },
    checkedAt: new Date().toISOString(),
    dryRun,
  };

  if (!actionDefinition) {
    return { ...baseEntry, status: 'failed', error: `unknown schedule action: ${item.action}` };
  }
  if (payload.kind !== 'youtube-upload') {
    return { ...baseEntry, status: 'failed', error: `unsupported schedule payload kind: ${payload.kind || 'none'}` };
  }

  const running = findRunningRenderJob();
  if (running) {
    return { ...baseEntry, status: 'skipped', reason: `render job ${running.id} is already ${running.status}` };
  }

  const options = normalizeOptions({ ...(payload.renderOptions || {}), dryRun });
  options.scheduleSource = { itemId: item.id, title: item.title, action: item.action, runKey, runId: baseEntry.id, checkedAt: baseEntry.checkedAt };
  const job = startRender(options);
  return { ...baseEntry, status: dryRun ? 'dry-run' : 'started', jobId: job.id, renderOptions: options, command: job.command };
}

function runScheduleCheck({ dryRun = false, now = new Date() } = {}) {
  const slot = scheduleSlotForDate(now);
  const schedule = loadSchedule();
  const state = loadScheduleRunState();
  const dueItems = (schedule.items || []).filter((item) => scheduleItemDueInSlot(item, slot));
  const results = [];
  for (const item of dueItems) {
    const runKey = scheduleRunKey(item, slot);
    if (!dryRun && state.lastRunByItem?.[item.id] === runKey) {
      results.push({ itemId: item.id, title: item.title, action: item.action, runKey, status: 'already-ran', slot });
      continue;
    }
    const result = executeScheduleAction(item, slot, { dryRun });
    results.push(result);
    if (!dryRun && ['started', 'skipped', 'failed'].includes(result.status)) {
      appendScheduleRun(result);
      state.lastRunByItem[item.id] = runKey;
    }
  }
  scheduleWorker.lastCheckedAt = new Date().toISOString();
  scheduleWorker.lastResult = { slot, dueCount: dueItems.length, results };
  return scheduleWorker.lastResult;
}

function scheduleNextWorkerCheck(delayMs = scheduleWorker.intervalMs) {
  if (scheduleWorker.timer) clearTimeout(scheduleWorker.timer);
  scheduleWorker.nextCheckAt = new Date(Date.now() + delayMs).toISOString();
  scheduleWorker.timer = setTimeout(async () => {
    scheduleWorker.running = true;
    try { runScheduleCheck(); }
    catch (error) { scheduleWorker.lastResult = { error: error.message, checkedAt: new Date().toISOString() }; }
    finally {
      scheduleWorker.running = false;
      scheduleNextWorkerCheck(scheduleWorker.intervalMs);
    }
  }, delayMs);
  scheduleWorker.timer.unref?.();
}

function startScheduleWorker() {
  scheduleWorker.startedAt = new Date().toISOString();
  scheduleNextWorkerCheck(5_000);
}

const gameServer = {
  status: 'stopped',
  child: null,
  pid: null,
  startedAt: null,
  stoppedAt: null,
  exitCode: null,
  signal: null,
  error: null,
  log: '',
};

function appendGameServerLog(chunk) {
  gameServer.log += chunk.toString();
  if (gameServer.log.length > 60000) gameServer.log = gameServer.log.slice(-60000);
}

function probeUrl(url, timeoutMs = 900) {
  return new Promise((resolve) => {
    const client = String(url).startsWith('https:') ? https : http;
    const req = client.get(url, (res) => {
      res.resume();
      resolve({ online: true, statusCode: res.statusCode });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ online: false, statusCode: null });
    });
    req.on('error', () => resolve({ online: false, statusCode: null }));
  });
}

function runLaunchctl(args) {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function getLaunchAgentDomainTarget() {
  return `gui/${process.getuid?.() ?? Number(process.env.UID || 501)}`;
}

function getDashboardLaunchAgentStatus() {
  const domainTarget = getLaunchAgentDomainTarget();
  const print = runLaunchctl(['print', `${domainTarget}/${DASHBOARD_LAUNCH_AGENT_LABEL}`]);
  const pidMatch = print.stdout.match(/\bpid\s*=\s*(\d+)/);
  const stateMatch = print.stdout.match(/\bstate\s*=\s*([^\n]+)/);
  return {
    label: DASHBOARD_LAUNCH_AGENT_LABEL,
    plist: DASHBOARD_LAUNCH_AGENT_PLIST,
    domainTarget,
    loaded: print.ok,
    state: stateMatch ? stateMatch[1].trim() : (print.ok ? 'loaded' : 'not-loaded'),
    pid: pidMatch ? Number(pidMatch[1]) : null,
    error: print.ok ? null : (print.stderr || print.stdout || `launchctl print exited ${print.status}`),
  };
}

function killProcessOnPort(port) {
  try {
    const result = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8', timeout: 5000 });
    const pids = (result.stdout || '').trim().split(/\s+/).filter(Boolean);
    if (!pids.length) return { port, killed: 0, pids: [] };
    spawnSync('kill', pids, { timeout: 3000 });
    // Wait a tick then force-kill any survivors
    setTimeout(() => {
      try {
        const check = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8', timeout: 3000 });
        const survivors = (check.stdout || '').trim().split(/\s+/).filter(Boolean);
        if (survivors.length) spawnSync('kill', ['-9', ...survivors], { timeout: 2000 });
      } catch { /* best effort */ }
    }, 800).unref();
    return { port, killed: pids.length, pids };
  } catch (error) {
    return { port, killed: 0, pids: [], error: error.message };
  }
}

function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    ...options,
  });
  child.unref();
  return child.pid;
}

function restartRenderStack({ dryRun = false } = {}) {

  const results = {
    viteDev: { port: 5174, action: 'none' },
    proxyHttps: { action: 'none' },
  };

  if (dryRun) {
    results.viteDev.action = 'dry-run';
    results.proxyHttps.action = 'dry-run';
    return results;
  }

  // Kill & restart Vite dev server
  const viteKillResult = killProcessOnPort(5174);
  results.viteDev.kill = viteKillResult;
  if (viteKillResult.killed > 0) {
    results.viteDev.pid = spawnDetached('npm', ['run', 'dev:backend'], { cwd: rootDir });
    results.viteDev.action = 'restarted';
  } else {
    results.viteDev.action = 'not-running';
  }

  // Check if proxy was running before we killed anything
  let proxyWasRunning = false;
  try {
    const check = spawnSync('pgrep', ['-f', 'marble-https-proxy.js'], { encoding: 'utf8', timeout: 2000 });
    proxyWasRunning = check.status === 0 && (check.stdout || '').trim().length > 0;
  } catch { proxyWasRunning = false; }

  // Kill & restart HTTPS proxy
  if (proxyWasRunning) {
    try { spawnSync('pkill', ['-f', 'marble-https-proxy.js'], { encoding: 'utf8', timeout: 3000 }); } catch { /* best effort */ }
    results.proxyHttps.pid = spawnDetached('npm', ['run', 'proxy:https'], { cwd: rootDir });
    results.proxyHttps.action = 'restarted';
  } else {
    results.proxyHttps.action = 'not-running';
  }

  return results;
}

function restartDashboardServer({ dryRun = false } = {}) {
  const domainTarget = getLaunchAgentDomainTarget();
  const serviceTarget = `${domainTarget}/${DASHBOARD_LAUNCH_AGENT_LABEL}`;
  const command = ['launchctl', 'kickstart', '-k', serviceTarget];
  const before = getDashboardLaunchAgentStatus();
  if (dryRun) {
    const renderStack = restartRenderStack({ dryRun: true });
    return {
      restarted: false,
      dryRun: true,
      command: command.join(' '),
      before,
      renderStack,
      message: 'dry-run only; dashboard server was not restarted',
    };
  }
  if (!existsSync(DASHBOARD_LAUNCH_AGENT_PLIST)) {
    return {
      restarted: false,
      dryRun: false,
      command: command.join(' '),
      before,
      error: `LaunchAgent plist not found: ${DASHBOARD_LAUNCH_AGENT_PLIST}`,
    };
  }
  // Kill and restart the render stack (Vite, proxy, Chrome CDP) BEFORE kicking dashboard
  const renderStack = restartRenderStack({ dryRun: false });
  setTimeout(() => {
    const child = spawn(command[0], command.slice(1), { detached: true, stdio: 'ignore' });
    child.unref();
  }, 250);
  return {
    restarted: true,
    scheduled: true,
    dryRun: false,
    command: command.join(' '),
    before,
    renderStack,
    message: 'render stack + dashboard restart scheduled; this HTTP connection may drop while launchd restarts the server',
  };
}

async function publicGameServerStatus() {
  const probe = await probeUrl(ACTIVE_SERVER_URL);
  const managedRunning = Boolean(gameServer.child && !gameServer.child.killed && ['starting', 'running'].includes(gameServer.status));
  const status = managedRunning ? (probe.online ? 'running' : gameServer.status) : (probe.online ? 'external-running' : gameServer.status === 'stopping' ? 'stopping' : 'stopped');
  return {
    ok: true,
    status,
    url: ACTIVE_SERVER_URL,
    host: ACTIVE_SERVER_HOST,
    port: ACTIVE_SERVER_PORT,
    managed: managedRunning,
    pid: managedRunning ? gameServer.pid : null,
    startedAt: gameServer.startedAt,
    stoppedAt: gameServer.stoppedAt,
    exitCode: gameServer.exitCode,
    signal: gameServer.signal,
    error: gameServer.error,
    httpOnline: probe.online,
    httpStatusCode: probe.statusCode,
    log: gameServer.log.slice(-16000),
  };
}

async function startGameServer() {
  const current = await publicGameServerStatus();
  if (['running', 'starting', 'external-running'].includes(current.status)) {
    return { started: false, reason: 'already-running', server: current };
  }

  gameServer.status = 'starting';
  gameServer.startedAt = new Date().toISOString();
  gameServer.stoppedAt = null;
  gameServer.exitCode = null;
  gameServer.signal = null;
  gameServer.error = null;
  gameServer.log = `[game-server] Starting ${ACTIVE_SERVER_URL}\n`;

  const [serverBin, ...serverArgs] = splitCommand(activeGame.server.startCommand);
  const child = spawn(serverBin || 'npm', serverArgs, {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
  });
  gameServer.child = child;
  gameServer.pid = child.pid;

  child.stdout.on('data', (chunk) => {
    appendGameServerLog(chunk);
    if (/Local:|ready in|VITE/i.test(chunk.toString())) gameServer.status = 'running';
  });
  child.stderr.on('data', appendGameServerLog);
  child.on('error', (error) => {
    gameServer.status = 'failed';
    gameServer.error = error.message;
    gameServer.stoppedAt = new Date().toISOString();
  });
  child.on('exit', (code, signal) => {
    gameServer.exitCode = code;
    gameServer.signal = signal;
    gameServer.stoppedAt = new Date().toISOString();
    gameServer.status = code === 0 || signal === 'SIGTERM' ? 'stopped' : 'failed';
    gameServer.child = null;
    gameServer.pid = null;
    if (code !== 0 && signal !== 'SIGTERM' && !gameServer.error) gameServer.error = `game server exited with ${code ?? signal}`;
  });

  return { started: true, server: await publicGameServerStatus() };
}

async function stopGameServer() {
  const current = await publicGameServerStatus();
  if (!gameServer.child || !['running', 'starting'].includes(gameServer.status)) {
    return { stopped: false, reason: current.status === 'external-running' ? 'external-process-not-managed' : 'not-running', server: current };
  }
  gameServer.status = 'stopping';
  appendGameServerLog('\n[game-server] Stopping by dashboard request...\n');
  gameServer.child.kill('SIGTERM');
  return { stopped: true, server: await publicGameServerStatus() };
}

function dashboardHtml() {
  const obstacleChecks = Object.entries(OBSTACLE_CATEGORIES).map(([categoryKey, category]) => {
    const types = OBSTACLE_TYPES.filter((type) => type.category === categoryKey);
    const body = types.length
      ? types.map((type) => `
        <label class="check"><input type="checkbox" name="obstacleTypes" value="${type.value}" data-obstacle-category="${categoryKey}" checked> <span>${type.label}</span></label>
      `).join('')
      : `<p class="muted category-note">${category.description}</p>`;
    return `
      <fieldset class="obstacle-category" data-dashboard-obstacle-category="${categoryKey}">
        <legend>${category.label}</legend>
        ${body}
      </fieldset>
    `;
  }).join('');
  const densityOptions = DENSITY_PRESETS.map((density) => `
    <option value="${density.value}" ${density.value === 'many' ? 'selected' : ''}>${density.label}</option>
  `).join('');
  const obstacleDistributionOptions = OBSTACLE_DISTRIBUTION_MODES.map((mode) => `
    <option value="${mode.value}" ${mode.value === 'random' ? 'selected' : ''}>${mode.label}</option>
  `).join('');
  const backgroundRecordModeCards = BACKGROUND_RECORD_MODES.map((mode) => `
    <label class="record-mode-card" data-background-record-mode="${mode.key}">
      <input type="radio" name="recordMode" value="${mode.value}" ${mode.value === 'continuous' ? 'checked' : ''}>
      <b>${mode.label}</b>
      <span>${mode.description}</span>
    </label>
  `).join('');

  const ttsVoiceOptions = ['Rishi', 'Tom (Enhanced)', 'Samantha', 'Alex', 'Daniel', 'Moira', 'Karen', 'Tessa'].map((voice) => `
    <option value="${voice}" ${voice === 'Alex' ? 'selected' : ''}>${voice}</option>
  `).join('');
  const thumbnailTitleOptions = THUMBNAIL_TITLE_PRESETS.map((title) => `
    <option value="${title}">${title}</option>
  `).join('');

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Game Ops Dashboard</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --panel: rgba(12,18,32,.84); --line: rgba(255,255,255,.11); --muted: #96a4bc; --text: #f4f7fb; --accent: #8ef4ff; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top left, #203052, #080b12 48%, #05060a); color: var(--text); font-size: 14px; }
    main { max-width: 1440px; margin: 0 auto; padding: 16px; }
    .topbar { position: sticky; top: 0; z-index: 5; display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: center; margin: -16px -16px 12px; padding: 12px 16px; background: rgba(5,8,15,.86); border-bottom: 1px solid var(--line); backdrop-filter: blur(18px); }
    h1 { margin: 0; font-size: 22px; letter-spacing: -.03em; }
    h2 { margin: 0; font-size: 15px; letter-spacing: -.01em; }
    h3 { margin: 0; font-size: 13px; color: #dfe8fb; }
    .sub { color: var(--muted); margin: 2px 0 0; line-height: 1.35; font-size: 12px; }
    .shell { display: grid; grid-template-columns: 280px minmax(360px, 1fr) 420px; gap: 12px; align-items: start; }
    .stack { display: grid; gap: 12px; }
    .card { border: 1px solid var(--line); background: var(--panel); box-shadow: 0 18px 54px rgba(0,0,0,.26); border-radius: 18px; padding: 14px; backdrop-filter: blur(16px); }
    .card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
    .game-card { display: grid; gap: 10px; padding: 12px; border-radius: 16px; background: rgba(255,255,255,.055); border: 1px solid rgba(255,255,255,.09); }
    .game-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .game-badge { font-size: 11px; color: #06101c; background: linear-gradient(135deg, #8ef4ff, #b49cff); border-radius: 999px; padding: 4px 7px; font-weight: 900; }
    .quick-actions, .actions, .server-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .dashboard-actions { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.08); }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .stat { padding: 8px; border-radius: 13px; background: rgba(255,255,255,.055); border: 1px solid rgba(255,255,255,.075); }
    .stat b { display: block; font-size: 12px; color: #dce7fb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .stat span { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; }
    label { display: block; font-weight: 800; margin: 9px 0 5px; color: #e8eefb; font-size: 12px; }
    input[type="text"], input[type="number"], select { width: 100%; border: 1px solid rgba(255,255,255,.14); border-radius: 12px; padding: 9px 10px; background: rgba(255,255,255,.08); color: #fff; outline: none; font: inherit; min-height: 38px; }
    select option { color: #111; }
    .form-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; }
    .wide { grid-column: span 2; }
    .full { grid-column: 1 / -1; }
    .checks { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .obstacle-category { margin: 0; border: 1px solid rgba(255,255,255,.09); border-radius: 13px; padding: 8px; background: rgba(255,255,255,.04); }
    .obstacle-category legend { padding: 0 5px; color: #dfe8fb; font-weight: 900; font-size: 12px; }
    .obstacle-category .check + .check { margin-top: 6px; }
    .category-note { margin: 6px 0 0; line-height: 1.35; }
    .check { display: flex; align-items: center; gap: 8px; margin: 0; padding: 8px 9px; border-radius: 12px; background: rgba(255,255,255,.055); font-weight: 700; font-size: 12px; min-height: 36px; }
    button { border: 0; border-radius: 12px; padding: 9px 12px; min-height: 36px; font-weight: 900; color: #07111d; background: linear-gradient(135deg, #8ef4ff, #b49cff); cursor: pointer; font-size: 12px; }
    button.secondary { background: rgba(255,255,255,.11); color: #f4f7fb; border: 1px solid rgba(255,255,255,.14); }
    button.danger { background: #ff7e8d; color: #22070b; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    .status { display: inline-flex; align-items: center; gap: 7px; border-radius: 999px; padding: 7px 10px; background: rgba(255,255,255,.075); color: #cfdbf2; font-weight: 800; font-size: 12px; white-space: nowrap; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; flex: 0 0 auto; }
    .dot.running { background: #38bdf8; box-shadow: 0 0 16px #38bdf8; }
    .dot.completed { background: #34d399; box-shadow: 0 0 16px #34d399; }
    .dot.failed { background: #fb7185; box-shadow: 0 0 16px #fb7185; }
    pre { white-space: pre-wrap; word-break: break-word; max-height: 280px; overflow: auto; padding: 11px; border-radius: 13px; background: #050812; color: #dbeafe; border: 1px solid rgba(255,255,255,.08); font-size: 12px; line-height: 1.35; margin: 8px 0 0; }
    .mini-log { max-height: 150px; }
    .recording { display: flex; justify-content: space-between; gap: 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,.08); }
    .recording-actions { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .recording-actions button, .recording-actions a { font-size: 11px; padding: 7px 9px; min-height: 30px; }
    .thumb-preview { width: 100%; max-width: 360px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 14px; border: 1px solid rgba(255,255,255,.14); background: rgba(0,0,0,.35); margin-top: 8px; }
    .title-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; align-items: end; }
    .thumbnail-panel { border: 1px solid rgba(142,244,255,.28); border-radius: 14px; padding: 10px; background: rgba(142,244,255,.075); }
    a { color: var(--accent); text-decoration: none; }
    .muted { color: var(--muted); font-size: 12px; }
    .pill { display: inline-block; border: 1px solid rgba(255,255,255,.13); border-radius: 999px; padding: 4px 8px; color: #cad7ef; font-size: 11px; margin: 4px 4px 0 0; }
    .section-divider { height: 1px; background: var(--line); margin: 12px 0 10px; }
    .record-mode-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .record-mode-card { position: relative; display: grid; gap: 4px; margin: 0; padding: 10px 10px 10px 34px; border-radius: 14px; background: rgba(255,255,255,.055); border: 1px solid rgba(255,255,255,.09); font-weight: 800; min-height: 78px; }
    .record-mode-card input { position: absolute; left: 10px; top: 12px; }
    .record-mode-card:has(input:checked) { border-color: rgba(142,244,255,.62); box-shadow: inset 0 0 0 1px rgba(142,244,255,.22); background: rgba(142,244,255,.12); }
    .record-mode-card b { font-size: 13px; color: #f4f7fb; }
    .record-mode-card span { color: var(--muted); font-size: 11px; line-height: 1.3; }
    .record-mode-extra { margin-top: 8px; display: grid; grid-template-columns: minmax(0, 180px) 1fr; gap: 10px; align-items: end; }
    .progress-shell { height: 14px; border-radius: 999px; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.12); overflow: hidden; margin: 10px 0 6px; }
    .progress-bar { height: 100%; width: 0%; background: linear-gradient(90deg, #8ef4ff, #b49cff); transition: width .35s ease; }
    .record-mode-extra .muted { padding-bottom: 8px; }
    details { border-radius: 14px; background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.075); padding: 9px; }
    summary { cursor: pointer; font-weight: 900; font-size: 12px; color: #eaf1ff; }
    .tabs { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 12px; }
    .tab-btn { color: #f4f7fb; background: rgba(255,255,255,.09); border: 1px solid rgba(255,255,255,.13); }
    .tab-btn.active { color: #06101c; background: linear-gradient(135deg, #8ef4ff, #b49cff); }
    .tab-panel[hidden] { display: none !important; }
    .schedule-layout { display: grid; grid-template-columns: minmax(520px, 1fr) 340px; gap: 12px; align-items: start; }
    .schedule-week-tabs { position: sticky; top: 64px; z-index: 4; display: flex; gap: 7px; flex-wrap: wrap; margin: 10px 0; padding: 8px 0; border-radius: 14px; background: rgba(12,18,32,.94); backdrop-filter: blur(14px); }
    .schedule-day-btn { color: #f4f7fb; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.12); padding: 8px 10px; }
    .schedule-day-btn.active { color: #06101c; background: linear-gradient(135deg, #8ef4ff, #b49cff); }
    .schedule-grid { display: grid; gap: 7px; }
    .schedule-hour { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 8px; align-items: stretch; }
    .schedule-time { color: #dce7fb; font-weight: 900; padding-top: 10px; text-align: right; font-variant-numeric: tabular-nums; }
    .schedule-hour.current-hour .schedule-time { color: #8ef4ff; text-shadow: 0 0 12px rgba(142,244,255,.45); }
    .schedule-hour.current-hour .schedule-slot { border-color: rgba(142,244,255,.55); box-shadow: inset 0 0 0 1px rgba(142,244,255,.22); }
    .schedule-slot { min-height: 42px; border: 1px solid rgba(255,255,255,.08); border-radius: 13px; background: rgba(255,255,255,.045); padding: 6px; display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start; }
    .schedule-item { display: inline-grid; gap: 2px; min-width: 172px; max-width: 100%; border-radius: 12px; padding: 7px 9px; background: rgba(148,163,184,.12); border: 1px solid rgba(148,163,184,.32); color: #f4f7fb; text-align: left; }
    .schedule-item.disabled { opacity: .52; filter: grayscale(.35); }
    .schedule-item.never-run { background: rgba(148,163,184,.12); border-color: rgba(148,163,184,.36); }
    .schedule-item.started, .schedule-item.dry-run { background: rgba(56,189,248,.13); border-color: rgba(56,189,248,.52); }
    .schedule-item.completed { background: rgba(52,211,153,.14); border-color: rgba(52,211,153,.58); }
    .schedule-item.skipped, .schedule-item.already-ran { background: rgba(250,204,21,.13); border-color: rgba(250,204,21,.54); }
    .schedule-item.failed { background: rgba(251,113,133,.16); border-color: rgba(251,113,133,.68); }
    .schedule-item b { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .schedule-item span, .schedule-run-status { color: var(--muted); font-size: 11px; }
    .schedule-run-status { display: inline-flex; align-items: center; gap: 4px; font-weight: 900; }
    .run-dot { width: 7px; height: 7px; border-radius: 50%; background: #94a3b8; display: inline-block; }
    .run-dot.started, .run-dot.dry-run { background: #38bdf8; box-shadow: 0 0 10px #38bdf8; }
    .run-dot.completed { background: #34d399; box-shadow: 0 0 10px #34d399; }
    .run-dot.skipped, .run-dot.already-ran { background: #facc15; box-shadow: 0 0 10px #facc15; }
    .run-dot.failed { background: #fb7185; box-shadow: 0 0 10px #fb7185; }
    .schedule-log-list { display: grid; gap: 6px; margin-top: 8px; }
    .schedule-log-entry { border: 1px solid rgba(255,255,255,.09); border-left-width: 4px; border-radius: 12px; padding: 7px 9px; background: rgba(255,255,255,.045); font-size: 12px; }
    .schedule-log-entry.completed { border-left-color: #34d399; }
    .schedule-log-entry.started, .schedule-log-entry.dry-run { border-left-color: #38bdf8; }
    .schedule-log-entry.skipped, .schedule-log-entry.already-ran { border-left-color: #facc15; }
    .schedule-log-entry.failed { border-left-color: #fb7185; }
    .schedule-log-entry b { display: block; margin-bottom: 2px; }
    .schedule-log-entry span { color: var(--muted); }
    .schedule-form { position: sticky; top: 82px; }
    textarea { width: 100%; border: 1px solid rgba(255,255,255,.14); border-radius: 12px; padding: 9px 10px; background: rgba(255,255,255,.08); color: #fff; outline: none; font: inherit; min-height: 76px; resize: vertical; }
    .schedule-empty { color: var(--muted); font-size: 12px; padding: 7px; }
    @media (max-width: 980px) { .schedule-layout { grid-template-columns: 1fr; } .schedule-form { position: static; } }
    @media (max-width: 760px) { .record-mode-grid, .record-mode-extra { grid-template-columns: 1fr; } }
    @media (max-width: 1180px) { .shell { grid-template-columns: 260px 1fr; } .right-pane { grid-column: 1 / -1; } }
    @media (max-width: 760px) { main { padding: 10px; } .topbar { grid-template-columns: 1fr; margin: -10px -10px 10px; } .shell, .form-grid { grid-template-columns: 1fr; } .wide { grid-column: auto; } .checks { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <section class="topbar">
      <div>
        <h1>Game Ops Dashboard</h1>
        <p class="sub">Compact multi-game control surface · Dashboard port ${PORT} · services / recording / renders</p>
      </div>
      <div class="status"><span id="serverDot" class="dot"></span><span id="serverStatusText">Checking server...</span></div>
      <div class="status"><span id="statusDot" class="dot"></span><span id="statusText">Idle</span></div>
    </section>

    <nav class="tabs" aria-label="Dashboard tabs">
      <button class="tab-btn active" type="button" data-tab-target="renderTab">Render</button>
      <button class="tab-btn" type="button" data-tab-target="scheduleTab">Schedule</button>
      <button class="tab-btn" type="button" data-tab-target="jobsTab">Jobs</button>
    </nav>

    <section id="renderTab" class="tab-panel shell">
      <aside class="stack">
        <section class="card">
          <div class="card-head"><h2>Games</h2><span class="muted">${games.length} configured</span></div>
          <div class="game-card">
            <div class="game-title"><h3>${activeGame.name}</h3><span class="game-badge">${activeGame.badge || 'READY'}</span></div>
            <div class="stats">
              <div class="stat"><b id="gameServiceStat">...</b><span>service</span></div>
              <div class="stat"><b>${activeGame.runtime || 'runtime'}</b><span>runtime</span></div>
              <div class="stat"><b>Record</b><span>${activeGame.capability || 'render'}</span></div>
            </div>
            <a id="serverOpenLink" href="${ACTIVE_SERVER_URL}" target="_blank" rel="noreferrer">Open game ↗</a>
            <div class="quick-actions">
              <button id="serverStartBtn" type="button">Start</button>
              <button id="serverStopBtn" class="danger" type="button">Stop</button>
              <button id="serverRefreshBtn" class="secondary" type="button">Refresh</button>
            </div>
            <div class="quick-actions dashboard-actions">
              <button id="dashboardRestartBtn" class="danger" type="button">Restart dashboard</button>
              <span id="dashboardRestartStatus" class="muted">LaunchAgent: ${DASHBOARD_LAUNCH_AGENT_LABEL}</span>
            </div>
            <div id="serverMeta" class="muted">URL: ${ACTIVE_SERVER_URL}</div>
          </div>
          <p class="muted">Dashboard 已抽離成獨立專案；之後新遊戲只要加入 config/games.json。</p>
        </section>

        <section class="card">
          <div class="card-head"><h2>Server Log</h2><span class="muted">live</span></div>
          <pre id="serverLog" class="mini-log">等待 server 狀態...</pre>
        </section>
      </aside>

      <form id="renderForm" class="card">
        <div class="card-head"><h2>${activeGame.name} Render</h2><span class="muted">background recording</span></div>
        <div class="form-grid">
          <div class="wide">
            <label for="cupName">Cup 名稱（Dashboard 不會傳去 render，只作備註）</label>
            <input id="cupName" name="cupName" type="text" value="" maxlength="80" placeholder="可留空；影片不顯示、不傳 --cup-name">
          </div>
          <div>
            <label for="cupSize">波子數目</label>
            <input id="cupSize" name="cupSize" type="number" min="2" max="99" step="1" value="12">
          </div>
          <div>
            <label for="format">格式</label>
            <select id="format" name="format"><option value="mp4" selected>MP4 + comparison WebM</option><option value="webm">WebM only</option></select>
          </div>
          <div>
            <label for="videoCapture">錄影來源</label>
            <select id="videoCapture" name="videoCapture">
              <option value="canvas" selected>Canvas stream（default）</option>
              <option value="playwright">Playwright viewport</option>
            </select>
          </div>
          <div>
            <label for="qualityPreset">畫質</label>
            <select id="qualityPreset" name="qualityPreset">
              <option value="1080p-smooth" selected>1080p Smooth（1920×1080 / 60fps / CRF18 / veryfast）</option>
            </select>
          </div>
          <div>
            <label for="renderPerformanceProfile">效能模式</label>
            <select id="renderPerformanceProfile" name="renderPerformanceProfile">
              <option value="turbo60" selected>Turbo 60（高效能）</option>
            </select>
          </div>
          <div>
            <label for="videoCanvasLayout">影片畫面</label>
            <select id="videoCanvasLayout" name="videoCanvasLayout">
              <option value="horizontal" selected>Horizontal 16:9</option>
              <option value="vertical">Vertical 9:16 Shorts</option>
            </select>
          </div>
          <div>
            <label for="density">障礙密度</label>
            <select id="density" name="density">${densityOptions}</select>
          </div>
          <div>
            <label for="obstacleDistribution">障礙分佈</label>
            <select id="obstacleDistribution" name="obstacleDistribution">${obstacleDistributionOptions}</select>
          </div>
          <div>
            <label for="lengthMode">片長 / 賽道模式</label>
            <select id="lengthMode" name="lengthMode"><option value="target-duration" selected>控制整條片長</option><option value="fixed-track">控制每場賽道長度</option></select>
          </div>
          <div>
            <label for="targetMinutes">目標片長（分鐘）</label>
            <input id="targetMinutes" name="targetMinutes" type="number" min="1" max="120" step="0.5" value="${CUP_VIDEO_DEFAULTS.targetMinutes}">
          </div>
          <div>
            <label for="trackLength">每場賽道長度（m）</label>
            <input id="trackLength" name="trackLength" type="number" min="80" max="3000" step="10" value="${CUP_VIDEO_DEFAULTS.trackLength}">
          </div>
          <div>
            <label for="timeout">Timeout</label>
            <input id="timeout" name="timeout" type="number" min="120" max="3600" value="${CUP_VIDEO_DEFAULTS.timeout}">
          </div>
          <div>
            <label for="ttsVoice">TTS</label>
            <select id="ttsVoice" name="ttsVoice">${ttsVoiceOptions}</select>
          </div>
          <label class="check"><input id="audio" name="audio" type="checkbox" checked> <span>遊戲音訊</span></label>
          <label class="check thumbnail-toggle"><input id="thumbnail" name="thumbnail" type="checkbox" checked> <span>YouTube thumbnail 會自動生成</span></label>
          <label class="check"><input id="uploadYoutube" name="uploadYoutube" type="checkbox"> <span>完成後上傳 YouTube（預設關閉；要公開前先用 Private/Unlisted 驗證）</span></label>
          <div>
            <label for="youtubePrivacy">YouTube privacy</label>
            <select id="youtubePrivacy" name="youtubePrivacy">
              <option value="private" selected>Private（safe test）</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public（確認後先好用）</option>
            </select>
          </div>
          <div class="wide thumbnail-panel" data-dashboard-section="thumbnail-controls">
            <label for="thumbnailTitle">Thumbnail 大字 override（留空＝按 event 自動揀近期不重覆標題）</label>
            <div class="title-row">
              <input id="thumbnailTitle" name="thumbnailTitle" type="text" value="" maxlength="80" placeholder="留空自動揀；輸入才 override" list="thumbnailTitlePresets">
              <button id="randomTitleBtn" class="secondary" type="button">Random</button>
              <button id="testThumbnailBtn" class="secondary" type="button">Test latest thumbnail</button>
            </div>
            <datalist id="thumbnailTitlePresets">${thumbnailTitleOptions}</datalist>
            <p class="muted">預設會輸出 MP4，並同時產生 comparison WebM；thumbnail 預設開啟。留空 Thumbnail 大字時，由 render 根據 event 自動選近期不重覆標題。YouTube upload 預設關閉；如果要測試上傳，先用 Private/Unlisted，確認 metadata/thumbnail 無誤後才改 Public。</p>
          </div>
        </div>

        <div class="section-divider"></div>
        <section aria-label="Background Record" data-dashboard-section="background-record-categories">
          <div class="card-head"><h2>Background Record</h2><span class="muted">Multiple / Cup Mode</span></div>
          <div class="record-mode-grid">${backgroundRecordModeCards}</div>
          <div class="record-mode-extra">
            <div>
              <label for="multipleRaceCount">Multiple 場數</label>
              <input id="multipleRaceCount" name="multipleRaceCount" type="number" min="1" max="99" value="5">
            </div>
            <div id="recordModeHint" class="muted">Cup Mode: background tournament recording.</div>
          </div>
        </section>

        <div class="section-divider"></div>
        <details open>
          <summary>障礙物種類 / 分類</summary>
          <div class="checks" style="margin-top:8px">${obstacleChecks}</div>
          <p class="muted">Dashboard now mirrors the game categories: 普通 / 增益 / 減益. Empty categories are reserved so future obstacle add/remove changes are visible here too.</p>
          <div class="actions">
            <button type="button" class="secondary" id="allTypes">全選</button>
            <button type="button" class="secondary" id="bumperOnly">只選 Bumper</button>
            <button type="button" class="secondary" id="clearTypes">清空=全部</button>
          </div>
        </details>

        <div class="actions">
          <button id="startBtn" type="submit">Start render</button>
          <button id="stopBtn" class="danger" type="button" disabled>Stop job</button>
          <span class="muted">Cup Mode uses one unified track length for every stage.</span>
        </div>
      </form>

      <aside class="stack right-pane">
        <section class="card">
          <div class="card-head"><h2>Current Job</h2><span class="muted">render log</span></div>
          <div id="jobMeta" class="muted">尚未開始</div>
          <div class="progress-shell" aria-label="render progress"><div id="progressBar" class="progress-bar"></div></div>
          <div id="progressText" class="muted">Progress 0%</div>
          <div id="jobPills"></div>
          <pre id="log">等待生成...</pre>
        </section>
        <section class="card">
          <div class="card-head"><h2>Recent Outputs</h2><button class="secondary" type="button" onclick="refreshRecordings()">Refresh</button></div>
          <div id="recordings"></div>
        </section>
      </aside>
    </section>

    <section id="scheduleTab" class="tab-panel" hidden>
      <div class="schedule-layout">
        <section class="card">
          <div class="card-head"><h2>Hourly Schedule</h2><span id="scheduleStatus" class="muted">Loading...</span></div>
          <p class="sub">每日 / 每週 + 小時計時間表。背景 worker 每 5 分鐘讀取 due items，根據 action/payload 觸發相應動作；同一個 5 分鐘 slot 只會執行一次。</p>
          <div class="card" style="margin:10px 0;padding:10px;background:rgba(255,255,255,.045)">
            <div class="card-head"><h2>Schedule Worker</h2><span id="scheduleWorkerStatus" class="muted">Checking...</span></div>
            <div id="scheduleWorkerMeta" class="muted">每 5 分鐘自動檢查</div>
            <div class="actions" style="margin-top:8px"><button id="scheduleWorkerCheckBtn" class="secondary" type="button">Check now (dry-run)</button></div>
          </div>
          <div id="scheduleWeekTabs" class="schedule-week-tabs" aria-label="schedule weekdays"></div>
          <div id="scheduleGrid" class="schedule-grid" aria-label="hourly schedule"></div>
        </section>
        <form id="scheduleForm" class="card schedule-form">
          <div class="card-head"><h2 id="scheduleFormTitle">Add item</h2><button id="scheduleNewBtn" class="secondary" type="button">New</button></div>
          <input id="scheduleItemId" type="hidden" value="">
          <label for="scheduleTitle">項目名稱</label>
          <input id="scheduleTitle" type="text" maxlength="120" placeholder="例如：Render Marble Rush" required>
          <div class="form-grid">
            <div><label for="scheduleRecurrence">重複</label><select id="scheduleRecurrence">${SCHEDULE_RECURRENCES.map((entry) => `<option value="${entry.value}">${entry.zh} / ${entry.label}</option>`).join('')}</select></div>
            <div><label for="scheduleWeekday">星期（每週用）</label><select id="scheduleWeekday">${SCHEDULE_WEEKDAYS.map((day) => `<option value="${day.value}">${day.zh} / ${day.label}</option>`).join('')}</select></div>
          </div>
          <div class="form-grid">
            <div class="wide"><label for="scheduleTimes">執行時間</label><input id="scheduleTimes" type="text" value="09:00" placeholder="例如：09:00, 12:00, 18:30"><span class="muted">可輸入多個時間；分鐘會對齊 5 分鐘 slot。</span></div>
            <div class="wide"><label for="scheduleAction">Action key</label><select id="scheduleAction">${SCHEDULE_ACTIONS.map((action) => `<option value="${action.value}">${action.label}</option>`).join('')}</select></div>
          </div>
          <label class="check"><input id="scheduleEnabled" type="checkbox" checked> <span>Enabled</span></label>
          <label for="schedulePayload">Payload JSON（比之後 background job 用）</label>
          <textarea id="schedulePayload" spellcheck="false" placeholder='{"game":"marble-rush"}'></textarea>
          <label for="scheduleNotes">備註</label>
          <textarea id="scheduleNotes" placeholder="可寫低執行細節或提醒"></textarea>
          <div class="actions"><button id="scheduleSaveBtn" type="submit">Save item</button><button id="scheduleDeleteBtn" class="danger" type="button" disabled>Delete</button></div>
          <pre id="scheduleLog" class="mini-log">等待 schedule...</pre>
        </form>
      </div>
    </section>

    <section id="jobsTab" class="tab-panel" hidden>
      <div class="schedule-layout">
        <section class="card" style="grid-column:1/-1">
          <div class="card-head"><h2>All Jobs</h2><button id="jobsRefreshBtn" class="secondary" type="button">Refresh</button></div>
          <div id="jobsList"><p class="muted">Loading...</p></div>
        </section>
      </div>
    </section>
  </main>

<script>
const form = document.querySelector('#renderForm');
const logEl = document.querySelector('#log');
const statusText = document.querySelector('#statusText');
const statusDot = document.querySelector('#statusDot');
const jobMeta = document.querySelector('#jobMeta');
const jobPills = document.querySelector('#jobPills');
const progressBar = document.querySelector('#progressBar');
const progressText = document.querySelector('#progressText');
const recEl = document.querySelector('#recordings');
const startBtn = document.querySelector('#startBtn');
const stopBtn = document.querySelector('#stopBtn');
const serverDot = document.querySelector('#serverDot');
const serverStatusText = document.querySelector('#serverStatusText');
const serverMeta = document.querySelector('#serverMeta');
const serverLog = document.querySelector('#serverLog');
const serverStartBtn = document.querySelector('#serverStartBtn');
const serverStopBtn = document.querySelector('#serverStopBtn');
const serverRefreshBtn = document.querySelector('#serverRefreshBtn');
const serverOpenLink = document.querySelector('#serverOpenLink');
const gameServiceStat = document.querySelector('#gameServiceStat');
const recordModeHint = document.querySelector('#recordModeHint');
const multipleRaceCountInput = document.querySelector('#multipleRaceCount');
const cupSizeInput = document.querySelector('#cupSize');
const qualityPresetInput = document.querySelector('#qualityPreset');
const lengthModeInput = document.querySelector('#lengthMode');
const targetMinutesInput = document.querySelector('#targetMinutes');
const trackLengthInput = document.querySelector('#trackLength');
const dashboardThumbnailPresetTitles = ${JSON.stringify(THUMBNAIL_TITLE_PRESETS)};
const scheduleWeekdays = ${JSON.stringify(SCHEDULE_WEEKDAYS)};
const scheduleRecurrences = ${JSON.stringify(SCHEDULE_RECURRENCES)};
const scheduleActions = ${JSON.stringify(SCHEDULE_ACTIONS)};
const scheduleGrid = document.querySelector('#scheduleGrid');
const scheduleWeekTabs = document.querySelector('#scheduleWeekTabs');
const scheduleStatus = document.querySelector('#scheduleStatus');
const scheduleForm = document.querySelector('#scheduleForm');
const scheduleFormTitle = document.querySelector('#scheduleFormTitle');
const scheduleItemId = document.querySelector('#scheduleItemId');
const scheduleTitle = document.querySelector('#scheduleTitle');
const scheduleWeekday = document.querySelector('#scheduleWeekday');
const scheduleRecurrence = document.querySelector('#scheduleRecurrence');
const scheduleTimes = document.querySelector('#scheduleTimes');
const scheduleAction = document.querySelector('#scheduleAction');
const scheduleEnabled = document.querySelector('#scheduleEnabled');
const schedulePayload = document.querySelector('#schedulePayload');
const scheduleNotes = document.querySelector('#scheduleNotes');
const scheduleNewBtn = document.querySelector('#scheduleNewBtn');
const scheduleDeleteBtn = document.querySelector('#scheduleDeleteBtn');
const scheduleLog = document.querySelector('#scheduleLog');
const scheduleWorkerStatus = document.querySelector('#scheduleWorkerStatus');
const scheduleWorkerMeta = document.querySelector('#scheduleWorkerMeta');
const scheduleWorkerCheckBtn = document.querySelector('#scheduleWorkerCheckBtn');
let dashboardSchedule = { items: [] };
let activeScheduleWeekday = new Date().getDay();
let shouldAutoScrollScheduleToNow = false;
const recordModeHints = {
  single: 'Single: in-game recording only; use Marble Rush page for manual Single capture.',
  continuous: 'Multiple: background record repeated single races; 場數由 Multiple 場數控制。',
  cup: 'Cup Mode: all stages use the same per-race track length.',
};
let currentJobId = null;
let pollTimer = null;

function selectedTypes() {
  return Array.from(document.querySelectorAll('input[name="obstacleTypes"]:checked')).map((el) => el.value);
}
function selectedRecordMode() {
  return form.recordMode?.value || 'cup';
}
function normalizeMultipleRaceCount() {
  const raw = Number(multipleRaceCountInput?.value);
  const count = Number.isFinite(raw) ? Math.round(raw) : 5;
  return Math.max(1, Math.min(99, count));
}
function normalizeCupSize() {
  const raw = Number(cupSizeInput?.value);
  const count = Number.isFinite(raw) ? Math.round(raw) : 12;
  return Math.max(2, Math.min(99, count));
}
function updateRecordModeHint() {
  const mode = selectedRecordMode();
  if (recordModeHint) recordModeHint.textContent = recordModeHints[mode] || recordModeHints.cup;
  if (multipleRaceCountInput) multipleRaceCountInput.disabled = mode !== 'continuous';
}

function estimateDashboardTrackLength() {
  const mode = selectedRecordMode();
  const races = mode === 'continuous' ? normalizeMultipleRaceCount() : mode === 'cup' ? 3 : 1;
  const targetSeconds = Math.max(60, Number(targetMinutesInput?.value || 10) * 60);
  const nonRaceSeconds = mode === 'cup' ? 164 : mode === 'continuous' ? 2 + Math.max(0, races - 1) * 10 + 5 : 7;
  const raceSeconds = Math.max(35, (targetSeconds - nonRaceSeconds) / races);
  return Math.max(80, Math.min(3000, Math.round((raceSeconds * 4.6) / 10) * 10));
}
function estimateDashboardMaxRaceSeconds(trackLength) {
  return Math.max(45, Math.min(1200, Math.ceil(trackLength * 0.3)));
}
function updateLengthModeState() {
  const auto = lengthModeInput?.value !== 'fixed-track';
  if (targetMinutesInput) targetMinutesInput.disabled = !auto;
  if (trackLengthInput) {
    trackLengthInput.disabled = auto;
    if (auto) trackLengthInput.value = String(estimateDashboardTrackLength());
  }
}
function setTypes(types) {
  document.querySelectorAll('input[name="obstacleTypes"]').forEach((el) => { el.checked = types.includes(el.value); });
}
document.querySelector('#allTypes').onclick = () => setTypes(${JSON.stringify(OBSTACLE_TYPES.map((type) => type.value))});
document.querySelector('#bumperOnly').onclick = () => setTypes(${JSON.stringify(OBSTACLE_TYPES.filter((type) => type.tags?.includes('bumper')).map((type) => type.value))});
document.querySelector('#clearTypes').onclick = () => setTypes([]);
const randomTitleBtn = document.querySelector('#randomTitleBtn');
const testThumbnailBtn = document.querySelector('#testThumbnailBtn');
if (randomTitleBtn) {
  randomTitleBtn.onclick = () => {
    const title = dashboardThumbnailPresetTitles[Math.floor(Math.random() * dashboardThumbnailPresetTitles.length)] || 'CRAZY FIRST HIT';
    if (form.thumbnailTitle) form.thumbnailTitle.value = title;
  };
}
document.querySelectorAll('input[name="recordMode"]').forEach((el) => el.addEventListener('change', updateRecordModeHint));
multipleRaceCountInput?.addEventListener('change', () => { multipleRaceCountInput.value = String(normalizeMultipleRaceCount()); updateLengthModeState(); });
cupSizeInput?.addEventListener('change', () => { cupSizeInput.value = String(normalizeCupSize()); });
lengthModeInput?.addEventListener('change', updateLengthModeState);
targetMinutesInput?.addEventListener('input', updateLengthModeState);
document.querySelectorAll('input[name="recordMode"]').forEach((el) => el.addEventListener('change', updateLengthModeState));
updateRecordModeHint();
updateLengthModeState();

function pad2(value) { return String(value).padStart(2, '0'); }
function scheduleDayLabel(value) {
  const day = scheduleWeekdays.find((entry) => Number(entry.value) === Number(value));
  return day ? day.label : 'Day';
}
function scheduleDayZh(value) {
  const day = scheduleWeekdays.find((entry) => Number(entry.value) === Number(value));
  return day ? day.zh : '星期';
}
function scheduleRecurrenceLabel(value) {
  const recurrence = scheduleRecurrences.find((entry) => entry.value === value);
  return recurrence ? recurrence.zh : '每週';
}
function scheduleActionDefinition(value) {
  return scheduleActions.find((entry) => entry.value === value) || scheduleActions[0];
}
function scheduleActionDefaultPayload(value) {
  const definition = scheduleActionDefinition(value);
  return definition && definition.payload ? JSON.parse(JSON.stringify(definition.payload)) : {};
}
function scheduleRunsOnDay(item, weekday) {
  return item.recurrence === 'daily' || Number(item.weekday) === Number(weekday);
}
function normalizeScheduleTimeClient(value = {}) {
  const rawHour = Number(value.hour);
  const rawMinute = Number(value.minute);
  const hour = Number.isFinite(rawHour) ? Math.max(0, Math.min(23, Math.round(rawHour))) : 9;
  const minute = Number.isFinite(rawMinute) ? Math.max(0, Math.min(55, Math.round(rawMinute / 5) * 5)) : 0;
  return { hour, minute };
}
function scheduleTimesForItem(item = {}) {
  const sourceTimes = Array.isArray(item.times) && item.times.length ? item.times : [{ hour: item.hour, minute: item.minute }];
  const seen = new Set();
  const times = [];
  sourceTimes.forEach((entry) => {
    const time = normalizeScheduleTimeClient(entry);
    const key = time.hour + ':' + time.minute;
    if (seen.has(key)) return;
    seen.add(key);
    times.push(time);
  });
  if (!times.length) times.push({ hour: 9, minute: 0 });
  return times.sort((a, b) => (a.hour - b.hour) || (a.minute - b.minute));
}
function formatScheduleTimes(times = []) {
  return times.map((time) => pad2(time.hour) + ':' + pad2(time.minute)).join(', ');
}
function parseScheduleTimesInput(value) {
  const parts = String(value || '').split(/[\\s,;]+/).map((entry) => entry.trim()).filter(Boolean);
  const seen = new Set();
  const times = [];
  for (const part of parts) {
    const match = part.match(/^(\\d{1,2})(?::(\\d{1,2}))?$/);
    if (!match) throw new Error('時間格式錯誤：' + part + '（請用 09:00, 12:00）');
    const hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23 || !Number.isFinite(minute) || minute < 0 || minute > 59) throw new Error('時間超出範圍：' + part);
    const normalized = normalizeScheduleTimeClient({ hour, minute });
    const key = normalized.hour + ':' + normalized.minute;
    if (seen.has(key)) continue;
    seen.add(key);
    times.push(normalized);
  }
  if (!times.length) throw new Error('請至少輸入一個執行時間');
  return times.sort((a, b) => (a.hour - b.hour) || (a.minute - b.minute));
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function currentScheduleDateParts() {
  const now = new Date();
  return { weekday: now.getDay(), hour: now.getHours(), minute: now.getMinutes() };
}
function setScheduleToToday({ scroll = false } = {}) {
  const now = currentScheduleDateParts();
  activeScheduleWeekday = now.weekday;
  if (scheduleWeekday) scheduleWeekday.value = String(activeScheduleWeekday);
  shouldAutoScrollScheduleToNow = Boolean(scroll);
  return now;
}
function scrollScheduleToCurrentHour() {
  if (!shouldAutoScrollScheduleToNow || !scheduleGrid || document.querySelector('#scheduleTab')?.hidden) return;
  shouldAutoScrollScheduleToNow = false;
  const now = currentScheduleDateParts();
  const slot = scheduleGrid.querySelector('[data-hour="' + now.hour + '"]');
  if (slot) slot.scrollIntoView({ block: 'center', behavior: 'auto' });
}
function setActiveTab(tabId) {
  document.querySelectorAll('.tab-panel').forEach((panel) => { panel.hidden = panel.id !== tabId; });
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tabTarget === tabId));
  if (tabId === 'scheduleTab') { setScheduleToToday({ scroll: true }); refreshSchedule(); refreshScheduleWorker(); }
}
document.querySelectorAll('.tab-btn').forEach((btn) => btn.addEventListener('click', () => setActiveTab(btn.dataset.tabTarget)));
function renderScheduleWeekTabs() {
  if (!scheduleWeekTabs) return;
  const counts = new Map(scheduleWeekdays.map((day) => [day.value, 0]));
  (dashboardSchedule.items || []).forEach((item) => {
    if (item.recurrence === 'daily') scheduleWeekdays.forEach((day) => counts.set(day.value, (counts.get(day.value) || 0) + 1));
    else counts.set(Number(item.weekday), (counts.get(Number(item.weekday)) || 0) + 1);
  });
  scheduleWeekTabs.innerHTML = scheduleWeekdays.map((day) => '<button class="schedule-day-btn ' + (Number(day.value) === Number(activeScheduleWeekday) ? 'active' : '') + '" type="button" data-schedule-weekday="' + day.value + '">' + day.zh + ' <span class="muted">' + (counts.get(day.value) || 0) + '</span></button>').join('');
  scheduleWeekTabs.querySelectorAll('[data-schedule-weekday]').forEach((btn) => btn.addEventListener('click', () => {
    activeScheduleWeekday = Number(btn.dataset.scheduleWeekday);
    shouldAutoScrollScheduleToNow = false;
    if (scheduleWeekday) scheduleWeekday.value = String(activeScheduleWeekday);
    renderSchedule();
  }));
}
function scheduleItemsForHour(hour) {
  return (dashboardSchedule.items || [])
    .filter((item) => scheduleRunsOnDay(item, activeScheduleWeekday) && scheduleTimesForItem(item).some((time) => Number(time.hour) === Number(hour)))
    .sort((a, b) => {
      const aTime = scheduleTimesForItem(a).find((time) => Number(time.hour) === Number(hour)) || scheduleTimesForItem(a)[0];
      const bTime = scheduleTimesForItem(b).find((time) => Number(time.hour) === Number(hour)) || scheduleTimesForItem(b)[0];
      return (aTime.minute - bTime.minute) || a.title.localeCompare(b.title);
    });
}
function scheduleTimeRunDisplayKey(item, time) {
  return item.id + '@' + Number(activeScheduleWeekday) + '@' + pad2(time.hour) + ':' + pad2(time.minute);
}
function latestRunForScheduleItemTime(item, time) {
  return dashboardSchedule.latestRunByItemTime?.[scheduleTimeRunDisplayKey(item, time)] || null;
}
function scheduleRunStatusClass(run) {
  return run?.status || 'never-run';
}
function scheduleRunStatusLabel(run) {
  const status = run?.status || 'never-run';
  return ({
    'never-run': '未行',
    started: '已觸發',
    completed: '已完成',
    failed: '有問題',
    skipped: '已略過',
    'already-ran': '已行過',
    'dry-run': 'Dry-run',
  })[status] || status;
}
function scheduleRunSummary(run) {
  if (!run) return '未行 · no log yet';
  const time = run.finishedAt || run.checkedAt || '';
  const detail = run.jobId ? 'job #' + run.jobId : run.reason || run.error || '';
  return scheduleRunStatusLabel(run) + (time ? ' · ' + time : '') + (detail ? ' · ' + detail : '');
}
function renderSchedule() {
  if (!scheduleGrid) return;
  renderScheduleWeekTabs();
  scheduleGrid.setAttribute('aria-label', scheduleDayZh(activeScheduleWeekday) + ' hourly schedule');
  scheduleGrid.innerHTML = Array.from({ length: 24 }, (_, hour) => {
    const isCurrentHour = Number(activeScheduleWeekday) === Number(currentScheduleDateParts().weekday) && hour === currentScheduleDateParts().hour;
    const items = scheduleItemsForHour(hour);
    const body = items.length ? items.flatMap((item) => {
      const timesInHour = scheduleTimesForItem(item).filter((time) => Number(time.hour) === Number(hour));
      return timesInHour.map((time) => {
        const run = latestRunForScheduleItemTime(item, time);
        const statusClass = scheduleRunStatusClass(run);
        const timeLabel = pad2(time.hour) + ':' + pad2(time.minute);
        return '<button class="schedule-item ' + statusClass + ' ' + (item.enabled ? '' : 'disabled') + '" type="button" data-schedule-id="' + escapeHtml(item.id) + '" data-schedule-time="' + escapeHtml(timeLabel) + '"><b>' + escapeHtml(item.title) + ' <small>@ ' + escapeHtml(timeLabel) + '</small></b><span>' + scheduleRecurrenceLabel(item.recurrence) + (item.recurrence === 'daily' ? '' : ' · ' + scheduleDayLabel(item.weekday)) + ' · slot ' + escapeHtml(timeLabel) + ' / all times ' + escapeHtml(formatScheduleTimes(scheduleTimesForItem(item))) + ' · ' + escapeHtml(item.action) + (item.enabled ? '' : ' · off') + '</span><span class="schedule-run-status"><i class="run-dot ' + statusClass + '"></i>' + escapeHtml(scheduleRunSummary(run)) + '</span></button>';
      });
    }).join('') : '<div class="schedule-empty">No items</div>';
    return '<div class="schedule-hour ' + (isCurrentHour ? 'current-hour' : '') + '"><div class="schedule-time">' + pad2(hour) + ':00</div><div class="schedule-slot" data-weekday="' + activeScheduleWeekday + '" data-hour="' + hour + '">' + body + '</div></div>';
  }).join('');
  scheduleGrid.querySelectorAll('[data-schedule-id]').forEach((btn) => btn.addEventListener('click', () => editScheduleItem(btn.dataset.scheduleId)));
  const now = currentScheduleDateParts();
  const todaySuffix = Number(activeScheduleWeekday) === Number(now.weekday) ? ' · 今日 · now ' + pad2(now.hour) + ':' + pad2(now.minute) : '';
  if (scheduleStatus) scheduleStatus.textContent = scheduleDayZh(activeScheduleWeekday) + todaySuffix + ' · ' + scheduleItemsForDay(activeScheduleWeekday).length + ' / ' + (dashboardSchedule.items || []).length + ' items';
  setTimeout(scrollScheduleToCurrentHour, 50);
}
function scheduleItemsForDay(weekday) { return (dashboardSchedule.items || []).filter((item) => scheduleRunsOnDay(item, weekday)); }
async function refreshSchedule() {
  if (!scheduleGrid) return;
  const res = await fetch('/api/schedule');
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'schedule load failed');
  dashboardSchedule = data.schedule || { items: [] };
  if (!document.querySelector('#scheduleTab')?.hidden) setScheduleToToday({ scroll: shouldAutoScrollScheduleToNow });
  const workerData = await fetch('/api/schedule/worker').then((res) => res.json()).catch(() => null);
  if (workerData?.ok) {
    dashboardSchedule.latestRunByItem = workerData.worker.latestRunByItem || {};
    dashboardSchedule.latestRunByItemTime = workerData.worker.latestRunByItemTime || {};
  }
  renderSchedule();
  if (scheduleLog) scheduleLog.textContent = 'Loaded from ' + (data.path || 'schedule store');
  await refreshScheduleWorker({ preserveAutoScroll: true });
}
function formatScheduleRun(run) {
  if (!run) return '';
  const slot = run.slot?.slotKey || '';
  const tail = run.jobId ? ' · job #' + run.jobId : run.reason ? ' · ' + run.reason : run.error ? ' · ' + run.error : '';
  return '[' + scheduleRunStatusLabel(run) + '] ' + (run.title || run.itemId || 'item') + (slot ? ' @ ' + slot : '') + tail;
}
function renderScheduleRunLog(runs = []) {
  if (!runs.length) return '<div class="muted">暫時未有 run log</div>';
  return '<div class="schedule-log-list">' + runs.slice(0, 8).map((run) => {
    const statusClass = scheduleRunStatusClass(run);
    return '<div class="schedule-log-entry ' + statusClass + '"><b><span class="run-dot ' + statusClass + '"></span> ' + escapeHtml(scheduleRunStatusLabel(run)) + ' · ' + escapeHtml(run.title || run.itemId || 'item') + '</b><span>' + escapeHtml((run.slot?.slotKey || '') + (run.jobId ? ' · job #' + run.jobId : '') + (run.reason ? ' · ' + run.reason : '') + (run.error ? ' · ' + run.error : '') + (run.outputName ? ' · ' + run.outputName : '')) + '</span></div>';
  }).join('') + '</div>';
}
function renderScheduleWorker(worker) {
  if (!worker) return;
  if (scheduleWorkerStatus) scheduleWorkerStatus.textContent = (worker.running ? 'Running' : 'Stopped') + ' · every ' + (worker.intervalMinutes || 5) + ' min';
  if (scheduleWorkerMeta) {
    dashboardSchedule.latestRunByItem = worker.latestRunByItem || dashboardSchedule.latestRunByItem || {};
    dashboardSchedule.latestRunByItemTime = worker.latestRunByItemTime || dashboardSchedule.latestRunByItemTime || {};
    scheduleWorkerMeta.innerHTML = [
      'Last check: ' + (worker.lastCheckedAt || '未檢查'),
      'Next: ' + (worker.nextCheckAt || 'pending'),
      'Due last check: ' + (worker.lastResult?.dueCount ?? 0),
      'Log file: ' + (worker.runStatePath || ''),
    ].join(' · ') + renderScheduleRunLog(worker.recentRuns || []);
    renderSchedule();
  }
}
async function refreshScheduleWorker({ preserveAutoScroll = false } = {}) {
  const keepAutoScroll = shouldAutoScrollScheduleToNow;
  const res = await fetch('/api/schedule/worker');
  const data = await res.json();
  if (data.ok) {
    if (preserveAutoScroll) shouldAutoScrollScheduleToNow = keepAutoScroll;
    renderScheduleWorker(data.worker);
  }
}
async function dryRunScheduleWorkerCheck() {
  if (scheduleLog) scheduleLog.textContent = 'Checking due actions (dry-run)...';
  const res = await fetch('/api/schedule/check?dryRun=true', { method: 'POST' });
  const data = await res.json();
  if (!data.ok) { if (scheduleLog) scheduleLog.textContent = data.error || 'Check failed'; return; }
  if (scheduleLog) scheduleLog.textContent = 'Dry-run result:\\\\n' + JSON.stringify(data.result, null, 2);
  await refreshScheduleWorker();
}
function resetScheduleForm(hour = 9) {
  if (!scheduleForm) return;
  scheduleFormTitle.textContent = 'Add item'; scheduleItemId.value = ''; scheduleTitle.value = '';
  scheduleRecurrence.value = 'weekly'; scheduleWeekday.value = String(activeScheduleWeekday);
  scheduleTimes.value = pad2(hour) + ':00'; scheduleAction.value = scheduleActions[0]?.value || 'youtube-marble-long-video'; scheduleEnabled.checked = true; updateScheduleRecurrenceState();
  schedulePayload.value = ''; schedulePayload.dataset.actionPreset = ''; scheduleNotes.value = ''; scheduleDeleteBtn.disabled = true;
  if (scheduleTitle) scheduleTitle.dataset.actionPreset = '';
  applyScheduleActionPreset(true);
}
function editScheduleItem(id) {
  const item = (dashboardSchedule.items || []).find((entry) => entry.id === id); if (!item) return;
  activeScheduleWeekday = Number(item.weekday ?? 1);
  scheduleFormTitle.textContent = 'Edit item'; scheduleItemId.value = item.id; scheduleTitle.value = item.title || '';
  scheduleRecurrence.value = item.recurrence || 'weekly'; scheduleWeekday.value = String(item.weekday ?? 1); updateScheduleRecurrenceState();
  scheduleTimes.value = formatScheduleTimes(scheduleTimesForItem(item)); scheduleAction.value = item.action || scheduleActions[0]?.value || 'youtube-marble-long-video';
  scheduleEnabled.checked = item.enabled !== false; schedulePayload.value = item.payload && Object.keys(item.payload).length ? JSON.stringify(item.payload, null, 2) : ''; schedulePayload.dataset.actionPreset = item.action || '';
  if (scheduleTitle) scheduleTitle.dataset.actionPreset = item.action || '';
  scheduleNotes.value = item.notes || ''; scheduleDeleteBtn.disabled = false; renderSchedule(); scheduleTitle.focus();
}
async function saveScheduleItem(event) {
  event.preventDefault();
  let payload = {};
  if (schedulePayload.value.trim()) { try { payload = JSON.parse(schedulePayload.value); } catch (error) { scheduleLog.textContent = 'Payload JSON error: ' + error.message; return; } }
  let times = [];
  try { times = parseScheduleTimesInput(scheduleTimes.value); } catch (error) { scheduleLog.textContent = error.message; return; }
  const primaryTime = times[0] || { hour: 9, minute: 0 };
  const now = new Date().toISOString();
  const id = scheduleItemId.value || 'schedule-' + Date.now().toString(36);
  const existing = (dashboardSchedule.items || []).find((item) => item.id === id);
  const item = { id, title: scheduleTitle.value, recurrence: scheduleRecurrence.value, weekday: Number(scheduleWeekday.value), hour: primaryTime.hour, minute: primaryTime.minute, times, action: scheduleAction.value, enabled: scheduleEnabled.checked, payload, notes: scheduleNotes.value, createdAt: existing?.createdAt || now, updatedAt: now };
  const items = (dashboardSchedule.items || []).filter((entry) => entry.id !== id).concat(item);
  const res = await fetch('/api/schedule', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) });
  const data = await res.json();
  if (!data.ok) { scheduleLog.textContent = data.error || 'Save failed'; return; }
  dashboardSchedule = data.schedule; activeScheduleWeekday = Number(item.weekday); renderSchedule(); editScheduleItem(id); scheduleLog.textContent = 'Saved ' + item.title + ' · ' + scheduleRecurrenceLabel(item.recurrence) + (item.recurrence === 'daily' ? '' : ' · ' + scheduleDayZh(item.weekday)) + ' · times ' + formatScheduleTimes(times) + ' · background jobs can read /api/schedule';
}
async function deleteScheduleItem() {
  const id = scheduleItemId.value; if (!id) return;
  const items = (dashboardSchedule.items || []).filter((entry) => entry.id !== id);
  const res = await fetch('/api/schedule', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) });
  const data = await res.json();
  if (!data.ok) { scheduleLog.textContent = data.error || 'Delete failed'; return; }
  dashboardSchedule = data.schedule; renderSchedule(); resetScheduleForm(); scheduleLog.textContent = 'Deleted item';
}
scheduleForm?.addEventListener('submit', saveScheduleItem);
scheduleNewBtn?.addEventListener('click', () => resetScheduleForm());
scheduleDeleteBtn?.addEventListener('click', deleteScheduleItem);
scheduleWorkerCheckBtn?.addEventListener('click', dryRunScheduleWorkerCheck);
function updateScheduleRecurrenceState() {
  if (!scheduleRecurrence || !scheduleWeekday) return;
  scheduleWeekday.disabled = scheduleRecurrence.value === 'daily';
}
function applyScheduleActionPreset(force = false) {
  if (!scheduleAction || !schedulePayload) return;
  const action = scheduleAction.value;
  const defaultPayload = scheduleActionDefaultPayload(action);
  const hasDefault = Object.keys(defaultPayload).length > 0;
  const canReplace = force || !schedulePayload.value.trim() || Boolean(schedulePayload.dataset.actionPreset);
  if (!hasDefault || !canReplace) return;
  schedulePayload.value = JSON.stringify(defaultPayload, null, 2);
  schedulePayload.dataset.actionPreset = action;
  if (scheduleTitle && (!scheduleTitle.value.trim() || scheduleTitle.dataset.actionPreset)) {
    scheduleTitle.value = scheduleActionDefinition(action)?.label || action;
    scheduleTitle.dataset.actionPreset = action;
  }
}
scheduleWeekday?.addEventListener('change', () => { activeScheduleWeekday = Number(scheduleWeekday.value); shouldAutoScrollScheduleToNow = false; renderSchedule(); });
scheduleRecurrence?.addEventListener('change', updateScheduleRecurrenceState);
scheduleAction?.addEventListener('change', () => applyScheduleActionPreset(false));
setScheduleToToday({ scroll: false });
resetScheduleForm(currentScheduleDateParts().hour);

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B','KB','MB','GB'];
  let i = 0; let value = n;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return value.toFixed(value >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
}
function setStatus(status) {
  statusText.textContent = status;
  statusDot.className = 'dot ' + status;
  startBtn.disabled = status === 'running' || status === 'stopping';
  stopBtn.disabled = !(status === 'running');
}
function renderGameServer(server) {
  const status = server.status || 'unknown';
  serverStatusText.textContent = status;
  if (gameServiceStat) gameServiceStat.textContent = status === 'external-running' ? 'external' : status;
  serverDot.className = 'dot ' + (status === 'running' || status === 'external-running' ? 'completed' : status === 'starting' ? 'running' : status === 'failed' ? 'failed' : '');
  serverStartBtn.disabled = ['running', 'starting', 'external-running'].includes(status);
  serverStopBtn.disabled = !['running', 'starting'].includes(status) || !server.managed;
  serverOpenLink.href = server.url;
  serverMeta.innerHTML = [
    'URL: <a href="' + server.url + '" target="_blank" rel="noreferrer">' + server.url + '</a>',
    'HTTP: ' + (server.httpOnline ? 'online ' + (server.httpStatusCode || '') : 'offline'),
    'Mode: ' + (server.managed ? 'dashboard-managed' : status === 'external-running' ? 'external process' : 'stopped'),
    server.pid ? 'PID: ' + server.pid : null,
  ].filter(Boolean).join(' · ');
  serverLog.textContent = server.log || (server.httpOnline ? 'Server is online.' : 'Server is stopped.');
  serverLog.scrollTop = serverLog.scrollHeight;
}
async function refreshGameServer() {
  const res = await fetch('/api/game-server');
  const data = await res.json();
  if (data.ok) renderGameServer(data.server);
}
async function controlGameServer(action) {
  serverLog.textContent = action === 'start' ? '啟動 server 中...' : '關閉 server 中...';
  const res = await fetch('/api/game-server/' + action, { method: 'POST' });
  const data = await res.json();
  if (data.server) renderGameServer(data.server);
  setTimeout(refreshGameServer, 900);
}
async function restartDashboard() {
  if (!window.confirm('Restart dashboard server now? 頁面會短暫斷線，約幾秒後自動重連。')) return;
  dashboardRestartBtn.disabled = true;
  dashboardRestartStatus.textContent = 'Restarting dashboard server...';
  try {
    const res = await fetch('/api/dashboard/restart', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'restart failed');
    dashboardRestartStatus.textContent = 'Restart requested · reconnecting...';
    setTimeout(() => window.location.reload(), 2500);
  } catch (error) {
    dashboardRestartStatus.textContent = 'Restart failed: ' + error.message;
    dashboardRestartBtn.disabled = false;
  }
}
async function testGenerateThumbnail(videoName = '') {
  const title = form.thumbnailTitle?.value || 'CRAZY FIRST HIT';
  const videoCanvasLayout = form.videoCanvasLayout?.value || 'horizontal';
  logEl.textContent = '生成測試 thumbnail 中...';
  const res = await fetch('/api/thumbnail/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videoName, title, videoCanvasLayout }),
  });
  const data = await res.json();
  if (!data.ok) {
    logEl.textContent = data.error || 'Thumbnail 生成失敗';
    return;
  }
  logEl.textContent = 'Thumbnail ready: ' + data.thumbnailName + (data.log ? '\\n\\n' + data.log : '');
  await refreshRecordings();
  if (data.thumbnailUrl) window.open(data.thumbnailUrl, '_blank');
}
serverStartBtn.onclick = () => controlGameServer('start');
serverStopBtn.onclick = () => controlGameServer('stop');
serverRefreshBtn.onclick = refreshGameServer;
dashboardRestartBtn.onclick = restartDashboard;
if (testThumbnailBtn) testThumbnailBtn.onclick = () => testGenerateThumbnail('');
function renderJob(job) {
  if (!job) { setStatus('idle'); if (progressBar) progressBar.style.width = '0%'; if (progressText) progressText.textContent = 'Progress 0%'; return; }
  setStatus(job.status);
  const progress = job.progress || { percent: 0, label: 'Progress' };
  if (progressBar) progressBar.style.width = (progress.percent || 0) + '%';
  if (progressText) progressText.textContent = 'Progress ' + (progress.percent || 0) + '% · ' + (progress.label || '');
  const primaryLink = job.outputExists ? ' · <a href="/recordings/' + encodeURIComponent(job.outputName) + '" target="_blank">下載/預覽</a>' : '';
  const companionLinks = (job.companionOutputs || []).filter((item) => item.exists).map((item) =>
    ' · <a href="' + item.url + '" target="_blank">' + item.label + ' (' + fmtBytes(item.size) + ')</a>'
  ).join('');
  jobMeta.innerHTML = 'Job #' + job.id + ' · ' + (job.outputName || '') + ' · ' + (job.size ? fmtBytes(job.size) : 'rendering...') + primaryLink + companionLinks +
    (job.thumbnailExists ? ' · <a href="' + job.thumbnailUrl + '" target="_blank">Thumbnail</a>' : '') +
    (job.youtubeMetadataExists ? ' · <a href="' + job.youtubeMetadataUrl + '" target="_blank">YouTube JSON</a>' : '') +
    (job.youtubeUploadExists ? ' · <a href="' + job.youtubeUploadUrl + '" target="_blank">Upload JSON</a>' : '') +
    (job.youtubeUploadInfo?.url ? ' · <a href="' + job.youtubeUploadInfo.url + '" target="_blank">YouTube video</a>' : '');
  jobPills.innerHTML = [
    'Mode: ' + (job.options.recordMode === 'continuous' ? 'Multiple' : 'Cup Mode'),
    job.options.recordMode === 'continuous' ? 'Races: ' + (job.options.multipleRaceCount || 5) : null,
    job.options.cupName ? 'Cup note: ' + job.options.cupName : null,
    'Length mode: ' + (job.options.lengthMode === 'fixed-track' ? 'Fixed track' : 'Target duration'),
    'Target: ' + (job.options.targetMinutes || 10) + ' min',
    'Track: ' + (job.options.stageTrackLabel || (job.options.trackLength + 'm')),
    'Estimated max race: ' + (job.options.estimatedMaxRaceSeconds || estimateDashboardMaxRaceSeconds(job.options.trackLength || 600)) + 's (not passed)',
    'Density: ' + job.options.density,
    'Distribution: ' + (job.options.obstacleDistribution || 'random'),
    'Types: ' + (job.options.obstacleTypes.length ? job.options.obstacleTypes.join(', ') : 'all'),
    'Format: ' + job.options.format + (job.options.format === 'mp4' ? ' + comparison WebM' : ''),
    'Capture: ' + (job.options.videoCapture === 'playwright' ? 'Playwright viewport' : 'Canvas stream'),
    'Thumbnail: ' + (job.options.thumbnail ? 'on' : 'off'),
    'YouTube upload: ' + (job.options.uploadYoutube ? 'on' : 'off'),
    'Privacy: ' + (job.options.youtubePrivacy || 'public'),
    job.youtubeUploadInfo?.url ? 'YouTube: ' + job.youtubeUploadInfo.url : null,
    job.options.thumbnailTitle ? 'Title: ' + job.options.thumbnailTitle : null,
    'Quality: ' + (job.options.qualityLabel || job.options.qualityPreset || (job.options.width + '×' + job.options.height)) + ' · ' + job.options.width + '×' + job.options.height + '@' + (job.options.fps || 60),
    'TTS: ' + (job.options.ttsVoice || 'Alex'),
    'Port: ' + job.renderPort,
  ].filter(Boolean).map((text) => '<span class="pill">' + text + '</span>').join('');
  logEl.textContent = job.log || '已開始，等待 render log...';
  logEl.scrollTop = logEl.scrollHeight;
}
async function refreshRecordings() {
  const res = await fetch('/api/recordings');
  const data = await res.json();
  recEl.innerHTML = data.recordings.length ? data.recordings.map((rec) =>
    '<div class="recording"><div><a href="' + rec.url + '" target="_blank">' + rec.name + '</a><div class="muted">' + fmtBytes(rec.size) + ' · ' + rec.modifiedAt + (rec.isThumbnail ? ' · thumbnail' : '') + (rec.isYoutubeMetadata ? ' · YouTube JSON' : '') + '</div>' +
    (rec.isThumbnail ? '<img class="thumb-preview" src="' + rec.url + '?v=' + encodeURIComponent(rec.modifiedAt) + '" alt="thumbnail preview">' : '') + '</div><div class="recording-actions">' +
    (rec.isVideo ? '<button class="secondary" type="button" data-thumb-video="' + rec.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">Test thumbnail</button>' : '') +
    (rec.thumbnailExists && rec.isVideo ? '<a href="' + rec.thumbnailUrl + '" target="_blank">thumbnail</a>' : '') +
    (rec.youtubeMetadataExists && rec.isVideo ? '<a href="' + rec.youtubeMetadataUrl + '" target="_blank">YouTube JSON</a>' : '') +
    (rec.youtubeUploadExists && rec.isVideo ? '<a href="' + rec.youtubeUploadUrl + '" target="_blank">Upload JSON</a>' : '') + '</div></div>'
  ).join('') : '<p class="muted">暫無影片</p>';
  recEl.querySelectorAll('[data-thumb-video]').forEach((btn) => {
    btn.addEventListener('click', () => testGenerateThumbnail(btn.getAttribute('data-thumb-video') || ''));
  });
}
async function pollJob() {
  if (!currentJobId) return;
  const res = await fetch('/api/jobs/' + encodeURIComponent(currentJobId));
  const data = await res.json();
  if (data.ok) {
    renderJob(data.job);
    if (['completed','failed','stopping'].includes(data.job.status)) {
      if (data.job.status !== 'running') await refreshRecordings();
      if (data.job.status !== 'stopping') clearInterval(pollTimer);
    }
  }
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = {
    recordMode: selectedRecordMode(),
    multipleRaceCount: normalizeMultipleRaceCount(),
    cupName: form.cupName.value,
    density: form.density.value,
    obstacleDistribution: form.obstacleDistribution.value,
    obstacleTypes: selectedTypes(),
    format: form.format.value,
    videoCapture: form.videoCapture?.value || 'canvas',
    videoCanvasLayout: form.videoCanvasLayout?.value || 'horizontal',
    qualityPreset: form.qualityPreset.value,
    renderPerformanceProfile: form.renderPerformanceProfile?.value || 'turbo60',
    cupSize: normalizeCupSize(),
    lengthMode: form.lengthMode.value,
    targetMinutes: Number(form.targetMinutes.value),
    trackLength: Number(form.trackLength.value),
    timeout: Number(form.timeout.value),
    audio: form.audio.checked,
    thumbnail: form.thumbnail?.checked !== false,
    uploadYoutube: form.uploadYoutube?.checked !== false,
    youtubePrivacy: form.youtubePrivacy?.value || 'public',
    thumbnailTitle: form.thumbnailTitle?.value || '',
    ttsVoice: form.ttsVoice.value,
  };
  setStatus('running');
  logEl.textContent = '提交生成任務中...';
  const res = await fetch('/api/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json();
  if (!data.ok) {
    setStatus('failed');
    logEl.textContent = data.error || '提交失敗';
    return;
  }
  currentJobId = data.job.id;
  renderJob(data.job);
  clearInterval(pollTimer);
  pollTimer = setInterval(pollJob, 2000);
});
stopBtn.onclick = async () => {
  if (!currentJobId) return;
  await fetch('/api/jobs/' + encodeURIComponent(currentJobId) + '/stop', { method: 'POST' });
  await pollJob();
};
// ── Jobs tab ──
const jobsListEl = document.querySelector('#jobsList');
const jobsRefreshBtn = document.querySelector('#jobsRefreshBtn');
async function refreshJobs() {
  try {
    const res = await fetch('/api/jobs');
    const data = await res.json();
    if (!data.ok || !data.jobs.length) {
      jobsListEl.innerHTML = '<p class="muted">No jobs yet</p>';
      return;
    }
    jobsListEl.innerHTML = data.jobs.map((job) => {
      const statusClass = job.status === 'completed' ? 'completed' : job.status === 'failed' ? 'failed' : job.status === 'running' || job.status === 'starting' ? 'running' : '';
      const progress = job.progress || {};
      const stopBtn = job.canStop ? '<button class="danger" style="padding:3px 8px;font-size:11px" data-stop-job="' + job.id + '">Stop</button>' : '';
      const logLink = job.renderLogExists ? ' <a href="' + job.renderLogUrl + '" target="_blank">📄 log</a>' : '';
      const streamLog = job.log ? '<pre style="max-height:120px;overflow-y:auto;font-size:10px;margin:4px 0 0;background:rgba(0,0,0,.3);padding:6px;border-radius:8px">' + job.log.slice(-600).replace(/</g,'&lt;') + '</pre>' : '';
      return '<div class="schedule-log-entry ' + statusClass + '" style="margin-bottom:8px">' +
        '<b>#' + job.id + ' <span class="run-dot ' + statusClass + '"></span> ' + job.status + '</b>' +
        '<span>' + (job.outputName || job.outputTitle || '') + ' · ' + (progress.label || '') + ' ' + (progress.percent || 0) + '%</span>' +
        '<div style="margin-top:4px">' + stopBtn + logLink + '</div>' +
        streamLog +
        '</div>';
    }).join('');
    // Wire stop buttons
    jobsListEl.querySelectorAll('[data-stop-job]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const jobId = btn.getAttribute('data-stop-job');
        btn.disabled = true;
        btn.textContent = 'Stopping...';
        await fetch('/api/jobs/' + encodeURIComponent(jobId) + '/stop', { method: 'POST' });
        setTimeout(refreshJobs, 800);
      });
    });
  } catch { jobsListEl.innerHTML = '<p class="muted">Failed to load jobs</p>'; }
}
jobsRefreshBtn.onclick = refreshJobs;
refreshJobs();
setInterval(refreshJobs, 5000);
refreshRecordings();
refreshGameServer();
setInterval(refreshGameServer, 3000);
</script>
</body>
</html>`;
}

async function handleRequest(req, res) {
  if (!requireDashboardAuth(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'GET' && url.pathname === '/') return htmlResponse(res, dashboardHtml());

  if (req.method === 'GET' && url.pathname === '/api/schedule') {
    return jsonResponse(res, 200, { ok: true, schedule: loadSchedule(), path: schedulePath });
  }

  if (req.method === 'PUT' && url.pathname === '/api/schedule') {
    try {
      const body = await readRequestJson(req);
      return jsonResponse(res, 200, { ok: true, schedule: saveSchedule(body), path: schedulePath });
    } catch (error) {
      return jsonResponse(res, 400, { ok: false, error: error.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/schedule/worker') {
    return jsonResponse(res, 200, { ok: true, worker: publicScheduleWorkerStatus() });
  }

  if (req.method === 'POST' && url.pathname === '/api/schedule/check') {
    try {
      const body = await readRequestJson(req);
      const dryRun = body.dryRun === true || url.searchParams.get('dryRun') === 'true';
      const result = runScheduleCheck({ dryRun });
      return jsonResponse(res, 200, { ok: true, dryRun, result, worker: publicScheduleWorkerStatus() });
    } catch (error) {
      return jsonResponse(res, 400, { ok: false, error: error.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/options') {
    return jsonResponse(res, 200, {
      ok: true,
      obstacleTypes: OBSTACLE_TYPES,
      obstacleCategories: OBSTACLE_CATEGORIES,
      obstacleDistributionModes: OBSTACLE_DISTRIBUTION_MODES,
      densityPresets: DENSITY_PRESETS,
      backgroundRecordModes: BACKGROUND_RECORD_MODES,
      videoCaptureModes: [
        { value: 'canvas', label: 'Canvas stream', default: true },
        { value: 'playwright', label: 'Playwright viewport' },
      ],
      thumbnailTitlePresets: THUMBNAIL_TITLE_PRESETS,
      youtubePrivacyModes: [
        { value: 'private', label: 'Private', default: true },
        { value: 'unlisted', label: 'Unlisted' },
        { value: 'public', label: 'Public' },
      ],
      videoCanvasLayouts: [
        { value: 'horizontal', label: 'Horizontal 16:9', default: true, youtubeKind: 'long', width: 1920, height: 1080 },
        { value: 'vertical', label: 'Vertical 9:16 Shorts', youtubeKind: 'shorts', width: 1080, height: 1920 },
      ],
      renderPerformanceProfiles: [
        { value: 'turbo60', label: 'Turbo 60（高效能）', default: true },
      ],
      schedule: { endpoint: '/api/schedule', path: schedulePath, weekdays: SCHEDULE_WEEKDAYS, recurrences: SCHEDULE_RECURRENCES, actions: SCHEDULE_ACTIONS },
      defaults: { uploadYoutube: false, youtubePrivacy: 'private', videoCanvasLayout: 'horizontal' },
    });
  }

  if (req.method === 'GET' && (url.pathname === '/api/game-server' || url.pathname === '/api/marble-server')) {
    return jsonResponse(res, 200, { ok: true, server: await publicGameServerStatus() });
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/launch-agent') {
    return jsonResponse(res, 200, { ok: true, launchAgent: getDashboardLaunchAgentStatus() });
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/restart') {
    const body = await readRequestJson(req);
    const result = restartDashboardServer({ dryRun: body.dryRun === true || url.searchParams.get('dryRun') === 'true' });
    return jsonResponse(res, result.error ? 500 : 202, { ok: !result.error, ...result });
  }

  if (req.method === 'POST' && (url.pathname === '/api/game-server/start' || url.pathname === '/api/marble-server/start')) {
    const result = await startGameServer();
    return jsonResponse(res, result.started ? 202 : 200, { ok: true, ...result });
  }

  if (req.method === 'POST' && (url.pathname === '/api/game-server/stop' || url.pathname === '/api/marble-server/stop')) {
    const result = await stopGameServer();
    return jsonResponse(res, 200, { ok: true, ...result });
  }

  if (req.method === 'GET' && url.pathname === '/api/jobs') {
    return jsonResponse(res, 200, { ok: true, jobs: Array.from(jobs.values()).map(publicJob).reverse() });
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && jobMatch) {
    const job = jobs.get(decodeURIComponent(jobMatch[1]));
    if (!job) return notFound(res);
    return jsonResponse(res, 200, { ok: true, job: publicJob(job) });
  }

  const stopMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/stop$/);
  if (req.method === 'POST' && stopMatch) {
    const job = jobs.get(decodeURIComponent(stopMatch[1]));
    if (!job) return notFound(res);
    const stopped = stopJob(job);
    return jsonResponse(res, 200, { ok: true, stopped, job: publicJob(job) });
  }

  if (req.method === 'POST' && url.pathname === '/api/render') {
    try {
      const body = await readRequestJson(req);
      const running = Array.from(jobs.values()).find((job) => job.status === 'running' || job.status === 'stopping');
      if (running) return jsonResponse(res, 409, { ok: false, error: `job ${running.id} is already running` });
      const options = normalizeOptions(body);
      const job = startRender(options);
      return jsonResponse(res, 202, { ok: true, job: publicJob(job) });
    } catch (error) {
      return jsonResponse(res, 400, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/thumbnail/test') {
    try {
      const body = await readRequestJson(req);
      const result = generateThumbnailTest(body);
      return jsonResponse(res, 200, result);
    } catch (error) {
      return jsonResponse(res, 400, { ok: false, error: error.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/recordings') {
    return jsonResponse(res, 200, { ok: true, recordings: listRecordings() });
  }

  const recordingMatch = url.pathname.match(/^\/recordings\/(.+)$/);
  if (req.method === 'GET' && recordingMatch) {
    const name = decodeURIComponent(recordingMatch[1]).replace(/\\/g, '/');
    if (name.startsWith('/') || name.includes('..') || !/\.(webm|mp4|jpe?g|png|json)$/i.test(name) || /\.metadata\.json$/i.test(name)) return notFound(res);
    const full = path.resolve(recordingsDir, name);
    const root = path.resolve(recordingsDir);
    if (full !== root && !full.startsWith(`${root}${path.sep}`)) return notFound(res);
    if (!existsSync(full)) return notFound(res);
    const ext = path.extname(name).toLowerCase();
    res.writeHead(200, {
      'content-type': ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : ext === '.png' ? 'image/png' : ext === '.json' ? 'application/json; charset=utf-8' : 'image/jpeg',
      'content-length': statSync(full).size,
      'cache-control': 'no-store',
    });
    return createReadStream(full).pipe(res);
  }

  return notFound(res);
}

const serverOptions = HTTPS_ENABLED ? {
  cert: readFileSync(HTTPS_CERT_PATH),
  key: readFileSync(HTTPS_KEY_PATH),
} : null;

const server = HTTPS_ENABLED
  ? https.createServer(serverOptions, (req, res) => {
      handleRequest(req, res).catch((error) => {
        console.error(error);
        jsonResponse(res, 500, { ok: false, error: error.message });
      });
    })
  : http.createServer((req, res) => {
      handleRequest(req, res).catch((error) => {
        console.error(error);
        jsonResponse(res, 500, { ok: false, error: error.message });
      });
    });

startScheduleWorker();

server.listen(PORT, HOST, () => {
  const protocol = HTTPS_ENABLED ? 'https' : 'http';
  console.log(`[game-dashboard] ${protocol}://${HOST}:${PORT}`);
  console.log(`[game-dashboard] config: ${configPath}`);
  console.log(`[game-dashboard] active game: ${activeGame.id} @ ${rootDir}`);
});
