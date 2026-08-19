// Pet Spot Clinic - Paymob Test Payment Worker
// Uses Paymob Intention API + HMAC-SHA512 webhook.
// Secrets stay in Cloudflare Worker Variables & Secrets.

const CORS = {
  "Access-Control-Allow-Origin": "https://youssef212-osos.github.io",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const SITE_URL = "https://youssef212-osos.github.io/pet-spot-clinic/";
const PAYMOB_BASE_URL = "https://accept.paymob.com";

function json(data, status=200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {"Content-Type":"application/json; charset=utf-8", ...CORS}
  });
}

function fsValue(v) {
  if (v === null || v === undefined) return {nullValue:null};
  if (typeof v === "boolean") return {booleanValue:v};
  if (typeof v === "number") return Number.isInteger(v) ? {integerValue:String(v)} : {doubleValue:v};
  if (typeof v === "string") return {stringValue:v};
  if (Array.isArray(v)) return {arrayValue:{values:v.map(fsValue)}};
  if (typeof v === "object") {
    const fields = {};
    for (const [k,val] of Object.entries(v)) fields[k] = fsValue(val);
    return {mapValue:{fields}};
  }
  return {stringValue:String(v)};
}

function fromFsValue(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ("mapValue" in v) {
    const out = {};
    for (const [k,val] of Object.entries(v.mapValue.fields || {})) out[k] = fromFsValue(val);
    return out;
  }
  return null;
}

function fromFsDoc(doc) {
  const out = {};
  for (const [k,v] of Object.entries(doc?.fields || {})) out[k] = fromFsValue(v);
  return out;
}

function firestoreBase(env, collection) {
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID is missing");
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${collection}`;
}

function base64url(input) {
  const bytes = input instanceof Uint8Array ? input : new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}

function base64ToBytes(value) {
  const clean = String(value || "").replace(/\s+/g,"").replace(/-/g,"+").replace(/_/g,"/");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out = [];
  for (let i=0;i<clean.length;i+=4) {
    const a=alphabet.indexOf(clean[i]), b=alphabet.indexOf(clean[i+1] || "=");
    const c=clean[i+2]==="="?0:alphabet.indexOf(clean[i+2] || "=");
    const d=clean[i+3]==="="?0:alphabet.indexOf(clean[i+3] || "=");
    if (a<0 || b<0 || c<0 || d<0) throw new Error("Invalid base64");
    out.push((a<<2)|(b>>4));
    if (clean[i+2] !== "=") out.push(((b&15)<<4)|(c>>2));
    if (clean[i+3] !== "=") out.push(((c&3)<<6)|d);
  }
  return new Uint8Array(out).buffer;
}

function pemToArrayBuffer(pem) {
  let value = String(pem || "").trim().replace(/^['"]|['"]$/g,"");
  value = value.replace(/\\r\\n/g,"\n").replace(/\\n/g,"\n").replace(/\\r/g,"\r");
  const m = value.match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/);
  if (m) value = m[1];
  return base64ToBytes(value.replace(/[^A-Za-z0-9+/_=-]/g,""));
}

async function createGoogleAccessToken(env) {
  let clientEmail = env.FIREBASE_CLIENT_EMAIL || "";
  let privateKeyPem = env.FIREBASE_PRIVATE_KEY || "";

  // Your existing Pet Spot Worker may store the whole Firebase service account
  // in FIREBASE_SERVICE_ACCOUNT, so this Worker supports that format too.
  if ((!clientEmail || !privateKeyPem) && env.FIREBASE_SERVICE_ACCOUNT) {
    const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    clientEmail = account.client_email || clientEmail;
    privateKeyPem = account.private_key || privateKeyPem;
  }

  if (!clientEmail || !privateKeyPem || !env.FIREBASE_PROJECT_ID)
    throw new Error("Firebase Worker secrets are missing");

  const now = Math.floor(Date.now()/1000);
  const header = base64url(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const claim = base64url(JSON.stringify({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToArrayBuffer(privateKeyPem),
    {name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"}, false, ["sign"]
  );
  const sig = await crypto.subtle.sign(
    {name:"RSASSA-PKCS1-v1_5"}, key, new TextEncoder().encode(unsigned)
  );
  const assertion = `${unsigned}.${base64url(new Uint8Array(sig))}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const d = await r.json().catch(()=>({}));
  if (!r.ok || !d.access_token) throw new Error(`Firebase OAuth failed: ${JSON.stringify(d)}`);
  return d.access_token;
}

async function fsSet(env, token, collection, id, data) {
  const url = `${firestoreBase(env, collection)}/${encodeURIComponent(id)}`;
  const body = JSON.stringify({
    fields:Object.fromEntries(Object.entries(data).map(([k,v])=>[k,fsValue(v)]))
  });
  const r = await fetch(url, {
    method:"PATCH",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body
  });
  const d = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(`Firestore write failed: ${JSON.stringify(d)}`);
  return d;
}

