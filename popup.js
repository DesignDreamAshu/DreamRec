/* LOCKED BASELINE (do not change without explicit user request)
 * Stable recording flow:
 * popup.js -> recorder-page.html -> recorder-page.js
 */
const SETTINGS_KEY = 'dreamrec-settings-v1';

const els = {
  authGate: document.getElementById('authGate'),
  appContent: document.getElementById('appContent'),
  authText: document.getElementById('authText'),
  loginBtn: document.getElementById('loginBtn'),
  logoutBtn: document.getElementById('logoutBtn'),
  userEmail: document.getElementById('userEmail'),
  resolution: document.getElementById('resolution'),
  fps: document.getElementById('fps'),
  quality: document.getElementById('quality'),
  outputMode: document.getElementById('outputMode'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  history: document.getElementById('history'),
  status: document.getElementById('status')
};

const defaults = {
  resolution: '1080p',
  fps: 30,
  quality: 'medium',
  outputMode: 'webm'
};
let isRecording = false;
let recorderTabId = null;
let popupAuthBusy = false;

bindStaticAuthActions();
init().catch((err) => setStatus(`Init failed: ${err.message}`));

async function init() {
  const auth = await sendRuntimeMessage({ type: 'AUTH_GET_STATE' });
  if (!auth?.ok) {
    showAuthGate(`Auth check failed: ${auth?.error || 'unknown error'}`);
    return;
  }
  if (!auth.signedIn) {
    showAuthGate('Sign in required to use recorder.');
    return;
  }
  showApp(auth.user);

  const saved = loadSettings();
  applySettings(saved);

  els.resolution.addEventListener('change', persist);
  els.fps.addEventListener('change', persist);
  els.quality.addEventListener('change', persist);
  els.startBtn.addEventListener('click', startRecording);
  els.stopBtn.addEventListener('click', stopRecording);
  els.downloadBtn.addEventListener('click', renderDownloadHistory);

  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === 'recorderStatus') {
      applyRecorderStatus(message);
      return;
    }
    if (message.type === 'REC_STATUS') {
      if (typeof message.payload?.isRecording === 'boolean') {
        isRecording = message.payload.isRecording;
        syncButtons();
      }
      if (message.payload?.message) {
        const msg = message.payload.message;
        const isError = /failed|error/i.test(msg);
        setStatus(msg, isError);
        if (!message.payload.isRecording) void renderDownloadHistory();
      }
    }
  });

  const local = await chrome.storage.local.get({ recorderTabId: null, isRecording: false });
  recorderTabId = typeof local.recorderTabId === 'number' ? local.recorderTabId : null;
  isRecording = Boolean(local.isRecording);
  if (isRecording) {
    const tabAlive = await isRecorderTabAlive(recorderTabId);
    if (!tabAlive) {
      isRecording = false;
      recorderTabId = null;
      await chrome.storage.local.set({ isRecording: false, recorderTabId: null, startedAtMs: null });
    }
  }
  syncButtons();
  await renderDownloadHistory();
}

function bindStaticAuthActions() {
  if (els.loginBtn) els.loginBtn.addEventListener('click', login);
  if (els.logoutBtn) els.logoutBtn.addEventListener('click', logout);
}

function showAuthGate(text) {
  els.authGate.hidden = false;
  els.authGate.style.display = 'block';
  els.appContent.hidden = true;
  els.appContent.style.display = 'none';
  els.authText.textContent = text;
}

function showApp(user) {
  els.authGate.hidden = true;
  els.authGate.style.display = 'none';
  els.appContent.hidden = false;
  els.appContent.style.display = 'block';
  els.userEmail.textContent = user?.email || '';
}

async function login() {
  if (popupAuthBusy) return;
  popupAuthBusy = true;
  setAuthButtonsDisabled(true);
  els.authText.textContent = 'Signing in...';
  const res = await sendRuntimeMessage({ type: 'AUTH_LOGIN' });
  if (!res?.ok || !res?.signedIn) {
    showAuthGate(`Sign-in failed: ${res?.error || 'Unknown error'}`);
    popupAuthBusy = false;
    setAuthButtonsDisabled(false);
    return;
  }
  showApp(res.user);
  if (res.warning) setStatus(res.warning);
  await renderDownloadHistory();
  popupAuthBusy = false;
  setAuthButtonsDisabled(false);
}

async function logout() {
  await sendRuntimeMessage({ type: 'AUTH_LOGOUT' });
  showAuthGate('Signed out. Sign in required to use recorder.');
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaults };
    return { ...defaults, ...JSON.parse(raw), outputMode: 'webm' };
  } catch (_) {
    return { ...defaults };
  }
}

function applySettings(settings) {
  els.resolution.value = settings.resolution;
  els.fps.value = String(settings.fps);
  els.quality.value = settings.quality;
  els.outputMode.value = 'webm';
}

function persist() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(getSettings()));
}

function getSettings() {
  return {
    resolution: els.resolution.value,
    fps: Number(els.fps.value),
    quality: els.quality.value,
    outputMode: 'webm'
  };
}

