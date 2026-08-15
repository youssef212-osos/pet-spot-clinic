// Pet Spot Clinic - Cloudflare Worker FCM + Telegram
// Fixed cancellation notification transport.
// Keep your existing Firebase/Telegram secrets in Cloudflare Worker variables.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-PetSpot-Notify-Secret"
};

const SITE_URL = "https://youssef212-osos.github.io/pet-spot-clinic/";
const WORKER_VERSION = "notify-transport-v6-cancel-final";

function json(data, status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{"Content-Type":"application/json; charset=utf-8",...corsHeaders}
  });
}

function normalizeType(type){
  const t=String(type||"").trim().toLowerCase();

  // Exact names sent by the current index.html
  if(t==="booking_deleted_by_customer") return "booking_deleted_by_customer";
  if(t==="booking_deleted_by_admin") return "booking_deleted_by_admin";
  if(t==="order_deleted_by_customer") return "order_deleted_by_customer";
  if(t==="order_deleted_by_admin") return "order_deleted_by_admin";

  // Compatibility with older cancellation/deletion names
  if(t==="booking_cancelled" || t==="booking_canceled" || t==="booking_deleted" || t==="booking_removed"){
    return "booking_removed";
  }
  if(t==="order_cancelled" || t==="order_canceled" || t==="order_deleted" || t==="order_removed"){
    return "order_removed";
  }

  return t;
}

function buildNotification(type,data){
  const booking=data?.booking||{};
  const order=data?.order||{};
  const name=data?.name||data?.customerName||data?.customer?.name||booking?.name||order?.customer?.name||"Customer";
  const phone=data?.ownerPhone||booking?.ownerPhone||booking?.phone||order?.customer?.ownerPhone||order?.customer?.phone||"";

  if(type==="booking_deleted_by_customer"||type==="booking_deleted_by_admin"||type==="booking_removed"){
    return {title:"🗑️ Booking Cancelled",body:`📱 Mobile: ${phone||"Unknown"}`};
  }
  if(type==="order_deleted_by_customer"||type==="order_deleted_by_admin"||type==="order_removed"){
    return {title:"🗑️ Order Cancelled",body:`📱 Mobile: ${phone||"Unknown"}`};
  }
  if(type==="booking"){
    return {title:"➕ New Booking",body:`${name} booked ${data?.service||data?.serviceName||"Booking"}`};
  }
  if(type==="order"){
    const number=data?.orderNumber?` #${data.orderNumber}`:"";
    return {title:"➕ New Order",body:`${name} placed a new order${number}`};
  }
  return {title:"Pet Spot Update",body:name};
}

