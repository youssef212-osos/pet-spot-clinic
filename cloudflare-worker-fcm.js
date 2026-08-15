const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-PetSpot-Notify-Secret'
};

const SITE_URL = 'https://youssef212-osos.github.io/pet-spot-clinic/';
const WORKER_VERSION = 'notify-transport-v3';


function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders }
  });
}

function base64url(input) {
  const bytes = input instanceof Uint8Array ? input : new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64ToBytes(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = String(value || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!clean) throw new Error('Firebase private key is missing');
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = clean[i];
    const c1 = clean[i + 1] || '=';
    const c2 = clean[i + 2] || '=';
    const c3 = clean[i + 3] || '=';
    const a = alphabet.indexOf(c0);
    const b = alphabet.indexOf(c1);
    const c = c2 === '=' ? 0 : alphabet.indexOf(c2);
    const d = c3 === '=' ? 0 : alphabet.indexOf(c3);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('Firebase private key contains invalid base64 characters');
    out.push((a << 2) | (b >> 4));
    if (c2 !== '=') out.push(((b & 15) << 4) | (c >> 2));
    if (c3 !== '=') out.push(((c & 3) << 6) | d);
  }
  return new Uint8Array(out).buffer;
}

function pemToArrayBuffer(pem) {
  let value = String(pem ?? '').trim();
  value = value.replace(/^['\"]|['\"]$/g, '');
  value = value.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\r');
  const match = value.match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/);
  if (match) value = match[1];
  const clean = value.replace(/[^A-Za-z0-9+/_=-]/g, '');
  if (!clean) throw new Error('Firebase private key is missing');
  return base64ToBytes(clean);
}

function getServiceAccount(env) {
  if (env.FIREBASE_SERVICE_ACCOUNT) {
    const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    return {
      client_email: account.client_email,
      private_key: account.private_key,
      project_id: account.project_id || env.FIREBASE_PROJECT_ID
    };
  }
  if (env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY && env.FIREBASE_PROJECT_ID) {
    return {
      client_email: env.FIREBASE_CLIENT_EMAIL,
      private_key: env.FIREBASE_PRIVATE_KEY,
      project_id: env.FIREBASE_PROJECT_ID
    };
  }
  throw new Error('Firebase service-account configuration is missing');
}

function getFirebaseProjectId(env, serviceAccount) {
  const projectId = serviceAccount?.project_id || env.FIREBASE_PROJECT_ID || '';
  if (!projectId) throw new Error('Firebase project ID is missing from FIREBASE_SERVICE_ACCOUNT and FIREBASE_PROJECT_ID');
  return String(projectId);
}

async function createGoogleAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const privateKey = String(serviceAccount.private_key || '')
    .trim()
    .replace(/^['\"]|['\"]$/g, '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r');
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(unsigned)
  );
  const assertion = `${unsigned}.${base64url(new Uint8Array(signature))}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(`Google OAuth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

function firestoreBase(projectId, collection) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${collection}`;
}

async function getAdminTokens(env, accessToken, projectId) {
  const tokens = [];
  let pageToken = '';
  do {
    const url = new URL(firestoreBase(projectId, 'adminPushTokens'));
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Firestore token read failed: ${JSON.stringify(data)}`);
    for (const document of data.documents || []) {
      const token = document.fields?.token?.stringValue || '';
      const enabled = document.fields?.enabled?.booleanValue !== false;
      if (token && enabled) tokens.push({ name: document.name, token });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  const seen = new Set();
  return tokens.filter(item => !seen.has(item.token) && seen.add(item.token));
}

async function deleteToken(env, accessToken, documentName) {
  const response = await fetch(`https://firestore.googleapis.com/v1/${documentName}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return response.ok || response.status === 404;
}

async function saveTelegramChat(env, accessToken, chat, projectId) {
  const chatId = String(chat.id);
  const url = `${firestoreBase(projectId, 'telegramChats')}/${encodeURIComponent(chatId)}`;
  const body = { fields: {
    chatId: { integerValue: chatId },
    username: { stringValue: String(chat.username || '') },
    firstName: { stringValue: String(chat.first_name || '') },
    lastName: { stringValue: String(chat.last_name || '') },
    updatedAt: { timestampValue: new Date().toISOString() }
  }};
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Firestore Telegram chat save failed: ${JSON.stringify(result)}`);
}

async function getTelegramChats(env, accessToken, projectId) {
  const chats = [];
  let pageToken = '';
  do {
    const url = new URL(firestoreBase(projectId, 'telegramChats'));
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Firestore Telegram chat read failed: ${JSON.stringify(data)}`);
    for (const document of data.documents || []) {
      const id = document.fields?.chatId?.integerValue || document.fields?.chatId?.stringValue || '';
      if (id) chats.push(String(id));
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  if (env.TELEGRAM_CHAT_ID) chats.push(String(env.TELEGRAM_CHAT_ID));
  return [...new Set(chats)];
}

function buildNotification(type, data) {
  const name = data.name || data.customerName || data.customer?.name || 'Customer';
  if (type === 'booking_removed') return { title: '➖ Booking Removed', body: `${name} removed ${data.service || data.serviceName || 'Booking'}` };
  if (type === 'booking') return { title: '➕ New Booking', body: `${name} booked ${data.service || data.serviceName || 'Booking'}` };
  if (type === 'order_removed') return { title: '➖ Order Removed', body: `${name} removed an order` };
  const number = data.orderNumber ? ` #${data.orderNumber}` : '';
  return { title: '➕ New Order', body: `${name} placed a new order${number}` };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function telegramText(type, data) {
  const n = buildNotification(type, data);
  const lines = ['<b>Pet Spot Clinic</b>', `<b>${escapeHtml(n.title)}</b>`, escapeHtml(n.body)];
  if (data.orderNumber) lines.push(`Order: <code>${escapeHtml(data.orderNumber)}</code>`);
  if (data.date) lines.push(`Date: ${escapeHtml(data.date)}`);
  if (data.time) lines.push(`Time: ${escapeHtml(data.time)}`);
  return lines.join('\n');
}

async function telegramApi(env, method, body) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(`Telegram API ${method} failed: ${JSON.stringify(result)}`);
  return result;
}

async function sendToToken(env, accessToken, projectId, token, notification, type) {
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token, notification, data: { type: String(type || 'update') }, webpush: { fcmOptions: { link: SITE_URL } } } })
  });
  const result = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, result };
}