async function startRecording() {
  if (isRecording) return;

  persist();
  const settings = getSettings();
  await chrome.storage.sync.set({
    qualityPreset: settings.resolution,
    fps: settings.fps,
    outputFormat: 'webm',
    sizeMode: mapQualityToSizeMode(settings.quality),    saveAsEnabled: false
  });

  setStatus('Opening recorder tab...');
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const returnTabId = typeof active?.id === 'number' ? active.id : null;

  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL('recorder-page.html'),
    active: true
  });
  recorderTabId = tab.id;
  isRecording = true;
  syncButtons();
  await chrome.storage.local.set({ recorderTabId, isRecording: true });

  chrome.tabs.onUpdated.addListener(function onUpdated(tabId, changeInfo) {
    if (tabId !== recorderTabId || changeInfo.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.sendMessage(recorderTabId, { type: 'startRecordingFromPopup', returnTabId }, () => {
      if (chrome.runtime.lastError) {
        isRecording = false;
        syncButtons();
        setStatus(`Failed to start: ${chrome.runtime.lastError.message}`, true);
      } else {
        setStatus('Share picker opened. Source select karo.');
      }
    });
  });
}

async function stopRecording() {
  if (!recorderTabId) {
    setStatus('No active recorder tab found.', true);
    return;
  }

  setStatus('Stopping recording...');
  chrome.tabs.sendMessage(recorderTabId, { type: 'stopRecordingFromPopup' }, () => {
    if (chrome.runtime.lastError) {
      isRecording = false;
      syncButtons();
      setStatus('Recorder tab reachable nahi hai.', true);
      return;
    }
    setStatus('Stopping and saving WebM...');
  });
}

function applyRecorderStatus(message) {
  const state = message.state;

  if (state === 'progress') {
    if (message.message) setStatus(message.message);
    return;
  }

  if (state === 'recording') {
    isRecording = true;
    syncButtons();
    setStatus('Recording in progress...');
    return;
  }

  if (state === 'saved') {
    isRecording = false;
    syncButtons();
    setStatus(`Saved: ${message.filename || 'recording file'}`);
    void chrome.storage.local.set({ isRecording: false, recorderTabId: null });
    void renderDownloadHistory();
    return;
  }

  if (state === 'cancelled') {
    isRecording = false;
    syncButtons();
    setStatus('Share cancelled.');
    void chrome.storage.local.set({ isRecording: false, recorderTabId: null });
    return;
  }

  if (state === 'error') {
    isRecording = false;
    syncButtons();
    setStatus(`Error: ${message.message || 'recording failed'}`, true);
    void chrome.storage.local.set({ isRecording: false, recorderTabId: null });
    return;
  }

  if (state === 'stopped') {
    isRecording = false;
    syncButtons();
    setStatus('Stopped.');
    void chrome.storage.local.set({ isRecording: false, recorderTabId: null });
    void renderDownloadHistory();
  }
}

function mapQualityToSizeMode(quality) {
  if (quality === 'high') return 'compat';
  if (quality === 'low') return 'small';
  return 'balanced';
}

function syncButtons() {
  els.startBtn.disabled = isRecording;
  els.stopBtn.disabled = !isRecording;
}

function setStatus(text, isError = false) {
  els.status.textContent = text || 'Idle';
  els.status.classList.toggle('status--error', isError);
}

async function renderDownloadHistory() {
  const all = await new Promise((resolve) => {
    chrome.downloads.search({ orderBy: ['-startTime'], limit: 50 }, (items) => {
      resolve(items || []);
    });
  });

  const mine = all
    .filter((item) =>
      item &&
      item.state === 'complete' &&
      item.byExtensionId === chrome.runtime.id &&
      /DreamRec|meeting_/i.test(item.filename || '')
    )
    .slice(0, 8);

  if (!mine.length) {
    els.history.innerHTML = '<div class="history-row"><div class="history-time">No recordings yet.</div></div>';
    return;
  }

  const filesHtml = mine
    .map((item) => {
      const fileName = (item.filename || '').split(/[\\/]/).pop() || 'recording';
      const when = item.endTime ? new Date(item.endTime).toLocaleString() : '';
      return `
        <div class="history-row">
          <div>
            <div class="history-name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
            <div class="history-time">${escapeHtml(when)} • webm</div>
          </div>
          <div class="history-actions">
            <button class="history-btn" data-id="${item.id}" data-action="reveal">Reveal</button>
          </div>
        </div>
      `;
    })
    .join('');
  els.history.innerHTML = filesHtml;

  for (const btn of els.history.querySelectorAll('.history-btn')) {
    btn.addEventListener('click', () => {
      const id = Number(btn.getAttribute('data-id'));
      if (!Number.isFinite(id)) return;
      chrome.downloads.show(id);
    });
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function isRecorderTabAlive(tabId) {
  if (typeof tabId !== 'number') return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    return Boolean(tab && !tab.discarded);
  } catch (_) {
    return false;
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'Empty response' });
    });
  });
}

function setAuthButtonsDisabled(disabled) {
  if (els.loginBtn) els.loginBtn.disabled = disabled;
}

