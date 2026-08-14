/* Pet Spot Clinic - device-scoped My Orders & Bookings helper
 * This file is intentionally standalone. It never reads other users' records.
 * It expects the existing page to expose Firebase `db` and `firebaseConfigured`.
 */
(function(){
  const KEY='petspot_device_id';
  const deviceId=localStorage.getItem(KEY)||(crypto.randomUUID?crypto.randomUUID():'d-'+Date.now()+'-'+Math.random().toString(36).slice(2));
  localStorage.setItem(KEY,deviceId);
  window.PETSPOT_DEVICE_ID=deviceId;

  function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function render(){
    const b=document.getElementById('petspot-my-bookings');
    const o=document.getElementById('petspot-my-orders');
    if(!b||!o||!window.db||!window.firebaseConfigured)return;
    db.collection('bookings').where('clientId','==',deviceId).onSnapshot(s=>{
      b.innerHTML=s.empty?'<p>No bookings from this device yet.</p>':s.docs.map(d=>{const x=d.data();return `<article class="booking-card"><strong>${escapeHtml(x.service||'Booking')}</strong><div>${escapeHtml(x.date||'')} ${escapeHtml(x.time||'')}</div><div>${escapeHtml(x.petName||'')}</div></article>`}).join('');
    });
    db.collection('orders').where('clientId','==',deviceId).onSnapshot(s=>{
      o.innerHTML=s.empty?'<p>No orders from this device yet.</p>':s.docs.map(d=>{const x=d.data();return `<article class="booking-card"><strong>${escapeHtml(x.orderNumber||'Order')}</strong><div>Status: ${escapeHtml(x.status||'New')}</div><div>Total: ${escapeHtml(x.total||0)} EGP</div></article>`}).join('');
    });
  }
  window.petSpotInitMyActivity=render;
})();