async function registerTelegramChatInBackground(env, chat) {
  try {
    const serviceAccount = getServiceAccount(env);
    const projectId = getFirebaseProjectId(env, serviceAccount);
    const accessToken = await createGoogleAccessToken(serviceAccount);
    await saveTelegramChat(env, accessToken, chat, projectId);
    console.log('Telegram chat registered:', String(chat.id));
  } catch (error) {
    console.error('Telegram chat registration failed:', error);
  }
}

async function handleTelegramUpdate(env, update) {
  const message = update?.message;
  if (!message?.chat?.id) return { ignored: true };
  const chat = message.chat;
  const text = String(message.text || '').trim();
  let reply = '✅ البوت شغال. استخدم /start لربط المحادثة بالإشعارات.';
  if (text.startsWith('/start')) reply = '✅ تم ربط Pet Spot Clinic بنجاح. من الآن هيوصلك إشعار عند إضافة أو حذف Order أو Booking.';
  if (text.startsWith('/id')) reply = `Chat ID: ${chat.id}`;
  await telegramApi(env, 'sendMessage', { chat_id: chat.id, text: reply, disable_web_page_preview: true });
  return { registered: true, chatId: String(chat.id), text };
}

async function sendTelegram(env, accessToken, projectId, type, data) {
  if (!env.TELEGRAM_BOT_TOKEN) return { skipped: true, reason: 'TELEGRAM_BOT_TOKEN is not configured' };
  const chats = await getTelegramChats(env, accessToken, projectId);
  if (!chats.length) return { skipped: true, reason: 'No Telegram chat registered yet; send /start to the bot' };
  const results = [];
  for (const chatId of chats) {
    try {
      await telegramApi(env, 'sendMessage', { chat_id: chatId, text: telegramText(type, data), parse_mode: 'HTML', disable_web_page_preview: true });
      results.push({ chatId: `${chatId.slice(0, 4)}…`, ok: true });
    } catch (error) {
      results.push({ chatId: `${chatId.slice(0, 4)}…`, ok: false, error: error.message });
    }
  }
  return { sent: results.filter(r => r.ok).length, total: results.length, results };
}

