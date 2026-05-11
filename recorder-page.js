const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const timerEl = document.getElementById('timer');

let mediaStream = null;
let mediaRecorder = null;
let chunks = [];
let timerId = null;
let startedAtMs = null;
let qualityPreset = '1080p';
let outputFormat = 'mp4';
let sizeMode = 'small';
let fps = 30;
let saveAsEnabled = true;
let returnTabId = null;
let activeMimeType = '';

const QUALITY_PRESETS = {
  '720p': { width: 1280, height: 720, frameRate: 30, bitrate: 3_500_000 },
  '1080p': { width: 1920, height: 1080, frameRate: 30, bitrate: 6_000_000 },
  '1440p': { width: 2560, height: 1440, frameRate: 30, bitrate: 10_000_000 },
  '2160p': { width: 3840, height: 2160, frameRate: 30, bitrate: 18_000_000 }
};

const SIZE_MODES = {
  compat: { bitrateFactor: 1.15, frameRate: 30 },
  balanced: { bitrateFactor: 1.0, frameRate: 30 },
  small: { bitrateFactor: 0.72, frameRate: 24 },
  ultra: { bitrateFactor: 0.55, frameRate: 20 }
};

const FORMAT_MIME_CANDIDATES = {
  mp4: ['video/mp4;codecs=avc1.42E01E', 'video/mp4'],
  webm: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
};

init();
startBtn.addEventListener('click', () => startRecording(true));
stopBtn.addEventListener('click', stopRecording);

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
    outputFormat: 'mp4',
    sizeMode: 'small',
    fps: 30,
    saveAsEnabled: true
  });
  qualityPreset = settings.qualityPreset in QUALITY_PRESETS ? settings.qualityPreset : '1080p';
  outputFormat = settings.outputFormat === 'mp4' ? 'mp4' : 'webm';
  sizeMode = settings.sizeMode in SIZE_MODES ? settings.sizeMode : 'small';
  fps = [25, 30, 60].includes(Number(settings.fps)) ? Number(settings.fps) : 30;
  saveAsEnabled = settings.saveAsEnabled !== false;
}

async function startRecording(userInitiated) {
  if (mediaRecorder && mediaRecorder.state === 'recording') return;

  const selected = pickSupportedFormatAndMime(outputFormat);
  if (!selected) {
    notify('error', { message: 'No supported recording format found in this browser.' });
    updateStatus('No supported recording format found in this browser.');
    return;
  }
  activeMimeType = selected.mimeType;
  const effectiveFormat = selected.format;
  const fallbackMessage =
    outputFormat === 'mp4' && effectiveFormat !== 'mp4'
      ? 'MP4 not supported here. Falling back to WebM.'
      : 'Opening screen share picker...';

  updateStatus(fallbackMessage);
  notify('starting', { message: fallbackMessage });

  const preset = QUALITY_PRESETS[qualityPreset];
  const mode = SIZE_MODES[sizeMode];
  const targetFps = fps || mode.frameRate;
  const targetBitrate = Math.max(1_500_000, Math.round(preset.bitrate * mode.bitrateFactor));

  try {
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: targetFps, max: targetFps }
      },
      audio: false
    });
  } catch (err) {
    notify('cancelled');
    updateStatus(`Share cancelled: ${err?.message || err}`);
    return;
  }

  chunks = [];
  startedAtMs = Date.now();
  renderTimer(0);
  startTimer();

  for (const track of mediaStream.getTracks()) {
    track.onended = () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        stopRecording();
      }
    };
  }

  try {
    mediaRecorder = new MediaRecorder(mediaStream, {
      mimeType: activeMimeType,
      videoBitsPerSecond: targetBitrate
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
  startBtn.disabled = true;
  stopBtn.disabled = false;
  updateStatus(`Recording (${qualityPreset}, ${effectiveFormat.toUpperCase()}, ${sizeMode}, ${targetFps}fps)...`);

  notify('recording', {
    startedAtMs
  });

  // When started from popup flow, move user back to original tab for seamless UX.
  if (!userInitiated && typeof returnTabId === 'number') {
    chrome.tabs.update(returnTabId, { active: true });
  }
}

function stopRecording() {
  stopTimer();
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    try { mediaRecorder.requestData(); } catch (_) {}
    try { mediaRecorder.stop(); } catch (_) {}
  } else {
    cleanup();
    setIdleUi();
    notify('stopped');
  }
}

function saveRecording() {
  if (!chunks.length) {
    cleanup();
    setIdleUi();
    updateStatus('Nothing recorded.');
    notify('stopped');
    return;
  }

  const mimeType = mediaRecorder?.mimeType || activeMimeType || 'video/webm';
  const blob = new Blob(chunks, { type: mimeType });
  const url = URL.createObjectURL(blob);
  const fileExt = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const filename = buildFilename(fileExt);

  chrome.downloads.download({ url, filename, saveAs: saveAsEnabled }, () => {
    if (chrome.runtime.lastError) {
      updateStatus(`Save failed: ${chrome.runtime.lastError.message}`);
      notify('error', { message: chrome.runtime.lastError.message });
    } else {
      updateStatus(`Saved as: ${filename}`);
      notify('saved', { filename });
    }
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    cleanup();
    setIdleUi();
    chrome.storage.local.set({ isRecording: false, startedAtMs: null });
  });
}

function notify(state, extra = {}) {
  // Popup closed ho to receiver na mile; ignore this expected case.
  chrome.runtime.sendMessage({ type: 'recorderStatus', state, ...extra }, () => {
    void chrome.runtime.lastError;
  });
  if (state === 'recording') {
    chrome.storage.local.set({ isRecording: true, startedAtMs });
  }
}

function cleanup() {
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  mediaRecorder = null;
  chunks = [];
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

function pickSupportedFormatAndMime(preferredFormat) {
  const orderedFormats = preferredFormat === 'mp4' ? ['mp4', 'webm'] : ['webm', 'mp4'];
  for (const format of orderedFormats) {
    for (const type of FORMAT_MIME_CANDIDATES[format]) {
      if (MediaRecorder.isTypeSupported(type)) {
        return { format, mimeType: type };
      }
    }
  }
  return null;
}

function buildFilename(ext = 'webm') {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `meeting-recording-${qualityPreset}-${date}_${time}.${ext}`;
}