async function fsGet(env, token, collection, id) {
  const r = await fetch(`${firestoreBase(env,collection)}/${encodeURIComponent(id)}`, {
    headers:{Authorization:`Bearer ${token}`}
  });
  if (r.status === 404) return null;
  const d = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(`Firestore read failed: ${JSON.stringify(d)}`);
  return fromFsDoc(d);
}

async function fsPatch(env, token, collection, id, data) {
  const fields = Object.keys(data)
    .map(k=>`updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const url = `${firestoreBase(env,collection)}/${encodeURIComponent(id)}${fields ? "?"+fields : ""}`;
  const body = JSON.stringify({
    fields:Object.fromEntries(Object.entries(data).map(([k,v])=>[k,fsValue(v)]))
  });
  const r = await fetch(url, {
    method:"PATCH",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body
  });
  const d = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(`Firestore patch failed: ${JSON.stringify(d)}`);
  return d;
}

function normalizePhone(v) {
  return String(v || "").replace(/\D/g,"").replace(/^20/,"").replace(/^0/,"");
}

function firstName(full) {
  const s = String(full || "Customer").trim();
  return s.split(/\s+/)[0] || "Customer";
}

function lastName(full) {
  const s = String(full || "").trim().split(/\s+/);
  return s.length > 1 ? s.slice(1).join(" ") : "Customer";
}

function safeItems(items) {
  return (Array.isArray(items) ? items : []).map(x => ({
    name: String(x.name || "Product").slice(0,120),
    amount: Math.round(Number(x.subtotal ?? (Number(x.price||0)*Number(x.quantity||1))) * 100),
    description: String(x.category || "Pet product").slice(0,120),
    quantity: Math.max(1, Number(x.quantity || 1))
  }));
}

function txnHmacString(obj) {
  const source = obj?.source_data || {};
  const order = obj?.order || {};
  const fields = [
    obj?.amount_cents, obj?.created_at, obj?.currency, obj?.error_occured,
    obj?.has_parent_transaction, obj?.id, obj?.integration_id, obj?.is_3d_secure,
    obj?.is_auth, obj?.is_capture, obj?.is_refunded, obj?.is_standalone_payment,
    obj?.is_voided, order?.id, obj?.owner, obj?.pending,
    source?.pan, source?.sub_type, source?.type, obj?.success
  ];
  return fields.map(v => typeof v === "boolean" ? String(v) : String(v ?? "")).join("");
}

async function verifyHmac(obj, received, secret) {
  if (!received || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    {name:"HMAC",hash:"SHA-512"}, false, ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(txnHmacString(obj))
  );
  const computed = [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,"0")).join("");
  return computed.toLowerCase() === String(received).toLowerCase();
}

async function createIntention(request, env, payload) {
  const integrationId = Number(env.PAYMOB_INTEGRATION_ID_CARD);
  if (!Number.isInteger(integrationId) || integrationId <= 0)
    throw new Error("PAYMOB_INTEGRATION_ID_CARD is missing or invalid");

  const total = Number(payload.total);
  if (!Number.isFinite(total) || total <= 0) throw new Error("Invalid order total");

  const amount = Math.round(total * 100);
  const customer = payload.customer || {};
  const ref = String(payload.reference || "").trim();
  if (!ref) throw new Error("Payment reference is missing");

  const firebaseToken = await createGoogleAccessToken(env);

  await fsSet(env, firebaseToken, "paymentIntents", ref, {
    reference: ref,
    customer: {
      name: String(customer.name || ""),
      phone: String(customer.phone || ""),
      ownerPhone: normalizePhone(customer.phone),
      address: String(customer.address || "")
    },
    items: payload.items || [],
    total,
    currency: "EGP",
    paymentMethod: "Visa",
    status: "pending",
    createdAt: new Date().toISOString()
  });

  const u = new URL(request.url);
  const notificationUrl = new URL("/payment/webhook", u.origin).toString();
  const redirectUrl = `${SITE_URL}?payment=complete&ref=${encodeURIComponent(ref)}`;

  const body = {
    amount,
    currency:"EGP",
    payment_methods:[integrationId],
    items:safeItems(payload.items),
    billing_data:{
      first_name:firstName(customer.name),
      last_name:lastName(customer.name),
      email:String(customer.email || "customer@petspot.local"),
      phone_number:String(customer.phone || "01000000000"),
      apartment:"NA", floor:"NA", street:"NA", building:"NA",
      shipping_method:"NA", postal_code:"NA", city:"Cairo", country:"EG", state:"Cairo"
    },
    customer:{
      first_name:firstName(customer.name),
      last_name:lastName(customer.name),
      email:String(customer.email || "customer@petspot.local")
    },
    special_reference:ref,
    notification_url:notificationUrl,
    redirection_url:redirectUrl
  };

  const r = await fetch(`${PAYMOB_BASE_URL}/v1/intention/`, {
    method:"POST",
    headers:{
      Authorization:`Token ${env.PAYMOB_SECRET_KEY}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify(body)
  });
  const d = await r.json().catch(()=>({}));
  if (!r.ok || !d.client_secret)
    throw new Error(`Paymob intention failed (${r.status}): ${JSON.stringify(d)}`);

  const checkoutUrl =
    `${PAYMOB_BASE_URL}/unifiedcheckout/?publicKey=${encodeURIComponent(env.PAYMOB_PUBLIC_KEY)}&clientSecret=${encodeURIComponent(d.client_secret)}`;

  await fsPatch(env, firebaseToken, "paymentIntents", ref, {
    clientSecret:d.client_secret,
    paymobIntentionId:String(d.id || ""),
    checkoutUrl
  });

  return {ok:true, reference:ref, checkoutUrl};
}

