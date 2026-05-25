#!/usr/bin/env node
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dashboardRoot = path.resolve(__dirname, '..');
const configPath = process.env.GAME_DASHBOARD_CONFIG || path.join(dashboardRoot, 'config', 'games.json');
const dashboardConfig = JSON.parse(readFileSync(configPath, 'utf8'));
const PORT = Number(process.env.GAME_DASHBOARD_PORT || process.env.MARBLE_DASHBOARD_PORT || dashboardConfig.dashboard?.port || 8888);
const HOST = process.env.GAME_DASHBOARD_HOST || process.env.MARBLE_DASHBOARD_HOST || dashboardConfig.dashboard?.host || '127.0.0.1';
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
      command: game.render?.command || 'npm run render:auto-cup -- --no-build',
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

mkdirSync(recordingsDir, { recursive: true });

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

const OBSTACLE_CATEGORIES = {
  normal: {
    label: '普通障礙物',
    description: '物理方向影響、反彈、旋轉、阻擋等現有 pinball 障礙物。',
  },
  buff: {
    label: '增益類',
    description: '預留給之後加速、保護、分數或能力提升效果。',
  },
  debuff: {
    label: '減益類',
    description: '預留給之後減速、干擾、失控或懲罰效果。',
  },
};

const OBSTACLE_TYPES = [
  { value: 'popBumper', label: 'Pop Bumper', category: 'normal' },
  { value: 'slingshot', label: 'Slingshot', category: 'normal' },
  { value: 'spinnerGate', label: 'Spinner Gate', category: 'normal' },
  { value: 'dropTarget', label: 'Drop Target', category: 'buff' },
];

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

function safeSlug(value, fallback = 'marble-cup') {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

function renderTitleSlug(options = {}, fallbackParts = []) {
  const title = options.thumbnailTitle || options.cupName || fallbackParts.filter(Boolean).join('-');
  return safeSlug(title, 'marble-rush');
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
  const qualitySettings = {
    '1080p-smooth': { width: 1920, height: 1080, crf: 18, captureScale: 1, fps: 60, videoPreset: 'veryfast', label: '1080p Smooth · 60fps · fast encode' },
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
  const uploadYoutube = input.uploadYoutube !== false;
  const youtubePrivacy = ['private', 'unlisted', 'public'].includes(String(input.youtubePrivacy || '').toLowerCase())
    ? String(input.youtubePrivacy).toLowerCase()
    : 'public';
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
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const titleSlug = renderTitleSlug(options, [options.recordMode, options.density, options.lengthMode]);
  const typeSlug = options.obstacleTypes.length ? options.obstacleTypes.join('-') : 'all-obstacles';
  const bundleName = `${stamp}-${titleSlug}`;
  const bundleDir = path.join(recordingsDir, bundleName);
  const output = path.join(bundleDir, `${titleSlug}.output.${options.format}`);
  const thumbnail = path.join(bundleDir, `${titleSlug}.thumbnail.jpg`);
  const youtubeMetadata = path.join(bundleDir, `${titleSlug}.youtube.json`);
  const youtubeUpload = path.join(bundleDir, `${titleSlug}.youtube-upload.json`);
  const renderLog = path.join(bundleDir, `${titleSlug}.log`);
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
  const args = [...renderBaseRest, ...renderExtraArgs];

  const job = {
    id,
    status: options.dryRun ? 'completed' : 'running',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: options.dryRun ? new Date().toISOString() : null,
    exitCode: options.dryRun ? 0 : null,
    signal: null,
    options,
    output,
    outputFolder: bundleDir,
    outputTitle: titleSlug,
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
  });
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
    const req = http.get(url, (res) => {
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

function restartDashboardServer({ dryRun = false } = {}) {
  const domainTarget = getLaunchAgentDomainTarget();
  const serviceTarget = `${domainTarget}/${DASHBOARD_LAUNCH_AGENT_LABEL}`;
  const command = ['launchctl', 'kickstart', '-k', serviceTarget];
  const before = getDashboardLaunchAgentStatus();
  if (dryRun) {
    return {
      restarted: false,
      dryRun: true,
      command: command.join(' '),
      before,
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
    message: 'dashboard restart scheduled; this HTTP connection may drop while launchd restarts the server',
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

    <section class="shell">
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
              <option value="1080p-smooth" selected>1080p Smooth（60fps）</option>
              <option value="1080p">1080p（60fps）</option>
              <option value="1440p">High 1440p（60fps）</option>
              <option value="4k">Ultra 4K（60fps）</option>
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
          <label class="check"><input id="uploadYoutube" name="uploadYoutube" type="checkbox" checked> <span>生成完成後自動上傳 YouTube</span></label>
          <div>
            <label for="youtubePrivacy">YouTube privacy</label>
            <select id="youtubePrivacy" name="youtubePrivacy">
              <option value="public" selected>Public（default）</option>
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
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
            <p class="muted">預設會輸出 MP4，並同時產生 comparison WebM；thumbnail 預設開啟。留空 Thumbnail 大字時，由 render 根據 event 自動選近期不重覆標題。YouTube 上傳預設開啟，privacy 預設 Public；測試時可改 Private。</p>
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
document.querySelector('#bumperOnly').onclick = () => setTypes(['popBumper']);
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
        { value: 'public', label: 'Public', default: true },
        { value: 'private', label: 'Private' },
        { value: 'unlisted', label: 'Unlisted' },
      ],
      defaults: { uploadYoutube: true, youtubePrivacy: 'public' },
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

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    jsonResponse(res, 500, { ok: false, error: error.message });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[game-dashboard] http://${HOST}:${PORT}`);
  console.log(`[game-dashboard] config: ${configPath}`);
  console.log(`[game-dashboard] active game: ${activeGame.id} @ ${rootDir}`);
});
