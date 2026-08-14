const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-PetSpot-Notify-Secret'
};

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
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
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
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(serviceAccount.private_key.replace(/\\n/g, '\n')),
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
  if (!response.ok || !data.access_token) {
    throw new Error(`Google OAuth failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function getAdminTokens(env, accessToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents/adminPushTokens?pageSize=1000`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Firestore token read failed: ${JSON.stringify(data)}`);

  return (data.documents || []).map(document => ({
    name: document.name,
    token: document.fields?.token?.stringValue || '',
    enabled: document.fields?.enabled?.booleanValue !== false
  })).filter(x => x.token && x.enabled);
}

async function deleteToken(env, accessToken, documentName) {
  const response = await fetch(`https://firestore.googleapis.com/v1/${documentName}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return response.ok;
}

function buildNotification(type, data) {
  if (type === 'booking') {
    const name = data.name || data.customerName || data.customer?.name || 'Customer';
    const service = data.service || data.serviceName || 'Booking';
    return {
      title: '📅 New Booking',
      body: `${name} booked ${service}`
    };
  }

  const name = data.customer?.name || data.name || 'Customer';
  const number = data.orderNumber ? ` #${data.orderNumber}` : '';
  return {
    title: '🛍️ New Order',
    body: `${name} placed a new order${number}`
  };
}

async function sendToToken(env, accessToken, token, notification, type) {
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/messages:send`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: {
        token,
        notification,
        data: { type: String(type || 'update') },
        webpush: {
          fcmOptions: { link: 'https://youssef212-osos.github.io/pet-spot-clinic/' }
        }
      }
    })
  });
  const result = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, result };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'pet-spot-fcm' });
    }

    if (request.method !== 'POST' || url.pathname !== '/notify') {
      return json({ ok: false, error: 'Not found' }, 404);
    }

    const secret = env.NOTIFY_SECRET;
    if (secret) {
      const supplied = request.headers.get('X-PetSpot-Notify-Secret') || '';
      if (supplied !== secret) return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    try {
      const payload = await request.json();
      const type = payload?.type;
      const data = payload?.data || {};
      if (type !== 'booking' && type !== 'order') {
        return json({ ok: false, error: 'type must be booking or order' }, 400);
      }

      const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
      const accessToken = await createGoogleAccessToken(serviceAccount);
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
      return json({ ok: true, type, total: tokens.length, sent, failed: tokens.length - sent, results });
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: error.message || String(error) }, 500);
    }
  }
};
