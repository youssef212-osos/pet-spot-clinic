const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-PetSpot-Notify-Secret'
};

const SITE_URL = 'https://youssef212-osos.github.io/pet-spot-clinic/';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders }
  });
}

function base64url(input) {
  const bytes = input instanceof Uint8Array ? input : new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToArrayBuffer(pem) {
  const clean = String(pem || '')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!clean) throw new Error('Firebase private key is missing');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
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
  const privateKey = String(serviceAccount.private_key || '').replace(/\\n/g, '\n');
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
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`Google OAuth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

function firestoreBase(env, collection) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents/${collection}`;
}

async function getAdminTokens(env, accessToken) {
  const base = firestoreBase(env, 'adminPushTokens');
  const tokens = [];
  let pageToken = '';
  do {
    const url = new URL(base);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await response.json();
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

async function saveTelegramChat(env, accessToken, chat) {
  const chatId = String(chat.id);
  const url = `${firestoreBase(env, 'telegramChats')}/${encodeURIComponent(chatId)}`;
  const body = {
    fields: {
      chatId: { integerValue: chatId },
      username: { stringValue: String(chat.username || '') },
      firstName: { stringValue: String(chat.first_name || '') },
      lastName: { stringValue: String(chat.last_name || '') },
      updatedAt: { timestampValue: new Date().toISOString() }
    }
  };
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Firestore Telegram chat save failed: ${JSON.stringify(result)}`);
  return result;
}

async function getTelegramChats(env, accessToken) {
  const chats = [];
  let pageToken = '';
  const base = firestoreBase(env, 'telegramChats');
  do {
    const url = new URL(base);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await response.json();
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
  if (type === 'booking_removed') {
    const service = data.service || data.serviceName || 'Booking';
    return { title: '➖ Booking Removed', body: `${name} removed ${service}` };
  }
  if (type === 'booking') {
    const service = data.service || data.serviceName || 'Booking';
    return { title: '➕ New Booking', body: `${name} booked ${service}` };
  }
  if (type === 'order_removed') return { title: '➖ Order Removed', body: `${name} removed an order` };
  const number = data.orderNumber ? ` #${data.orderNumber}` : '';
  return { title: '➕ New Order', body: `${name} placed a new order${number}` };
}

async function sendToToken(env, accessToken, token, notification, type) {
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/messages:send`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        notification,
        data: { type: String(type || 'update') },
        webpush: { fcmOptions: { link: SITE_URL } }
      }
    })
  });
  const result = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, result };
}

function telegramText(type, data) {
  const n = buildNotification(type, data);
  const lines = [`<b>Pet Spot Clinic</b>`, `<b>${n.title}</b>`, n.body];
  if (data.orderNumber) lines.push(`Order: <code>${String(data.orderNumber)}</code>`);
  if (data.date) lines.push(`Date: ${String(data.date)}`);
  if (data.time) lines.push(`Time: ${String(data.time)}`);
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

async function sendTelegram(env, accessToken, type, data) {
  if (!env.TELEGRAM_BOT_TOKEN) return { skipped: true, reason: 'TELEGRAM_BOT_TOKEN is not configured' };
  const chats = await getTelegramChats(env, accessToken);
  if (!chats.length) return { skipped: true, reason: 'No Telegram chat registered yet; send /start to the bot' };
  const results = [];
  for (const chatId of chats) {
    try {
      await telegramApi(env, 'sendMessage', {
        chat_id: chatId,
        text: telegramText(type, data),
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
      results.push({ chatId: `${chatId.slice(0, 4)}…`, ok: true });
    } catch (error) {
      results.push({ chatId: `${chatId.slice(0, 4)}…`, ok: false, error: error.message });
    }
  }
  return {
    sent: results.filter(r => r.ok).length,
    total: results.length,
    results
  };
}

async function registerTelegramChatInBackground(env, chat) {
  try {
    const serviceAccount = getServiceAccount(env);
    const accessToken = await createGoogleAccessToken(serviceAccount);
    await saveTelegramChat(env, accessToken, chat);
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
  let reply;

  if (text.startsWith('/start')) {
    reply = '✅ تم ربط Pet Spot Clinic بنجاح. من الآن هيوصلك إشعار عند إضافة أو حذف Order أو Booking.';
  } else if (text.startsWith('/id')) {
    reply = `Chat ID: ${chat.id}`;
  } else {
    reply = '✅ البوت شغال. استخدم /start لربط المحادثة بالإشعارات.';
  }

  await telegramApi(env, 'sendMessage', {
    chat_id: chat.id,
    text: reply,
    disable_web_page_preview: true
  });

  return { registered: true, chatId: String(chat.id), text };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'pet-spot-fcm-telegram' });
    }

    if (request.method === 'GET' && url.pathname === '/telegram') {
      return json({ ok: true, telegram: 'webhook endpoint ready' });
    }

    if (request.method === 'POST' && url.pathname === '/telegram') {
      try {
        const payload = await request.json();
        const result = await handleTelegramUpdate(env, payload);
        const chat = payload?.message?.chat;
        if (chat?.id) {
          const task = registerTelegramChatInBackground(env, chat);
          if (ctx?.waitUntil) ctx.waitUntil(task);
          else await task;
        }
        return json({ ok: true, ...result });
      } catch (error) {
        console.error('Telegram webhook error:', error);
        return json({ ok: false, error: error.message || String(error) }, 500);
      }
    }

    if (request.method !== 'POST' || url.pathname !== '/notify') {
      return json({ ok: false, error: 'Not found' }, 404);
    }

    const secret = env.NOTIFY_SECRET;
    if (secret && (request.headers.get('X-PetSpot-Notify-Secret') || '') !== secret) {
      return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    try {
      const payload = await request.json();
      const type = payload?.type;
      const data = payload?.data || {};
      if (!['booking', 'booking_removed', 'order', 'order_removed'].includes(type)) {
        return json({ ok: false, error: 'Invalid notification type' }, 400);
      }

      const serviceAccount = getServiceAccount(env);
      const accessToken = await createGoogleAccessToken(serviceAccount);
      const telegram = await sendTelegram(env, accessToken, type, data);
      const tokens = await getAdminTokens(env, accessToken);
      const notification = buildNotification(type, data);
      const results = await Promise.all(tokens.map(async item => {
        const result = await sendToToken(env, accessToken, item.token, notification, type);
        const errorText = JSON.stringify(result.result || {});
        if (!result.ok && (result.status === 404 || errorText.includes('UNREGISTERED'))) {
          await deleteToken(env, accessToken, item.name);
        }
        return { token: `${item.token.slice(0, 8)}…`, ...result };
      }));
      const sent = results.filter(r => r.ok).length;
      return json({
        ok: true,
        type,
        telegram,
        total: tokens.length,
        sent,
        failed: tokens.length - sent,
        results
      });
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: error.message || String(error) }, 500);
    }
  }
};