async function handleWebhook(request, env) {
  const url = new URL(request.url);
  const received = url.searchParams.get("hmac") || "";
  const body = await request.json().catch(()=>null);
  if (!body) return json({ok:false,error:"Invalid JSON"},400);

  if (!await verifyHmac(body.obj, received, env.PAYMOB_HMAC_SECRET))
    return json({ok:false,error:"Invalid HMAC"},401);

  const tx = body.obj;
  const ref = String(tx?.order?.merchant_order_id || tx?.merchant_order_id || tx?.special_reference || body?.merchant_order_id || "");
  if (!ref) return json({ok:true,ignored:true,reason:"No merchant reference"});

  const firebaseToken = await createGoogleAccessToken(env);
  const pending = await fsGet(env, firebaseToken, "paymentIntents", ref);
  if (!pending) return json({ok:true,ignored:true,reason:"Payment reference not found"});

  const success = tx.success === true && tx.pending !== true && tx.error_occured !== true;
  const paymentStatus = success ? "Paid" : (tx.pending === true ? "Pending" : "Failed");

  await fsPatch(env, firebaseToken, "paymentIntents", ref, {
    status:paymentStatus,
    transactionId:String(tx.id || ""),
    updatedAt:new Date().toISOString()
  });

  if (!success) return json({ok:true,status:paymentStatus});

  const existing = await fsGet(env, firebaseToken, "orders", ref);
  if (existing) return json({ok:true,status:"Paid",alreadyCreated:true});

  const customer = pending.customer || {};
  await fsSet(env, firebaseToken, "orders", ref, {
    orderNumber:ref,
    customer,
    items:pending.items || [],
    total:Number(pending.total || 0),
    status:"Paid",
    paymentMethod:"Visa",
    paymentStatus:"Paid",
    transactionId:String(tx.id || ""),
    createdAt:pending.createdAt || new Date().toISOString(),
    paidAt:new Date().toISOString()
  });

  // Best-effort stock deduction for the test checkout.
  for (const item of (pending.items || [])) {
    if (!item?.productId) continue;
    try {
      const product = await fsGet(env, firebaseToken, "products", String(item.productId));
      if (!product) continue;
      const qty = Math.max(1, Number(item.quantity || 1));
      const newStock = Math.max(0, Number(product.stock || 0) - qty);
      await fsPatch(env, firebaseToken, "products", String(item.productId), {stock:newStock});
    } catch (e) {
      console.error("Visa stock deduction failed", item?.productId, e);
    }
  }

  return json({ok:true,status:"Paid",orderNumber:ref});
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null,{headers:CORS});
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return json({ok:true,service:"pet-spot-paymob",mode:"test",version:"1.0.0"});
      }

      if (request.method === "POST" && url.pathname === "/payment/create") {
        const payload = await request.json();
        return json(await createIntention(request, env, payload));
      }

      if (request.method === "POST" && url.pathname === "/payment/webhook") {
        return await handleWebhook(request, env);
      }

      if (request.method === "GET" && url.pathname === "/payment/status") {
        const ref = String(url.searchParams.get("ref") || "");
        if (!ref) return json({ok:false,error:"Missing ref"},400);
        const firebaseToken = await createGoogleAccessToken(env);
        const record = await fsGet(env, firebaseToken, "paymentIntents", ref);
        if (!record) return json({ok:false,error:"Payment not found"},404);
        return json({
          ok:true,
          reference:ref,
          status:record.status || "pending",
          orderNumber:ref,
          transactionId:record.transactionId || null
        });
      }

      return json({ok:false,error:"Not found"},404);
    } catch (e) {
      console.error(e);
      return json({ok:false,error:e.message || String(e)},500);
    }
  }
};
