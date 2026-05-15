const forcedFilenameByDownloadId = new Map();
const EXPECTED_EXTENSION_ID = 'cmaoohlnmjijkkjjjbljplmpghgddhhi';
const WEB_OAUTH_CLIENT_ID = '826257547518-6dm3mr58tnfgd84dsv2em1vnvuoad4m6.apps.googleusercontent.com';
const OAUTH_SCOPE = 'openid email profile';
let authInProgress = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message).then(sendResponse);
  return true;
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const forced = forcedFilenameByDownloadId.get(item.id);
  if (forced) {
    forcedFilenameByDownloadId.delete(item.id);
    suggest({ filename: forced, conflictAction: 'uniquify' });
    return;
  }
  suggest();
});

async function handleMessage(message) {
  try {
    switch (message?.type) {
      case 'AUTH_DIAGNOSTICS':
        return getAuthDiagnostics();
      case 'AUTH_CLEAR_CACHE':
        return await clearAuthCache();
      case 'AUTH_RAW_TEST':
        return await runRawAuthTest();
      case 'AUTH_GET_STATE':
        return await getAuthState();
      case 'AUTH_LOGIN':
        return await loginWithGoogle();
      case 'AUTH_LOGOUT':
        return await logoutGoogle();
      case 'START_DOWNLOAD':
        return await startDownload(message.payload);
      default:
        return { ok: false, error: 'Unknown message' };
    }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function getAuthDiagnostics() {
  return {
    ok: true,
    runtimeId: chrome.runtime.id,
    expectedId: EXPECTED_EXTENSION_ID,
    idMatch: chrome.runtime.id === EXPECTED_EXTENSION_ID,
    webClientId: WEB_OAUTH_CLIENT_ID
  };
}

async function getAuthState() {
  const stored = await chrome.storage.local.get({ authUser: null, authStatus: 'signed_out' });
  if (stored.authStatus === 'signed_in' && stored.authUser?.email) {
    return { ok: true, signedIn: true, user: stored.authUser };
  }
  return { ok: true, signedIn: false, user: null };
}

async function loginWithGoogle() {
  if (authInProgress) {
    return { ok: false, error: 'Auth already in progress. Please complete the opened sign-in window.' };
  }
  authInProgress = true;
  try {
    if (chrome.runtime.id !== EXPECTED_EXTENSION_ID) {
      throw new Error(`Extension ID mismatch. Current: ${chrome.runtime.id}, expected: ${EXPECTED_EXTENSION_ID}. Recreate OAuth client for current ID or pin extension key.`);
    }
    const token = await getAccessTokenViaWebAuthFlow();
    const profile = await fetchGoogleUserInfo(token);
    const email = profile?.email || '';
    if (!email) throw new Error('Email not available from Google account.');
    const user = {
      email,
      name: profile?.name || email,
      picture: profile?.picture || ''
    };
    await chrome.storage.local.set({
      authStatus: 'signed_in',
      authUser: user,
      authTokenCached: false,
      authAccessToken: token
    });
    return { ok: true, signedIn: true, user };
  } catch (err) {
    const raw = String(err?.message || err || 'Google login failed');
    return { ok: false, error: raw };
  } finally {
    authInProgress = false;
  }
}

async function logoutGoogle() {
  try {
    const data = await chrome.storage.local.get({ authAccessToken: '' });
    const token = data.authAccessToken || '';
    if (token) {
      await revokeToken(token);
    }
  } catch (_) {
    // ignore token cleanup failures
  }
  await chrome.storage.local.set({ authStatus: 'signed_out', authUser: null, authTokenCached: false, authAccessToken: '' });
  return { ok: true, signedIn: false };
}

async function clearAuthCache() {
  return new Promise((resolve) => {
    chrome.identity.clearAllCachedAuthTokens(async () => {
      const err = chrome.runtime.lastError?.message || '';
      await chrome.storage.local.set({ authStatus: 'signed_out', authUser: null, authTokenCached: false, authAccessToken: '' });
      if (err) {
        resolve({ ok: false, error: err });
        return;
      }
      resolve({ ok: true });
    });
  });
}

async function runRawAuthTest() {
  if (authInProgress) {
    return { ok: false, error: 'Auth already in progress. Close existing auth window and retry.' };
  }
  authInProgress = true;
  const result = {
    ok: true,
    webClientId: WEB_OAUTH_CLIENT_ID,
    authUrl: '',
    redirectUri: '',
    redirectUrlReceived: '',
    tokenParsed: false,
    token: '',
    lastError: '',
    userinfoStatus: null,
    userinfoResponse: '',
    userinfoFetchError: ''
  };

  try {
    const redirectUri = chrome.identity.getRedirectURL().replace(/\/$/, '');
    result.redirectUri = redirectUri;
    const authUrl = buildGoogleAuthUrl(redirectUri);
    result.authUrl = authUrl;
    console.log('WEB_CLIENT_ID:', WEB_OAUTH_CLIENT_ID);
    console.log('REDIRECT_URI:', redirectUri);
    console.log('AUTH_URL:', authUrl);
    const responseUrl = await launchWebAuthInteractive(authUrl);
    result.redirectUrlReceived = responseUrl || '';
    const token = extractAccessTokenFromRedirect(responseUrl || '');
    result.tokenParsed = Boolean(token);
    result.token = token || '';

    if (!token) {
      result.lastError = 'No access_token found in redirect URL';
      return result;
    }

    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${token}` }
      });
      result.userinfoStatus = res.status;
      result.userinfoResponse = await res.text();
      return result;
    } catch (err) {
      result.userinfoFetchError = String(err?.message || err);
      return result;
    }
  } catch (err) {
    result.lastError = String(err?.message || err);
    return result;
  } finally {
    authInProgress = false;
  }
}

async function getAccessTokenViaWebAuthFlow() {
  if (WEB_OAUTH_CLIENT_ID.includes('__SET_WEB_OAUTH_CLIENT_ID__')) {
    throw new Error('Web OAuth client ID is not configured yet.');
  }
  const redirectUri = chrome.identity.getRedirectURL().replace(/\/$/, '');
  const authUrl = buildGoogleAuthUrl(redirectUri);
  console.log('WEB_CLIENT_ID:', WEB_OAUTH_CLIENT_ID);
  console.log('REDIRECT_URI:', redirectUri);
  console.log('AUTH_URL:', authUrl);
  const responseUrl = await launchWebAuthInteractive(authUrl);
  const token = extractAccessTokenFromRedirect(responseUrl || '');
  if (!token) {
    throw new Error('No access_token found in OAuth redirect URL.');
  }
  return token;
}

function buildGoogleAuthUrl(redirectUri) {
  const params = new URLSearchParams({
    response_type: 'token',
    client_id: WEB_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPE,
    prompt: 'select_account'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function launchWebAuthInteractive(url) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (redirectedTo) => {
      if (chrome.runtime.lastError || !redirectedTo) {
        reject(new Error(chrome.runtime.lastError?.message || 'launchWebAuthFlow failed'));
        return;
      }
      resolve(redirectedTo);
    });
  });
}

function extractAccessTokenFromRedirect(redirectedTo) {
  if (!redirectedTo) return '';
  const hash = redirectedTo.split('#')[1] || '';
  if (!hash) return '';
  const params = new URLSearchParams(hash);
  return params.get('access_token') || '';
}

async function fetchGoogleUserInfo(token) {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`userinfo request failed: HTTP ${response.status}`);
  }
  return await response.json();
}

async function revokeToken(token) {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
}

async function startDownload(payload) {
  const { url, filename, saveAs } = payload || {};
  if (!url || !filename) return { ok: false, error: 'Missing url/filename' };

  return new Promise((resolve) => {
    chrome.downloads.download({ url, saveAs: Boolean(saveAs) }, (downloadId) => {
      if (chrome.runtime.lastError || typeof downloadId !== 'number') {
        resolve({ ok: false, error: chrome.runtime.lastError?.message || 'Download failed' });
        return;
      }
      forcedFilenameByDownloadId.set(downloadId, filename);
      resolve({ ok: true, downloadId });
    });
  });
}
