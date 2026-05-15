/* LOCKED BASELINE (do not change without explicit user request)
 * Stable recording flow:
 * recorder-page.js handles WebM-only capture and download.
 */
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const timerEl = document.getElementById('timer');
const debugTraceEl = document.getElementById('debugTrace');
const copyLogsBtn = document.getElementById('copyLogsBtn');
const clearLogsBtn = document.getElementById('clearLogsBtn');

let mediaStream = null;
let mediaRecorder = null;
let micStream = null;
let audioContext = null;
let mixedAudioDestination = null;
let chunks = [];
let timerId = null;
let startedAtMs = null;
let qualityPreset = '1080p';
let sizeMode = 'balanced';
let fps = 30;
let saveAsEnabled = false;
let returnTabId = null;
let isRecordingActive = false;
let lastEffectiveFps = 30;
let lastTargetBitrate = 1_900_000;

const debugLines = [];
const MAX_DEBUG_LINES = 400;

const QUALITY_PRESETS = {
  '720p': { width: 1280, height: 720, bitrate: 1_500_000 },
  '1080p': { width: 1920, height: 1080, bitrate: 1_900_000 },
  '1440p': { width: 2560, height: 1440, bitrate: 3_200_000 },
  '2160p': { width: 3840, height: 2160, bitrate: 5_800_000 }
};

const SIZE_MODES = {
  compat: { bitrateFactor: 1.15, frameRate: 30 },
  balanced: { bitrateFactor: 1.0, frameRate: 30 },
  small: { bitrateFactor: 0.72, frameRate: 24 },
  ultra: { bitrateFactor: 0.55, frameRate: 20 }
};

const WEBM_MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

const initPromise = init();
startBtn.addEventListener('click', () => startRecording(true));
stopBtn.addEventListener('click', stopRecording);
copyLogsBtn?.addEventListener('click', copyDebugLogs);
clearLogsBtn?.addEventListener('click', clearDebugLogs);
window.addEventListener('beforeunload', handleBeforeUnload);

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === 'startRecordingFromPopup') {
    returnTabId = typeof message.returnTabId === 'number' ? message.returnTabId : null;
    startRecording(false);
  }
  if (message.type === 'stopRecordingFromPopup') {
    stopRecording();
  }
});

async function init() {
  const settings = await chrome.storage.sync.get({
    qualityPreset: '1080p',
    sizeMode: 'balanced',
    fps: 30,
    saveAsEnabled: false
  });
  qualityPreset = settings.qualityPreset in QUALITY_PRESETS ? settings.qualityPreset : '1080p';
  sizeMode = settings.sizeMode in SIZE_MODES ? settings.sizeMode : 'balanced';
  fps = [30, 60].includes(Number(settings.fps)) ? Number(settings.fps) : 30;
  saveAsEnabled = settings.saveAsEnabled === true;
  pushDebug(`init: output=webm, fps=${fps}, quality=${qualityPreset}, mode=${sizeMode}`);
}

async function startRecording(userInitiated) {
  await initPromise;
  if (mediaRecorder && mediaRecorder.state === 'recording') return;

  const mimeType = pickWebmMimeType();
  if (!mimeType) {
    notify('error', { message: 'No supported WebM recording format found.' });
    updateStatus('No supported WebM recording format found.');
    return;
  }

  updateStatus('Opening screen share picker...');
  pushDebug(`start: preparing capture, mime=${mimeType}`);
  notify('starting', { message: 'Opening screen share picker...' });

  const preset = QUALITY_PRESETS[qualityPreset];
  const mode = SIZE_MODES[sizeMode];
  const targetFps = fps || mode.frameRate || 30;
  lastEffectiveFps = targetFps;
  const targetBitrate = Math.max(900_000, Math.round(preset.bitrate * mode.bitrateFactor));
  lastTargetBitrate = targetBitrate;

  try {
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: targetFps, max: targetFps }
      },
      audio: true
    });
  } catch (err) {
    pushDebug(`capture cancelled: ${String(err?.message || err)}`);
    notify('cancelled');
    updateStatus(`Share cancelled: ${err?.message || err}`);
    chrome.storage.local.set({ isRecording: false, startedAtMs: null, recorderTabId: null });
    setIdleUi();
    closeRecorderTabSoon();
    return;
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (_) {
    micStream = null;
  }

  const displayAudioTracks = mediaStream.getAudioTracks();
  const micAudioTracks = micStream ? micStream.getAudioTracks() : [];

  if (displayAudioTracks.length > 0 && micAudioTracks.length > 0) {
    audioContext = new AudioContext();
    mixedAudioDestination = audioContext.createMediaStreamDestination();
    const displaySource = audioContext.createMediaStreamSource(new MediaStream(displayAudioTracks));
    const micSource = audioContext.createMediaStreamSource(new MediaStream(micAudioTracks));
    displaySource.connect(mixedAudioDestination);
    micSource.connect(mixedAudioDestination);

    for (const track of displayAudioTracks) mediaStream.removeTrack(track);
    for (const track of micAudioTracks) mediaStream.removeTrack(track);
    for (const mixedTrack of mixedAudioDestination.stream.getAudioTracks()) mediaStream.addTrack(mixedTrack);
  } else if (displayAudioTracks.length === 0 && micAudioTracks.length > 0) {
    for (const micTrack of micAudioTracks) mediaStream.addTrack(micTrack);
  }

  if (!mediaStream.getAudioTracks().length) {
    pushDebug('audio: no audio track in final stream');
    updateStatus('Recording started without audio. Share audio or allow microphone permission.');
  }

  chunks = [];
  startedAtMs = Date.now();
  renderTimer(0);
  startTimer();

  for (const track of mediaStream.getTracks()) {
    track.onended = () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') stopRecording();
    };
  }

  try {
    mediaRecorder = new MediaRecorder(mediaStream, {
      mimeType,
      videoBitsPerSecond: targetBitrate,
      audioBitsPerSecond: 128_000
    });
  } catch (err) {
    cleanup();
    notify('error', { message: `Recorder init failed: ${err?.message || err}` });
    updateStatus(`Recorder init failed: ${err?.message || err}`);
    return;
  }

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  mediaRecorder.onerror = (event) => {
    notify('error', { message: event.error?.message || 'Unknown recording error' });
    stopRecording();
  };
  mediaRecorder.onstop = saveRecording;

  mediaRecorder.start(1000);
  pushDebug(`recording started: ${qualityPreset}, ${lastEffectiveFps}fps, bitrate=${lastTargetBitrate}`);
  startBtn.disabled = true;
  stopBtn.disabled = false;
  isRecordingActive = true;
  updateStatus(`Recording (${qualityPreset}, WEBM, ${sizeMode}, ${targetFps}fps)...`);
  notify('recording', { startedAtMs });

  if (!userInitiated && typeof returnTabId === 'number') {
    chrome.tabs.update(returnTabId, { active: true });
  }
}

