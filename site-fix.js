// Navigation/bootstrap repair for Pet Spot Clinic.
// Deployment refresh marker: 2026-08-22
(function(){
  function boot(){
    try {
      if(typeof window.handlePaymobReturn!=='function') window.handlePaymobReturn=function(){};
      if(typeof window.startPaymobVisa!=='function') window.startPaymobVisa=async function(){throw new Error('PAYMOB_WORKER_URL_NOT_SET')};
      if(typeof window.buildReverse==='function') window.buildReverse();
      if(typeof window.applyLanguage==='function') window.applyLanguage(window.lang||localStorage.getItem('petspot_lang')||'en');
      if(typeof window.renderProducts==='function') window.renderProducts();
      if(typeof window.renderCart==='function') window.renderCart();
      if(typeof window.renderMyActivity==='function') window.renderMyActivity();
      if(typeof window.initSharedStore==='function') window.initSharedStore();
    }catch(e){console.error('Pet Spot bootstrap repair:',e)}
  }
  window.addEventListener('load',function(){setTimeout(boot,50)});
  setTimeout(boot,500);
})();
