from pathlib import Path

path = Path('index.html')
text = path.read_text(encoding='utf-8')

notify_fn = """
const PETSPOT_FCM_WORKER_URL='https://pet-spot-fcm.youssefosama5901.workers.dev/notify';
async function notifyPetSpot(type,data){
  if(!firebaseConfigured)return null;
  const response=await fetch(PETSPOT_FCM_WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,data})});
  const result=await response.json().catch(()=>({}));
  if(!response.ok||result.ok===false)throw new Error(result.error||('FCM worker HTTP '+response.status));
  return result;
}
"""

if 'const PETSPOT_FCM_WORKER_URL=' not in text:
    marker = "function saveCart(){localStorage.setItem('petspotCart',JSON.stringify(cart))}"
    if marker not in text:
        raise SystemExit('Could not find saveCart marker')
    text = text.replace(marker, marker + notify_fn, 1)

old_booking = "      await db.collection('bookings').doc(data.id).set({...data,createdAt});"
new_booking = """      const bookingRecord={...data,createdAt};
      await db.collection('bookings').doc(data.id).set(bookingRecord);
      try{await notifyPetSpot('booking',bookingRecord);}catch(notifyErr){console.error('Booking notification:',notifyErr);}"""
if old_booking in text and "notifyPetSpot('booking'" not in text:
    text = text.replace(old_booking, new_booking, 1)

if "const orderNumber='ORD-'+Date.now().toString().slice(-6);" not in text:
    marker = "  const orderRef=db.collection('orders').doc();\n"
    replacement = marker + "  const orderNumber='ORD-'+Date.now().toString().slice(-6);\n  const orderCreatedAt=new Date().toISOString();\n"
    if marker not in text:
        raise SystemExit('Could not find orderRef marker')
    text = text.replace(marker, replacement, 1)

text = text.replace("orderNumber:'ORD-'+Date.now().toString().slice(-6),customer,items:orderItems,total,status:'New',createdAt:new Date().toISOString()", "orderNumber,customer,items:orderItems,total,status:'New',createdAt:orderCreatedAt", 1)
text = text.replace("id:String(Date.now()),orderNumber:'ORD-'+Date.now().toString().slice(-6),customer,items:orderItems,total,status:'New',createdAt:new Date().toISOString()", "id:String(Date.now()),orderNumber,customer,items:orderItems,total,status:'New',createdAt:orderCreatedAt", 1)

if "notifyPetSpot('order'" not in text:
    marker = "  cart=[];saveCart();closeOrderModal();renderCart();renderProducts();renderAdmin();"
    replacement = "  if(firebaseConfigured){try{await notifyPetSpot('order',{orderNumber,customer,items:orderItems,total,status:'New',createdAt:orderCreatedAt});}catch(notifyErr){console.error('Order notification:',notifyErr);}}\n" + marker
    if marker not in text:
        raise SystemExit('Could not find order success marker')
    text = text.replace(marker, replacement, 1)

path.write_text(text, encoding='utf-8')
print('FCM patch complete')
