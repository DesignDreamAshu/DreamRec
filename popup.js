const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const qualitySelect = document.getElementById('quality');
const formatSelect = document.getElementById('format');
const sizeModeSelect = document.getElementById('sizeMode');
const fpsSelect = document.getElementById('fps');
const timerEl = document.getElementById('timer');
const saveAsCheckbox = document.getElementById('saveAsCheckbox');

let timerId = null;
let startedAtMs = null;
let recorderTabId = null;
let isRecording = false;

init();

startBtn.addEventListener('click', startRecordingFlow);
stopBtn.addEventListener('click', stopRecordingFlow);
qualitySelect.addEventListener('change', saveSettings);
formatSelect.addEventListener('change', saveSettings);
sizeModeSelect.addEventListener('change', saveSettings);
fpsSelect.addEventListener('change', saveSettings);
saveAsCheckbox.addEventListener('change', saveSettings);

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'recorderStatus') return;
  applyStatus(message);
});

async function init() {
  const data = await chrome.storage.local.get({
    recorderTabId: null,
    isRecording: false,
    startedAtMs: null,
    qualityPreset: '1080p',
    outputFormat: 'mp4',
    sizeMode: 'small',
    fps: 30,
    saveAsEnabled: true
  });

  recorderTabId = typeof data.recorderTabId === 'number' ? data.recorderTabId : null;
  isRecording = Boolean(data.isRecording);
  startedAtMs = typeof data.startedAtMs === 'number' ? data.startedAtMs : null;

  qualitySelect.value = data.qualityPreset || '1080p';
  if (!qualitySelect.querySelector(`option[value="${qualitySelect.value}"]`)) {
    qualitySelect.value = '1080p';
  }
  formatSelect.value = data.outputFormat || 'mp4';
  if (!formatSelect.querySelector(`option[value="${formatSelect.value}"]`)) {
    formatSelect.value = 'mp4';
  }
  sizeModeSelect.value = data.sizeMode || 'small';
  if (!sizeModeSelect.querySelector(`option[value="${sizeModeSelect.value}"]`)) {
    sizeModeSelect.value = 'small';
  }
  fpsSelect.value = String(data.fps || 30);
  if (!fpsSelect.querySelector(`option[value="${fpsSelect.value}"]`)) {
    fpsSelect.value = '30';
  }
  saveAsCheckbox.checked = data.saveAsEnabled !== false;
  syncUi();
}

async function startRecordingFlow() {
  if (isRecording) return;
  saveSettings();
  updateStatus('Opening recorder page...');
  startBtn.disabled = true;

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const returnTabId = typeof active?.id === 'number' ? active.id : null;

  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL('recorder-page.html'),
    active: true
  });
  recorderTabId = tab.id;

  await chrome.storage.local.set({
    recorderTabId,
    isRecording: false,
    startedAtMs: null
  });

  chrome.tabs.onUpdated.addListener(function onUpdated(tabId, changeInfo) {
    if (tabId !== recorderTabId || changeInfo.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.sendMessage(recorderTabId, {
      type: 'startRecordingFromPopup',
      returnTabId
    });
  });
}

async function stopRecordingFlow() {
  if (!recorderTabId) {
    updateStatus('No active recording tab found.');
    return;
  }
  try {
    await chrome.tabs.sendMessage(recorderTabId, { type: 'stopRecordingFromPopup' });
    updateStatus('Stopping recording...');
  } catch (err) {
    updateStatus('Recorder tab not reachable. Recording may have already stopped.');
  }
}

function saveSettings() {
  chrome.storage.sync.set({
    qualityPreset: qualitySelect.value,
    outputFormat: formatSelect.value,
    sizeMode: sizeModeSelect.value,
    fps: Number(fpsSelect.value),
    saveAsEnabled: Boolean(saveAsCheckbox.checked)
  });
}

function applyStatus(message) {
  if (message.state === 'starting') {
    updateStatus(message.message || 'Picker opened. Please select a window/tab.');
    startBtn.disabled = true;
    stopBtn.disabled = true;
    return;
  }

  if (message.state === 'recording') {
    isRecording = true;
    recorderTabId = message.recorderTabId ?? recorderTabId;
    startedAtMs = message.startedAtMs || Date.now();
    chrome.storage.local.set({
      isRecording: true,
      startedAtMs,
      recorderTabId
    });
    updateStatus('Recording...');
    syncUi();
    return;
  }

  if (message.state === 'stopped' || message.state === 'saved' || message.state === 'cancelled' || message.state === 'error') {
    isRecording = false;
    startedAtMs = null;
    if (message.state === 'saved') {
      updateStatus(`Saved: ${message.filename}`);
    } else if (message.state === 'cancelled') {
      updateStatus('Share cancelled.');
    } else if (message.state === 'error') {
      updateStatus(message.message || 'Recording error.');
    } else {
      updateStatus('Stopped.');
    }
    chrome.storage.local.set({
      isRecording: false,
      startedAtMs: null
    });
    syncUi();
  }
}

function syncUi() {
  startBtn.disabled = isRecording;
  stopBtn.disabled = !isRecording;
  if (isRecording && startedAtMs) {
    startTimer();
  } else {
    stopTimer();
    renderTimer(0);
  }
}

function startTimer() {
  stopTimer();
  renderTimer(Math.floor((Date.now() - startedAtMs) / 1000));
  timerId = setInterval(() => {
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
