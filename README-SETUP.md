# Pet Spot Clinic — Paymob TEST checkout

This package adds a Cash/Visa choice to the existing order modal.

## 1. Cloudflare Worker

Create a NEW Cloudflare Worker, for example:

`pet-spot-payments`

Use `cloudflare-worker-paymob.js` as its code.

Add these variables/secrets to the NEW Worker:

### Text
- `FIREBASE_PROJECT_ID` = `pet-spot-clinic`

### Firebase secret
Your screenshot shows the existing Worker uses `FIREBASE_SERVICE_ACCOUNT`, so you can copy that same Secret to this new Worker.

You can use either:
- `FIREBASE_SERVICE_ACCOUNT` = the same Firebase service-account JSON secret already used by your current FCM Worker

OR:
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`

### Paymob Secrets
- `PAYMOB_SECRET_KEY` = Paymob TEST Secret Key
- `PAYMOB_PUBLIC_KEY` = Paymob TEST Public Key
- `PAYMOB_HMAC_SECRET` = Paymob TEST HMAC Secret

### Text
- `PAYMOB_INTEGRATION_ID_CARD` = your Paymob TEST Card Integration ID

IMPORTANT: the Card Integration ID must be a TEST integration ID matching the TEST keys.

After deploy, copy the Worker URL.

## 2. Website

Upload `paymob-checkout.js` to the GitHub repository.

Open `index.html` and add this immediately before `</body>`:

<script src="paymob-checkout.js"></script>

Also add the two bridge lines from `index-bridge-snippet.html` inside the existing main script, after `cart` and `products` have been declared:

window.petSpotGetCart = () => cart.map(x => ({...x}));
window.petSpotGetProducts = () => products.map(x => ({...x}));

Then open `paymob-checkout.js` and replace:

https://YOUR-PAYMOB-WORKER.workers.dev

with the real URL of your new Worker.

## 3. How the payment works

Cash:
- Existing Cash order flow stays unchanged.

Visa:
- The website sends the cart/customer data to the Worker.
- The Worker creates a Paymob Intention.
- The customer is redirected to Paymob Unified Checkout.
- The order is NOT created as a paid order before payment.
- Paymob POSTs the transaction to `/payment/webhook`.
- The Worker verifies Paymob HMAC-SHA512.
- Only after a verified successful payment is the Firestore order created as `Paid`.
- The Worker then performs a best-effort stock deduction.

The browser redirect is not treated as proof of payment.

## 4. Paymob TEST card

Use Paymob's published sandbox card:

Visa: 4111111111111111
Expiry: 01/39
CVV: 123

Do not use a real card with TEST credentials.

## 5. Webhook

The Worker automatically gives Paymob this callback URL:

`https://YOUR-PAYMOB-WORKER.workers.dev/payment/webhook`

The payment Worker also exposes:

`/payment/create`
`/payment/status`
`/payment/webhook`

Do not put Paymob Secret Key or HMAC Secret in `index.html`.


## Important for the complete Visa flow

The website file is already modified to show Cash + Visa and start Paymob.
Before uploading it, replace:

`https://YOUR-PAYMOB-WORKER.workers.dev`

in `index.html` with the deployed URL of `cloudflare-worker-paymob`.

Do NOT put Paymob Secret Key, HMAC Secret, or Firebase service-account JSON in index.html or GitHub.

The Worker is a separate security boundary. It creates the Paymob Intention, receives the Paymob webhook, verifies HMAC, creates the Paid Firestore order, and deducts stock only after verified payment.