function stopRecording() {
  stopTimer();
  isRecordingActive = false;
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    pushDebug('stop: requested');
    try { mediaRecorder.requestData(); } catch (_) {}
    try { mediaRecorder.stop(); } catch (_) {}
  } else {
    cleanup();
    setIdleUi();
    notify('stopped');
    closeRecorderTabSoon();
  }
}

function saveRecording() {
  if (!chunks.length) {
    pushDebug('save: no chunks captured');
    cleanup();
    setIdleUi();
    updateStatus('Nothing recorded.');
    notify('stopped');
    closeRecorderTabSoon();
    return;
  }

  const webmBlob = new Blob(chunks, { type: 'video/webm' });
  pushDebug(`save: chunks=${chunks.length}, webmSize=${webmBlob.size}`);
  const webmName = buildFilename('webm');

  downloadBlob(webmBlob, webmName).then(() => {
    updateStatus(`Saved as: ${webmName}`);
    notify('saved', { filename: webmName, engine: 'capture-webm' });
    cleanup();
    setIdleUi();
    chrome.storage.local.set({ isRecording: false, startedAtMs: null });
    closeRecorderTabSoon();
  });
}

function notify(state, extra = {}) {
  chrome.runtime.sendMessage({ type: 'recorderStatus', state, ...extra }, () => {
    void chrome.runtime.lastError;
  });
  if (state === 'recording') chrome.storage.local.set({ isRecording: true, startedAtMs });
}

function cleanup() {
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (audioContext) {
    try { audioContext.close(); } catch (_) {}
  }
  mixedAudioDestination = null;
  mediaStream = null;
  micStream = null;
  audioContext = null;
  mediaRecorder = null;
  chunks = [];
  isRecordingActive = false;
}

function downloadBlob(blob, filename) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    pushDebug(`download request: ${filename} size=${blob.size}`);
    chrome.runtime.sendMessage(
      { type: 'START_DOWNLOAD', payload: { url, filename, saveAs: saveAsEnabled } },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          const msg = chrome.runtime.lastError?.message || response?.error || 'Download failed';
          pushDebug(`download failed: ${msg}`);
          updateStatus(`Save failed: ${msg}`);
          notify('error', { message: msg });
        } else {
          pushDebug(`download ok: id=${response.downloadId} file=${filename}`);
        }
        setTimeout(() => URL.revokeObjectURL(url), 15_000);
        resolve();
      }
    );
  });
}

function setIdleUi() {
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

function startTimer() {
  stopTimer();
  timerId = setInterval(() => {
    if (!startedAtMs) return;
    renderTimer(Math.floor((Date.now() - startedAtMs) / 1000));
  }, 1000);
}

function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
}

function renderTimer(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  timerEl.textContent = `${m}:${s}`;
}

function updateStatus(text) {
  statusEl.textContent = text || 'Idle';
}

function pickWebmMimeType() {
  for (const type of WEBM_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function buildFilename(ext = 'webm') {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `DreamRec_Meeting_${stamp}_${qualityPreset}_${lastEffectiveFps}fps_${sizeMode}.${ext}`;
}

function closeRecorderTabSoon() {
  setTimeout(() => {
    chrome.tabs.getCurrent((tab) => {
      if (chrome.runtime.lastError || !tab?.id) return;
      chrome.tabs.remove(tab.id);
    });
  }, 350);
}

function pushDebug(line) {
  const ts = new Date().toLocaleTimeString();
  debugLines.unshift(`[${ts}] ${line}`);
  if (debugLines.length > MAX_DEBUG_LINES) debugLines.length = MAX_DEBUG_LINES;
  if (debugTraceEl) debugTraceEl.textContent = debugLines.join('\n');
}

async function copyDebugLogs() {
  try {
    const text = debugLines.join('\n') || 'No logs yet.';
    await navigator.clipboard.writeText(text);
    pushDebug('debug: logs copied to clipboard');
  } catch (err) {
    pushDebug(`debug: copy failed: ${String(err?.message || err)}`);
  }
}

function clearDebugLogs() {
  debugLines.length = 0;
  if (debugTraceEl) debugTraceEl.textContent = 'Debug trace cleared.';
}

function handleBeforeUnload(event) {
  if (!isRecordingActive) return;
  const warningMessage = 'Do you really want to close this tab? If you close it, the current recording may be lost.';
  event.preventDefault();
  event.returnValue = warningMessage;
  return warningMessage;
}