async function configureTelegramWebhook(env, webhookUrl) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const setResult = await telegramApi(env, 'setWebhook', {
    url: webhookUrl,
    allowed_updates: ['message'],
    drop_pending_updates: false
  });
  const info = await telegramApi(env, 'getWebhookInfo', {});
  return {
    setWebhookOk: !!setResult.ok,
    url: info.result?.url || webhookUrl,
    pendingUpdateCount: info.result?.pending_update_count || 0,
    lastErrorDate: info.result?.last_error_date || null,
    lastErrorMessage: info.result?.last_error_message || null,
    maxConnections: info.result?.max_connections || null
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    console.log('Request received', {
      requestId,
      method: request.method,
      path: url.pathname,
      userAgent: request.headers.get('user-agent') || ''
    });

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'pet-spot-fcm-telegram', requestId });
    }




    if (request.method === 'GET' && url.pathname === '/notify') {
      return json({ ok: true, service: 'notify', workerVersion: WORKER_VERSION, accepts: 'POST', requestId });
    }

    if (request.method === 'GET' && url.pathname === '/telegram') {
      try {
        const webhookUrl = `${url.origin}/telegram`;
        const telegram = await configureTelegramWebhook(env, webhookUrl);
        return json({ ok: true, telegram, requestId });
      } catch (error) {
        console.error('Telegram webhook setup/status error:', { requestId, error: error.message || String(error) });
        return json({ ok: false, requestId, error: error.message || String(error) }, 500);
      }
    }

    if (request.method === 'POST' && url.pathname === '/telegram') {
      try {
        const payload = await request.json();
        console.log('Telegram webhook update received', {
          requestId,
          updateId: payload?.update_id || null,
          chatId: payload?.message?.chat?.id ? String(payload.message.chat.id) : null,
          text: payload?.message?.text || ''
        });
        const result = await handleTelegramUpdate(env, payload);
        const chat = payload?.message?.chat;
        if (chat?.id) {
          const task = registerTelegramChatInBackground(env, chat);
          if (ctx?.waitUntil) ctx.waitUntil(task);
        }
        return json({ ok: true, requestId, ...result });
      } catch (error) {
        console.error('Telegram webhook error:', { requestId, error: error.message || String(error) });
        return json({ ok: false, requestId, error: error.message || String(error) }, 500);
      }
    }

    if (request.method !== 'POST' || url.pathname !== '/notify') {
      return json({ ok: false, requestId, error: 'Not found' }, 404);
    }

    const secret = env.NOTIFY_SECRET;
    const origin = request.headers.get('Origin') || '';
    const isPetSpotBrowser = origin === 'https://youssef212-osos.github.io';
    if (secret && !isPetSpotBrowser && (request.headers.get('X-PetSpot-Notify-Secret') || '') !== secret) {
      return json({ ok: false, requestId, error: 'Unauthorized' }, 401);
    }

    try {
      const payload = await request.json();
      const type = payload?.type;
      const data = payload?.data || {};
      if (!['booking', 'booking_removed', 'order', 'order_removed'].includes(type)) {
        return json({ ok: false, requestId, error: 'Invalid notification type' }, 400);
      }
      const serviceAccount = getServiceAccount(env);
      const projectId = getFirebaseProjectId(env, serviceAccount);
      const accessToken = await createGoogleAccessToken(serviceAccount);
      let telegram = { skipped: true };
      try {
        telegram = await sendTelegram(env, accessToken, projectId, type, data);
      } catch (error) {
        telegram = { skipped: false, error: error.message };
      }
      const tokens = await getAdminTokens(env, accessToken, projectId);
      const notification = buildNotification(type, data);
      const results = await Promise.all(tokens.map(async item => {
        const result = await sendToToken(env, accessToken, projectId, item.token, notification, type);
        const errorText = JSON.stringify(result.result || {});
        if (!result.ok && (result.status === 404 || errorText.includes('UNREGISTERED'))) {
          await deleteToken(env, accessToken, item.name);
        }
        return { token: `${item.token.slice(0, 8)}…`, ...result };
      }));
      return json({
        ok: true,
        requestId,
        type,
        telegram,
        sent: results.filter(r => r.ok).length,
        total: results.length,
        results,
        workerVersion: WORKER_VERSION
      });
    } catch (error) {
      console.error('Notification error:', { requestId, error: error.message || String(error) });
      return json({ ok: false, requestId, error: error.message || String(error) }, 500);
    }
  }
};