function escapeHtml(value){
  return String(value??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function telegramText(type,data){
  const n=buildNotification(type,data);
  const lines=["<b>Pet Spot Clinic</b>",`<b>${escapeHtml(n.title)}</b>`,escapeHtml(n.body)];
  if(data?.orderNumber)lines.push(`Order: <code>${escapeHtml(data.orderNumber)}</code>`);
  if(data?.date)lines.push(`Date: ${escapeHtml(data.date)}`);
  if(data?.time)lines.push(`Time: ${escapeHtml(data.time)}`);
  return lines.join("\n");
}

function base64url(input){
  const bytes=input instanceof Uint8Array?input:new TextEncoder().encode(input);
  let binary="";
  for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}

function base64ToBytes(value){
  const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean=String(value||"").replace(/\s+/g,"").replace(/-/g,"+").replace(/_/g,"/");
  if(!clean)throw new Error("Firebase private key is missing");
  const out=[];
  for(let i=0;i<clean.length;i+=4){
    const c0=clean[i],c1=clean[i+1]||"=",c2=clean[i+2]||"=",c3=clean[i+3]||"=";
    const a=alphabet.indexOf(c0),b=alphabet.indexOf(c1),c=c2==="="?0:alphabet.indexOf(c2),d=c3==="="?0:alphabet.indexOf(c3);
    if(a<0||b<0||c<0||d<0)throw new Error("Firebase private key contains invalid base64 characters");
    out.push(a<<2|b>>4);
    if(c2!=="=")out.push((b&15)<<4|c>>2);
    if(c3!=="=")out.push((c&3)<<6|d);
  }
  return new Uint8Array(out).buffer;
}

function pemToArrayBuffer(pem){
  let value=String(pem??"").trim().replace(/^['"]|['"]$/g,"");
  value=value.replace(/\\r\\n/g,"\n").replace(/\\n/g,"\n").replace(/\\r/g,"\r");
  const match=value.match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/);
  if(match)value=match[1];
  const clean=value.replace(/[^A-Za-z0-9+/_=-]/g,"");
  if(!clean)throw new Error("Firebase private key is missing");
  return base64ToBytes(clean);
}

function getServiceAccount(env){
  if(env.FIREBASE_SERVICE_ACCOUNT){
    const account=JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    return {client_email:account.client_email,private_key:account.private_key,project_id:account.project_id||env.FIREBASE_PROJECT_ID};
  }
  if(env.FIREBASE_CLIENT_EMAIL&&env.FIREBASE_PRIVATE_KEY&&env.FIREBASE_PROJECT_ID){
    return {client_email:env.FIREBASE_CLIENT_EMAIL,private_key:env.FIREBASE_PRIVATE_KEY,project_id:env.FIREBASE_PROJECT_ID};
  }
  throw new Error("Firebase service-account configuration is missing");
}

function getFirebaseProjectId(env,sa){
  const id=sa?.project_id||env.FIREBASE_PROJECT_ID||"";
  if(!id)throw new Error("Firebase project ID is missing");
  return String(id);
}

async function createGoogleAccessToken(sa){
  const now=Math.floor(Date.now()/1000);
  const header=base64url(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const claim=base64url(JSON.stringify({iss:sa.client_email,scope:"https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600}));
  const unsigned=`${header}.${claim}`;
  const privateKey=String(sa.private_key||"").trim().replace(/^['"]|['"]$/g,"").replace(/\\r\\n/g,"\n").replace(/\\n/g,"\n").replace(/\\r/g,"\r");
  const key=await crypto.subtle.importKey("pkcs8",pemToArrayBuffer(privateKey),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
  const signature=await crypto.subtle.sign({name:"RSASSA-PKCS1-v1_5"},key,new TextEncoder().encode(unsigned));
  const assertion=`${unsigned}.${base64url(new Uint8Array(signature))}`;
  const response=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.access_token)throw new Error(`Google OAuth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

function firestoreBase(projectId,collection){
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${collection}`;
}

async function getAdminTokens(env,accessToken,projectId){
  const tokens=[];let pageToken="";
  do{
    const url=new URL(firestoreBase(projectId,"adminPushTokens"));
    url.searchParams.set("pageSize","1000");
    if(pageToken)url.searchParams.set("pageToken",pageToken);
    const response=await fetch(url,{headers:{Authorization:`Bearer ${accessToken}`}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(`Firestore token read failed: ${JSON.stringify(data)}`);
    for(const document of data.documents||[]){
      const token=document.fields?.token?.stringValue||"";
      const enabled=document.fields?.enabled?.booleanValue!==false;
      if(token&&enabled)tokens.push({name:document.name,token});
    }
    pageToken=data.nextPageToken||"";
  }while(pageToken);
  const seen=new Set();
  return tokens.filter(x=>!seen.has(x.token)&&seen.add(x.token));
}

async function deleteToken(accessToken,documentName){
  const response=await fetch(`https://firestore.googleapis.com/v1/${documentName}`,{method:"DELETE",headers:{Authorization:`Bearer ${accessToken}`}});
  return response.ok||response.status===404;
}

async function getTelegramChats(env,accessToken,projectId){
  const chats=[];let pageToken="";
  do{
    const url=new URL(firestoreBase(projectId,"telegramChats"));
    url.searchParams.set("pageSize","1000");
    if(pageToken)url.searchParams.set("pageToken",pageToken);
    const response=await fetch(url,{headers:{Authorization:`Bearer ${accessToken}`}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(`Firestore Telegram chat read failed: ${JSON.stringify(data)}`);
    for(const document of data.documents||[]){
      const id=document.fields?.chatId?.integerValue||document.fields?.chatId?.stringValue||"";
      if(id)chats.push(String(id));
    }
    pageToken=data.nextPageToken||"";
  }while(pageToken);
  if(env.TELEGRAM_CHAT_ID)chats.push(String(env.TELEGRAM_CHAT_ID));
  return [...new Set(chats)];
}

async function telegramApi(env,method,body){
  if(!env.TELEGRAM_BOT_TOKEN)throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok||!result.ok)throw new Error(`Telegram API ${method} failed: ${JSON.stringify(result)}`);
  return result;
}

async function sendTelegram(env,accessToken,projectId,type,data){
  if(!env.TELEGRAM_BOT_TOKEN)return {skipped:true,reason:"TELEGRAM_BOT_TOKEN is not configured"};
  const chats=await getTelegramChats(env,accessToken,projectId);
  if(!chats.length)return {skipped:true,reason:"No Telegram chat registered"};
  const results=[];
  for(const chatId of chats){
    try{
      await telegramApi(env,"sendMessage",{chat_id:chatId,text:telegramText(type,data),parse_mode:"HTML",disable_web_page_preview:true});
      results.push({chatId:`${chatId.slice(0,4)}…`,ok:true});
    }catch(error){
      results.push({chatId:`${chatId.slice(0,4)}…`,ok:false,error:error.message});
    }
  }
  return {sent:results.filter(r=>r.ok).length,total:results.length,results};
}

async function sendToToken(accessToken,projectId,token,notification,type){
  const response=await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,{
    method:"POST",
    headers:{Authorization:`Bearer ${accessToken}`,"Content-Type":"application/json"},
    body:JSON.stringify({message:{token,notification,data:{type:String(type||"update")},webpush:{fcmOptions:{link:SITE_URL}}}})
  });
  const result=await response.json().catch(()=>({}));
  return {ok:response.ok,status:response.status,result};
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    const requestId=crypto.randomUUID();

    if(request.method==="OPTIONS")return new Response(null,{headers:corsHeaders});
    if(request.method==="GET"&&url.pathname==="/")return json({ok:true,service:"pet-spot-fcm-telegram",workerVersion:WORKER_VERSION,requestId});
    if(request.method!=="POST"||url.pathname!=="/notify")return json({ok:false,requestId,error:"Not found"},404);

    try{
      const payload=await request.json();
      const type=normalizeType(payload?.type);
      const data=payload?.data||{};

      const validTypes=[
        "booking","order",
        "booking_deleted_by_customer","booking_deleted_by_admin","booking_removed",
        "order_deleted_by_customer","order_deleted_by_admin","order_removed"
      ];
      const deletionType =
        type.includes("booking") && (type.includes("delete") || type.includes("cancel") || type.includes("remove"))
          ? (type.includes("admin") ? "booking_deleted_by_admin" : "booking_deleted_by_customer")
          : type.includes("order") && (type.includes("delete") || type.includes("cancel") || type.includes("remove"))
            ? (type.includes("admin") ? "order_deleted_by_admin" : "order_deleted_by_customer")
            : null;

      const finalType = deletionType || type;

      if(!validTypes.includes(finalType)){
        return json({
          ok:false,
          requestId,
          error:`Invalid notification type: ${type}`,
          workerVersion:WORKER_VERSION
        },400);
      }

      const serviceAccount=getServiceAccount(env);
      const projectId=getFirebaseProjectId(env,serviceAccount);
      const accessToken=await createGoogleAccessToken(serviceAccount);

      let telegram={skipped:true};
      try{
        telegram=await sendTelegram(env,accessToken,projectId,finalType,data);
      }catch(error){
        telegram={skipped:false,error:error.message};
      }

      const tokens=await getAdminTokens(env,accessToken,projectId);
      const notification=buildNotification(finalType,data);
      const results=await Promise.all(tokens.map(async item=>{
        const result=await sendToToken(accessToken,projectId,item.token,notification,finalType);
        const errorText=JSON.stringify(result.result||{});
        if(!result.ok&&(result.status===404||errorText.includes("UNREGISTERED")))await deleteToken(accessToken,item.name);
        return {token:`${item.token.slice(0,8)}…`,...result};
      }));

      const sent=results.filter(r=>r.ok).length;

      return json({
        ok:true,
        requestId,
        type,
        workerVersion:WORKER_VERSION,
        notification,
        telegram,
        sent,
        total:results.length,
        results
      });
    }catch(error){
      console.error("Notification error",{requestId,error:error.message||String(error)});
      return json({ok:false,requestId,error:error.message||String(error)},500);
    }
  }
};
