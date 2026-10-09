require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const express = require('express');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = Number(process.env.JP_ADS_PORT || 3001);
const HOST = '127.0.0.1';
const DATABASE_PATH = path.resolve(process.env.JP_ADS_DB_PATH || path.join(__dirname, 'jp_ads.sqlite'));
const MAX_BANNER_BYTES = 5 * 1024 * 1024;
const CPM_USD_CENTS_PER_10000 = 2500;
const PUBLISHER_MICRO_USD_PER_VALID_IMPRESSION = 1000;
const OWNER_MICRO_USD_PER_VALID_IMPRESSION = 1500;
const MIN_CAMPAIGN_IMPRESSIONS = 1000;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const ALLOWED_AD_FORMATS = new Set(['300x250', '728x90', '160x600']);
const JP_ADS_PUBLIC_URL = (process.env.JP_ADS_PUBLIC_URL || `http://${HOST}:${PORT}`).replace(/\/+$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SESSION_COOKIE_NAME = 'jp_ads_admin_session';
const ADMIN_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_ACCOUNT_ID = process.env.STRIPE_ACCOUNT_ID || '';
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || '';
const BINANCE_SECRET_KEY = process.env.BINANCE_SECRET_KEY || '';
const BINANCE_PAY_MERCHANT_ID = process.env.BINANCE_PAY_MERCHANT_ID || '';
const BINANCE_PAY_SECRET_KEY = BINANCE_SECRET_KEY || process.env.BINANCE_PAY_SECRET_KEY || '';
const BINANCE_PAY_CERT_SERIAL = process.env.BINANCE_PAY_CERT_SERIAL || '';
const BINANCE_PAY_API_URL = (process.env.BINANCE_PAY_API_URL || 'https://bpay.binanceapi.com').replace(/\/+$/, '');
const BTCPAY_URL = (process.env.BTCPAY_URL || '').replace(/\/+$/, '');
const BTCPAY_STORE_ID = process.env.BTCPAY_STORE_ID || '';
const BTCPAY_API_KEY = process.env.BTCPAY_API_KEY || '';
const BTCPAY_WEBHOOK_SECRET = process.env.BTCPAY_WEBHOOK_SECRET || '';
const PAYONEER_CHECKOUT_URL = process.env.PAYONEER_CHECKOUT_URL || '';
const PAYONEER_API_TOKEN = process.env.PAYONEER_API_TOKEN || '';
const PAYONEER_WEBHOOK_SECRET = process.env.PAYONEER_WEBHOOK_SECRET || '';
const EMAIL_MODE = process.env.JP_ADS_EMAIL_MODE || 'simulated';
const OTP_SECRET = process.env.JP_ADS_OTP_SECRET
  || (process.env.NODE_ENV === 'production' ? '' : 'jp-ads-local-development-secret-change-before-deployment');
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = 'jp_ads_session';
const scrypt = promisify(crypto.scrypt);
const db = new sqlite3.Database(DATABASE_PATH);
let transactionQueue = Promise.resolve();
const adminLoginAttempts = new Map();

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('JP_ADS_PORT debe ser un puerto válido.');
}
if (!['simulated', 'smtp'].includes(EMAIL_MODE)) {
  throw new Error('JP_ADS_EMAIL_MODE debe ser simulated o smtp.');
}
if (process.env.NODE_ENV === 'production' && EMAIL_MODE !== 'smtp') {
  throw new Error('En producción configura JP_ADS_EMAIL_MODE=smtp para no exponer códigos de verificación.');
}
if (
  EMAIL_MODE === 'simulated'
  && !['127.0.0.1', 'localhost', '::1'].includes(HOST)
) {
  throw new Error('El modo de correo simulado solo puede escuchar en localhost.');
}
if (!OTP_SECRET || Buffer.byteLength(OTP_SECRET) < 32) {
  throw new Error('Configura JP_ADS_OTP_SECRET con al menos 32 bytes.');
}
if (process.env.NODE_ENV === 'production' && !isHttpsUrl(JP_ADS_PUBLIC_URL)) {
  throw new Error('En producción JP_ADS_PUBLIC_URL debe ser una URL HTTPS pública.');
}
if (BINANCE_PAY_SECRET_KEY && !isHttpsUrl(BINANCE_PAY_API_URL)) {
  throw new Error('BINANCE_PAY_API_URL debe usar HTTPS.');
}
if (BTCPAY_API_KEY && !isHttpsUrl(BTCPAY_URL)) {
  throw new Error('BTCPAY_URL debe usar HTTPS para proteger la API key.');
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        return reject(error);
      }
      return resolve(rows);
    });
  });
}

function calculateCampaignPricing(impressions) {
  const discountPercent = 0;
  const cpmUsdCents = CPM_USD_CENTS_PER_10000;
  const totalUsdCents = Number(
    (BigInt(impressions) * BigInt(cpmUsdCents) + 5000n) / 10000n
  );
  return { cpmUsdCents, totalUsdCents, discountPercent };
}

const mailer = EMAIL_MODE === 'smtp'
  ? createSmtpTransport()
  : nodemailer.createTransport({ jsonTransport: true });

app.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const token = getCookieValue(req.headers.cookie, SESSION_COOKIE_NAME);
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    try {
      const session = await findAdvertiserSession(token);
      if (session) {
        return res.redirect(303, '/panel_anunciante.html');
      }
    } catch (error) {
      console.error('[JP-Ads] No se pudo comprobar la sesión en la raíz:', error.message);
      return res.status(500).send('No se pudo comprobar la sesión. Inténtalo nuevamente.');
    }
  }
  return res.sendFile(path.join(__dirname, 'public', 'registro.html'));
});

app.get('/panel_anunciante.html', requireAdvertiserSession, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'panel_anunciante.html'));
});

app.get('/panel_editor.html', requireAdvertiserSession, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'panel_editor.html'));
});

app.get('/registro.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'registro.html'));
});

app.get('/logo_jp.png', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.type('png').sendFile(path.join(__dirname, 'public', 'logo_jp.png'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders(res, filePath) {
    if (path.basename(filePath).toLowerCase() === 'panel_anunciante.html') {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET || !verifyStripeSignature(req.headers['stripe-signature'], req.body, STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: 'Firma de webhook de Stripe inválida o no configurada.' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'El evento de Stripe no contiene JSON válido.' });
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data && event.data.object;
    if (session && session.payment_status === 'paid') {
      const paymentId = session.metadata && session.metadata.jp_ads_payment_id;
      const paidUsdCents = Number(session.amount_total);
      if (!paymentId || !Number.isSafeInteger(paidUsdCents)) {
        return res.status(400).json({ error: 'El evento no contiene los metadatos de pago requeridos.' });
      }
      try {
        const activated = await activateCampaignForPayment({
          paymentId,
          provider: 'stripe',
          externalPaymentId: session.payment_intent || session.id,
          paidUsdCents,
          currency: (session.currency || '').toUpperCase(),
          eventId: event.id,
          rawEvent: req.body.toString('utf8'),
        });
        if (!activated) {
          return res.status(409).json({ error: 'El monto o la moneda del pago no coincide con la orden.' });
        }
      } catch (error) {
        console.error('[JP-Ads] No se pudo aplicar el webhook de Stripe:', error.message);
        return res.status(500).json({ error: 'No se pudo aplicar el evento de pago.' });
      }
    }
  }

  return res.json({ received: true });
});

app.post('/api/webhooks/binance-pay', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!BINANCE_PAY_SECRET_KEY || !verifyBinanceSignature(req.headers, req.body, BINANCE_PAY_SECRET_KEY)) {
    return res.status(400).json({ error: 'Firma de webhook de Binance Pay inválida o no configurada.' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'El evento de Binance Pay no contiene JSON válido.' });
  }

  if (event.bizStatus === 'PAY_SUCCESS') {
    const data = event.data || {};
    let paymentId = typeof data.passThroughInfo === 'string' && /^[0-9a-f-]{36}$/i.test(data.passThroughInfo)
      ? data.passThroughInfo
      : null;
    const paidUsdCents = toUsdCents(data.totalFee);
    if (paidUsdCents === null || typeof data.currency !== 'string' || typeof data.merchantTradeNo !== 'string') {
      return res.status(400).json({ error: 'El evento no contiene los datos de pago requeridos.' });
    }
    try {
      if (paymentId && paymentId.replace(/-/g, '') !== data.merchantTradeNo) {
        return res.status(400).json({ error: 'La referencia comercial no coincide con el pago.' });
      }
      if (!paymentId) {
        const payment = await get(
          "SELECT id FROM pagos_publicitarios WHERE proveedor = 'binance' AND replace(id, '-', '') = ?",
          [data.merchantTradeNo]
        );
        paymentId = payment && payment.id;
      }
      if (!paymentId) {
        return res.status(404).json({ error: 'No se encontró la orden de Binance Pay.' });
      }
      const activated = await activateCampaignForPayment({
        paymentId,
        provider: 'binance',
        externalPaymentId: data.transactionId || data.prepayId || paymentId,
        paidUsdCents,
        currency: data.currency.toUpperCase(),
        eventId: data.merchantTradeNo,
        rawEvent: req.body.toString('utf8'),
      });
      if (!activated) {
        return res.status(409).json({ error: 'El monto o la moneda del pago no coincide con la orden.' });
      }
    } catch (error) {
      console.error('[JP-Ads] No se pudo aplicar el webhook de Binance Pay:', error.message);
      return res.status(500).json({ error: 'No se pudo aplicar el evento de pago.' });
    }
  }

  return res.json({ returnCode: 'SUCCESS', returnMessage: null });
});

app.post('/api/webhooks/btcpay', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!BTCPAY_WEBHOOK_SECRET || !verifyBtcpaySignature(req.headers['btcpay-sig'], req.body, BTCPAY_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: 'Firma de webhook de BTCPay inválida o no configurada.' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'El evento de BTCPay no contiene JSON válido.' });
  }
  if (event.type !== 'InvoiceSettled') {
    return res.json({ received: true });
  }
  if (
    typeof event.invoiceId !== 'string'
    || typeof event.storeId !== 'string'
    || event.storeId !== BTCPAY_STORE_ID
  ) {
    return res.status(400).json({ error: 'El evento no corresponde a una factura o tienda BTCPay válida.' });
  }

  try {
    const response = await fetch(
      `${BTCPAY_URL}/api/v1/stores/${encodeURIComponent(BTCPAY_STORE_ID)}/invoices/${encodeURIComponent(event.invoiceId)}`,
      {
        headers: { Authorization: `token ${BTCPAY_API_KEY}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      }
    );
    const invoice = await response.json();
    if (!response.ok) {
      throw new Error(`BTCPay no pudo verificar la factura (HTTP ${response.status}).`);
    }
    const paymentId = invoice.metadata && invoice.metadata.orderId;
    const paidUsdCents = toUsdCents(invoice.amount);
    if (
      invoice.id !== event.invoiceId
      || invoice.storeId !== BTCPAY_STORE_ID
      || invoice.status !== 'Settled'
      || typeof paymentId !== 'string'
      || paidUsdCents === null
      || typeof invoice.currency !== 'string'
    ) {
      return res.status(409).json({ error: 'La factura de BTCPay no coincide con una orden liquidada válida.' });
    }

    const activated = await activateCampaignForPayment({
      paymentId,
      provider: 'btcpay',
      externalPaymentId: invoice.id,
      paidUsdCents,
      currency: invoice.currency.toUpperCase(),
      eventId: typeof event.deliveryId === 'string' ? event.deliveryId : `${event.invoiceId}:${event.type}`,
      rawEvent: req.body.toString('utf8'),
    });
    if (!activated) {
      return res.status(409).json({ error: 'El importe o la moneda de la factura no coincide con la orden.' });
    }
  } catch (error) {
    console.error('[JP-Ads] No se pudo verificar el webhook de BTCPay:', error.message);
    return res.status(502).json({ error: 'No se pudo verificar la factura con BTCPay.' });
  }

  return res.json({ received: true });
});

app.post('/api/webhooks/payoneer', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!PAYONEER_WEBHOOK_SECRET || !verifyGenericHmacSignature(req.headers['x-jp-ads-signature'], req.body, PAYONEER_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: 'Firma de webhook de Payoneer inválida o no configurada.' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'El evento de Payoneer no contiene JSON válido.' });
  }

  if (event.status === 'completed' || event.status === 'paid') {
    const paidUsdCents = toUsdCents(event.amount);
    if (!event.paymentId || paidUsdCents === null || typeof event.currency !== 'string') {
      return res.status(400).json({ error: 'El evento no contiene los datos de pago requeridos.' });
    }
    try {
      const activated = await activateCampaignForPayment({
        paymentId: event.paymentId,
        provider: 'payoneer',
        externalPaymentId: event.transactionId || event.paymentId,
        paidUsdCents,
        currency: event.currency.toUpperCase(),
        eventId: event.eventId || event.paymentId,
        rawEvent: req.body.toString('utf8'),
      });
      if (!activated) {
        return res.status(409).json({ error: 'El monto o la moneda del pago no coincide con la orden.' });
      }
    } catch (error) {
      console.error('[JP-Ads] No se pudo aplicar el webhook de Payoneer:', error.message);
      return res.status(500).json({ error: 'No se pudo aplicar el evento de pago.' });
    }
  }

  return res.json({ received: true });
});

app.use(express.json({ limit: '8mb', strict: true }));
app.use('/api/auth', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api/payments', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'JP-Ads' });
});

app.post('/api/admin/login', requireSameOrigin, async (req, res) => {
  if (Buffer.byteLength(ADMIN_PASSWORD) < 16) {
    return res.status(503).json({ error: 'Configura ADMIN_PASSWORD con al menos 16 caracteres en el archivo .env raíz.' });
  }
  const password = req.body && req.body.password;
  const address = req.ip;
  const now = Date.now();
  const attempts = adminLoginAttempts.get(address);
  if (attempts && attempts.count >= 5 && now - attempts.startedAt < 15 * 60 * 1000) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos antes de volver a intentar.' });
  }
  if (!constantTimeTextEquals(password, ADMIN_PASSWORD)) {
    const current = attempts && now - attempts.startedAt < 15 * 60 * 1000
      ? attempts
      : { count: 0, startedAt: now };
    current.count += 1;
    adminLoginAttempts.set(address, current);
    return res.status(401).json({ error: 'La clave administrativa no es válida.' });
  }

  adminLoginAttempts.delete(address);
  try {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = now + ADMIN_SESSION_TTL_MS;
    await enqueueTransaction(async () => {
      await run('DELETE FROM admin_sessions WHERE expires_at <= ?', [now]);
      await run(
        'INSERT INTO admin_sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)',
        [hashSessionToken(token), expiresAt, new Date(now).toISOString()]
      );
    });
    setAdminSessionCookie(res, token);
    return res.json({ authenticated: true, expiresAt: new Date(expiresAt).toISOString() });
  } catch (error) {
    console.error('[JP-Ads] No se pudo crear la sesión de administración:', error.message);
    return res.status(500).json({ error: 'No se pudo iniciar la sesión administrativa.' });
  }
});

app.get('/api/admin/me', requireAdminSession, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ authenticated: true });
});

app.post('/api/admin/logout', requireAdminSession, requireSameOrigin, async (req, res) => {
  try {
    await run('DELETE FROM admin_sessions WHERE token_hash = ?', [req.auth.sessionHash]);
    clearAdminSessionCookie(res);
    return res.json({ authenticated: false });
  } catch (error) {
    console.error('[JP-Ads] No se pudo cerrar la sesión administrativa:', error.message);
    return res.status(500).json({ error: 'No se pudo cerrar la sesión administrativa.' });
  }
});

app.get('/api/admin/overview', requireAdminSession, async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const totals = await get(
      `SELECT COALESCE(SUM(CASE WHEN estado = 'completado' THEN monto_usd_centavos ELSE 0 END), 0) AS paid_usd_cents,
        COUNT(CASE WHEN estado = 'completado' THEN 1 END) AS completed_transactions
       FROM transacciones`
    );
    const editorTotals = await get(
      `SELECT COUNT(*) AS valid_impressions,
        COALESCE(SUM(editor_microusd), 0) AS editor_microusd,
        COALESCE(SUM(owner_microusd), 0) AS owner_microusd
       FROM publisher_impressions`
    );
    const transactions = await all(
      `SELECT pago_id, usuario, monto_usd_centavos, metodo, pagado_en, estado
       FROM transacciones
       ORDER BY COALESCE(pagado_en, fecha) DESC
       LIMIT 100`
    );
    const campaigns = await all(
      `SELECT id, anunciante, owner_email, titulo, url_destino, banner_nombre, banner_mime,
        impresiones_compradas, impresiones_consumidas, costo_total_usd_centavos, estado,
        estado_revision, creada_en, activada_en
       FROM campanas_publicitarias
       ORDER BY creada_en DESC`
    );
    return res.json({
      totalPaidUsdCents: totals.paid_usd_cents,
      completedTransactions: totals.completed_transactions,
      validImpressions: editorTotals.valid_impressions,
      editorEarningsMicroUsd: editorTotals.editor_microusd,
      ownerCommissionMicroUsd: editorTotals.owner_microusd,
      transactions,
      campaigns: campaigns.map((campaign) => ({
        id: campaign.id,
        advertiser: campaign.anunciante,
        ownerEmail: campaign.owner_email,
        title: campaign.titulo,
        destinationUrl: campaign.url_destino,
        bannerName: campaign.banner_nombre,
        impressionsPurchased: campaign.impresiones_compradas,
        impressionsConsumed: campaign.impresiones_consumidas,
        amountUsdCents: campaign.costo_total_usd_centavos,
        paymentStatus: campaign.estado,
        moderationStatus: campaign.estado_revision,
        createdAt: campaign.creada_en,
        activatedAt: campaign.activada_en,
        bannerUrl: `/api/admin/campaigns/${campaign.id}/banner`,
      })),
    });
  } catch (error) {
    console.error('[JP-Ads] No se pudo cargar el panel administrativo:', error.message);
    return res.status(500).json({ error: 'No se pudo cargar el panel administrativo.' });
  }
});

app.get('/api/admin/campaigns/:campaignId/banner', requireAdminSession, async (req, res) => {
  if (!/^[1-9]\d*$/.test(req.params.campaignId)) {
    return res.status(400).json({ error: 'El identificador de campaña no es válido.' });
  }
  try {
    const campaign = await get(
      'SELECT banner_mime, banner_datos FROM campanas_publicitarias WHERE id = ?',
      [Number(req.params.campaignId)]
    );
    if (!campaign) {
      return res.status(404).json({ error: 'No se encontró el banner de la campaña.' });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.type(campaign.banner_mime).send(campaign.banner_datos);
  } catch (error) {
    console.error('[JP-Ads] No se pudo servir el banner al administrador:', error.message);
    return res.status(500).json({ error: 'No se pudo cargar el banner.' });
  }
});

app.post('/api/admin/campaigns/:campaignId/moderation', requireAdminSession, requireSameOrigin, async (req, res) => {
  if (!/^[1-9]\d*$/.test(req.params.campaignId)) {
    return res.status(400).json({ error: 'El identificador de campaña no es válido.' });
  }
  const moderationStatus = {
    approve: 'aprobada',
    pause: 'pausada',
    delete: 'eliminada',
  }[req.body && req.body.action];
  if (!moderationStatus) {
    return res.status(400).json({ error: 'La acción de moderación no es válida.' });
  }
  try {
    const updated = await run(
      'UPDATE campanas_publicitarias SET estado_revision = ? WHERE id = ?',
      [moderationStatus, Number(req.params.campaignId)]
    );
    if (updated.changes !== 1) {
      return res.status(404).json({ error: 'No se encontró la campaña.' });
    }
    return res.json({ campaignId: Number(req.params.campaignId), moderationStatus });
  } catch (error) {
    console.error('[JP-Ads] No se pudo moderar la campaña:', error.message);
    return res.status(500).json({ error: 'No se pudo actualizar el estado de la campaña.' });
  }
});

app.get('/publisher.js', (req, res) => {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.send(
    '(function(){var s=document.currentScript;if(!s)return;var id=s.dataset.adUnit,w=s.dataset.width,h=s.dataset.height;if(!/^[A-Za-z0-9_-]{24}$/.test(id||""))return;var f=document.createElement("iframe");f.src=new URL("/ad-unit/"+encodeURIComponent(id),s.src).href;f.width=w;f.height=h;f.loading="lazy";f.title="JP-Ads";f.referrerPolicy="strict-origin-when-cross-origin";f.setAttribute("sandbox","allow-scripts allow-popups allow-popups-to-escape-sandbox");f.style.cssText="display:block;border:0;max-width:100%;overflow:hidden";s.parentNode.insertBefore(f,s.nextSibling)})();'
  );
});

app.get('/ad-unit/:unitId', async (req, res) => {
  const unitId = req.params.unitId;
  if (!/^[A-Za-z0-9_-]{24}$/.test(unitId)) {
    return res.status(404).send('Ad unit no encontrado.');
  }
  try {
    const unit = await get(
      `SELECT u.id, u.formato, p.owner_email, p.site_origin
       FROM publisher_ad_units u
       JOIN publisher_accounts p ON p.owner_email = u.owner_email
       WHERE u.id = ?`,
      [unitId]
    );
    if (!unit) {
      return res.status(404).send('Ad unit no encontrado.');
    }
    const referer = req.get('referer');
    let refererOrigin;
    try {
      refererOrigin = new URL(referer).origin;
    } catch {
      return res.status(403).send('El sitio editor no coincide con la configuración.');
    }
    if (refererOrigin !== unit.site_origin) {
      return res.status(403).send('El sitio editor no coincide con la configuración.');
    }

    const campaign = await servePublisherImpression(unit, req.ip);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors *; base-uri 'none'");
    if (!campaign) {
      return res.type('html').send('<!doctype html><html><body style="margin:0"></body></html>');
    }
    const [width, height] = unit.formato.split('x').map(Number);
    return res.type('html').send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}a,img{display:block;width:100%;height:100%}img{object-fit:contain}</style></head><body><a href="${escapeHtml(campaign.url_destino)}" target="_blank" rel="noopener noreferrer"><img src="data:${campaign.banner_mime};base64,${Buffer.from(campaign.banner_datos).toString('base64')}" alt="${escapeHtml(campaign.titulo)}" width="${width}" height="${height}"></a></body></html>`
    );
  } catch (error) {
    console.error('[JP-Ads] No se pudo servir una impresión editorial:', error.message);
    return res.status(500).send('No se pudo servir el anuncio.');
  }
});

app.get('/api/publishers/profile', requireAdvertiserSession, async (req, res) => {
  try {
    const profile = await get(
      'SELECT public_id, site_origin, created_at FROM publisher_accounts WHERE owner_email = ?',
      [req.auth.email]
    );
    return res.json({ profile: profile || null });
  } catch (error) {
    console.error('[JP-Ads] No se pudo consultar el perfil editorial:', error.message);
    return res.status(500).json({ error: 'No se pudo consultar el perfil editorial.' });
  }
});

app.post('/api/publishers/profile', requireAdvertiserSession, requireSameOrigin, async (req, res) => {
  const submittedUrl = req.body && req.body.siteUrl;
  let siteUrl;
  try {
    siteUrl = new URL(submittedUrl);
  } catch {
    return res.status(400).json({ error: 'Introduce la URL del sitio editor.' });
  }
  if (
    !['http:', 'https:'].includes(siteUrl.protocol)
    || siteUrl.username
    || siteUrl.password
    || (siteUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(siteUrl.hostname))
  ) {
    return res.status(400).json({ error: 'El sitio debe usar HTTPS (HTTP solo se permite en localhost).' });
  }
  try {
    const existing = await get('SELECT public_id, site_origin FROM publisher_accounts WHERE owner_email = ?', [req.auth.email]);
    if (existing) {
      return res.status(409).json({ error: 'Esta cuenta ya tiene un perfil editorial.', profile: existing });
    }
    const profile = {
      publicId: crypto.randomBytes(18).toString('base64url'),
      siteOrigin: siteUrl.origin,
    };
    await run(
      'INSERT INTO publisher_accounts (owner_email, public_id, site_origin, created_at) VALUES (?, ?, ?, ?)',
      [req.auth.email, profile.publicId, profile.siteOrigin, new Date().toISOString()]
    );
    return res.status(201).json({ profile });
  } catch (error) {
    console.error('[JP-Ads] No se pudo registrar el perfil editorial:', error.message);
    return res.status(500).json({ error: 'No se pudo registrar el perfil editorial.' });
  }
});

app.post('/api/publishers/ad-units', requireAdvertiserSession, requireSameOrigin, async (req, res) => {
  const format = req.body && req.body.format;
  if (!ALLOWED_AD_FORMATS.has(format)) {
    return res.status(400).json({ error: 'Selecciona un formato de anuncio válido.' });
  }
  try {
    const profile = await get('SELECT owner_email FROM publisher_accounts WHERE owner_email = ?', [req.auth.email]);
    if (!profile) {
      return res.status(409).json({ error: 'Registra primero el sitio editor.' });
    }
    const adUnit = { id: crypto.randomBytes(18).toString('base64url'), format };
    await run(
      'INSERT INTO publisher_ad_units (id, owner_email, formato, created_at) VALUES (?, ?, ?, ?)',
      [adUnit.id, req.auth.email, format, new Date().toISOString()]
    );
    return res.status(201).json({
      ...adUnit,
      embedCode: createPublisherEmbedCode(adUnit.id, format),
    });
  } catch (error) {
    console.error('[JP-Ads] No se pudo crear el bloque editorial:', error.message);
    return res.status(500).json({ error: 'No se pudo crear el bloque editorial.' });
  }
});

app.get('/api/publishers/dashboard', requireAdvertiserSession, async (req, res) => {
  try {
    const profile = await get(
      'SELECT public_id, site_origin, created_at FROM publisher_accounts WHERE owner_email = ?',
      [req.auth.email]
    );
    if (!profile) {
      return res.json({ profile: null, validImpressions: 0, earningsMicroUsd: 0, adUnits: [] });
    }
    const totals = await get(
      `SELECT COUNT(*) AS valid_impressions, COALESCE(SUM(editor_microusd), 0) AS earnings_microusd
       FROM publisher_impressions WHERE owner_email = ?`,
      [req.auth.email]
    );
    const units = await all(
      'SELECT id, formato, created_at FROM publisher_ad_units WHERE owner_email = ? ORDER BY created_at DESC',
      [req.auth.email]
    );
    return res.json({
      profile,
      validImpressions: totals.valid_impressions,
      earningsMicroUsd: totals.earnings_microusd,
      adUnits: units.map((unit) => ({
        id: unit.id,
        format: unit.formato,
        createdAt: unit.created_at,
        embedCode: createPublisherEmbedCode(unit.id, unit.formato),
      })),
    });
  } catch (error) {
    console.error('[JP-Ads] No se pudo cargar el panel editorial:', error.message);
    return res.status(500).json({ error: 'No se pudo cargar el panel editorial.' });
  }
});

app.post('/api/auth/login', requireSameOrigin, async (req, res) => {
  const input = req.body;
  const email = input && typeof input.email === 'string' ? normalizeEmail(input.email) : '';
  const password = input && input.password;
  if (
    !isValidEmail(email)
    || typeof password !== 'string'
    || password.length < 8
    || password.length > 128
    || Buffer.byteLength(password) > 1024
  ) {
    return res.status(400).json({ error: 'Introduce un correo y una contraseña válidos.' });
  }

  try {
    const account = await get(
      'SELECT email, password_hash, password_salt, email_verificado_en FROM cuentas_anunciantes WHERE email = ?',
      [email]
    );
    if (!account) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    }
    if (!account.email_verificado_en) {
      return res.status(403).json({ error: 'Verifica tu correo electrónico antes de iniciar sesión.' });
    }

    const passwordHash = await scrypt(password, account.password_salt, 64);
    const expectedHash = Buffer.from(account.password_hash);
    if (passwordHash.length !== expectedHash.length || !crypto.timingSafeEqual(passwordHash, expectedHash)) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    }

    await issueAdvertiserSession(account.email, res);
    return res.json({ message: 'Sesión iniciada.', email: account.email });
  } catch (error) {
    console.error('[JP-Ads] No se pudo iniciar sesión:', error.message);
    return res.status(500).json({ error: 'No se pudo iniciar sesión. Inténtalo de nuevo.' });
  }
});

app.get('/api/auth/me', requireAdvertiserSession, (req, res) => {
  res.json({ email: req.auth.email });
});

app.post('/api/auth/logout', requireAdvertiserSession, requireSameOrigin, async (req, res) => {
  try {
    await run('DELETE FROM advertiser_sessions WHERE token_hash = ?', [req.auth.sessionHash]);
    clearAdvertiserSessionCookie(res);
    return res.json({ message: 'Sesión cerrada.' });
  } catch (error) {
    console.error('[JP-Ads] No se pudo cerrar sesión:', error.message);
    return res.status(500).json({ error: 'No se pudo cerrar la sesión.' });
  }
});

app.post('/api/auth/register', requireSameOrigin, async (req, res) => {
  const input = req.body;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return res.status(400).json({ error: 'El cuerpo debe ser un objeto JSON válido.' });
  }

  const email = typeof input.email === 'string' ? normalizeEmail(input.email) : '';
  const password = input.password;
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Introduce una dirección de correo válida.' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128 || Buffer.byteLength(password) > 1024) {
    return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 128 caracteres.' });
  }

  try {
    const salt = crypto.randomBytes(16);
    const passwordHash = await scrypt(password, salt, 64);
    const code = createVerificationCode();
    const now = Date.now();
    const expiresAt = now + OTP_TTL_MS;
    const codeHash = hashVerificationCode(email, code);

    const result = await enqueueTransaction(async () => {
      const account = await get('SELECT email_verificado_en FROM cuentas_anunciantes WHERE email = ?', [email]);
      if (account && account.email_verificado_en) {
        return { status: 'exists' };
      }

      const existingCode = await get('SELECT enviado_en FROM codigos_verificacion WHERE email = ?', [email]);
      if (existingCode && now - existingCode.enviado_en < OTP_RESEND_COOLDOWN_MS) {
        return { status: 'cooldown' };
      }

      await run(
        `INSERT INTO cuentas_anunciantes (email, password_hash, password_salt, creada_en)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           password_hash = excluded.password_hash,
           password_salt = excluded.password_salt`,
        [email, passwordHash, salt, new Date(now).toISOString()]
      );
      await run(
        `INSERT INTO codigos_verificacion (email, codigo_hash, expira_en, enviado_en, intentos)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(email) DO UPDATE SET
           codigo_hash = excluded.codigo_hash,
           expira_en = excluded.expira_en,
           enviado_en = excluded.enviado_en,
           intentos = 0`,
        [email, codeHash, expiresAt, now]
      );
      return { status: 'sent' };
    });

    if (result.status === 'exists') {
      return res.status(409).json({ error: 'Ya existe una cuenta verificada con este correo.' });
    }
    if (result.status === 'cooldown') {
      return res.status(429).json({ error: 'Ya enviamos un código recientemente. Espera antes de solicitar otro.' });
    }

    try {
      await sendVerificationEmail(email, code);
    } catch (error) {
      await enqueueTransaction(() => run('DELETE FROM codigos_verificacion WHERE email = ? AND codigo_hash = ?', [email, codeHash]));
      console.error('[JP-Ads] No se pudo enviar el código de verificación:', error.message);
      return res.status(503).json({ error: 'No se pudo enviar el correo de verificación. Inténtalo más tarde.' });
    }

    const response = {
      message: 'Enviamos un código de seguridad de 6 dígitos a tu correo electrónico.',
      expiresInSeconds: OTP_TTL_MS / 1000,
      resendAfterSeconds: OTP_RESEND_COOLDOWN_MS / 1000,
    };
    if (EMAIL_MODE === 'simulated') {
      response.simulated = true;
      response.developmentCode = code;
    }
    return res.status(202).json(response);
  } catch (error) {
    console.error('[JP-Ads] No se pudo iniciar el registro:', error.message);
    return res.status(500).json({ error: 'No se pudo iniciar el registro. Inténtalo de nuevo.' });
  }
});

app.post('/api/auth/verify-email', requireSameOrigin, async (req, res) => {
  const input = req.body;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return res.status(400).json({ error: 'El cuerpo debe ser un objeto JSON válido.' });
  }

  const email = typeof input.email === 'string' ? normalizeEmail(input.email) : '';
  const code = input.code;
  if (!isValidEmail(email) || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Introduce un correo válido y un código de 6 dígitos.' });
  }

  try {
    const result = await enqueueTransaction(async () => {
      const account = await get('SELECT email_verificado_en FROM cuentas_anunciantes WHERE email = ?', [email]);
      if (!account) {
        return { status: 'not_found' };
      }
      if (account.email_verificado_en) {
        return { status: 'verified' };
      }

      const verification = await get(
        'SELECT codigo_hash, expira_en, intentos FROM codigos_verificacion WHERE email = ?',
        [email]
      );
      if (!verification) {
        return { status: 'missing' };
      }
      if (verification.expira_en <= Date.now()) {
        await run('DELETE FROM codigos_verificacion WHERE email = ?', [email]);
        return { status: 'expired' };
      }
      if (verification.intentos >= OTP_MAX_ATTEMPTS) {
        return { status: 'locked' };
      }

      const actualHash = hashVerificationCode(email, code);
      const expected = Buffer.from(verification.codigo_hash, 'hex');
      const actual = Buffer.from(actualHash, 'hex');
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        const attempts = verification.intentos + 1;
        await run('UPDATE codigos_verificacion SET intentos = ? WHERE email = ?', [attempts, email]);
        return { status: attempts >= OTP_MAX_ATTEMPTS ? 'locked' : 'invalid', attemptsRemaining: OTP_MAX_ATTEMPTS - attempts };
      }

      await run('UPDATE cuentas_anunciantes SET email_verificado_en = ? WHERE email = ? AND email_verificado_en IS NULL', [new Date().toISOString(), email]);
      await run('DELETE FROM codigos_verificacion WHERE email = ?', [email]);
      return { status: 'verified' };
    });

    if (result.status === 'invalid') {
      return res.status(400).json({ error: 'El código no es correcto.', attemptsRemaining: result.attemptsRemaining });
    }
    if (result.status === 'locked') {
      return res.status(429).json({ error: 'Se agotaron los intentos. Solicita un nuevo código.' });
    }
    if (result.status === 'expired' || result.status === 'missing') {
      return res.status(400).json({ error: 'El código venció o ya no está disponible. Solicita uno nuevo.' });
    }
    if (result.status === 'not_found') {
      return res.status(404).json({ error: 'No hay un registro pendiente de verificación para este correo.' });
    }
    await issueAdvertiserSession(email, res);
    return res.json({ message: 'Correo verificado. Tu cuenta JP-Ads está activada.', email });
  } catch (error) {
    console.error('[JP-Ads] No se pudo verificar el correo:', error.message);
    return res.status(500).json({ error: 'No se pudo verificar el correo. Inténtalo de nuevo.' });
  }
});

app.post('/api/auth/resend-verification', requireSameOrigin, async (req, res) => {
  const input = req.body;
  const email = input && typeof input.email === 'string' ? normalizeEmail(input.email) : '';
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Introduce una dirección de correo válida.' });
  }

  try {
    const code = createVerificationCode();
    const now = Date.now();
    const expiresAt = now + OTP_TTL_MS;
    const codeHash = hashVerificationCode(email, code);
    const result = await enqueueTransaction(async () => {
      const account = await get('SELECT email_verificado_en FROM cuentas_anunciantes WHERE email = ?', [email]);
      if (!account || account.email_verificado_en) {
        return { status: 'unavailable' };
      }

      const existingCode = await get('SELECT enviado_en FROM codigos_verificacion WHERE email = ?', [email]);
      if (existingCode && now - existingCode.enviado_en < OTP_RESEND_COOLDOWN_MS) {
        return { status: 'cooldown', retryAfterSeconds: Math.ceil((OTP_RESEND_COOLDOWN_MS - (now - existingCode.enviado_en)) / 1000) };
      }

      await run(
        `INSERT INTO codigos_verificacion (email, codigo_hash, expira_en, enviado_en, intentos)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(email) DO UPDATE SET
           codigo_hash = excluded.codigo_hash,
           expira_en = excluded.expira_en,
           enviado_en = excluded.enviado_en,
           intentos = 0`,
        [email, codeHash, expiresAt, now]
      );
      return { status: 'sent' };
    });

    if (result.status === 'unavailable') {
      return res.status(404).json({ error: 'No hay un registro pendiente de verificación para este correo.' });
    }
    if (result.status === 'cooldown') {
      return res.status(429).json({
        error: 'Espera antes de solicitar otro código.',
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }

    try {
      await sendVerificationEmail(email, code);
    } catch (error) {
      await enqueueTransaction(() => run('DELETE FROM codigos_verificacion WHERE email = ? AND codigo_hash = ?', [email, codeHash]));
      console.error('[JP-Ads] No se pudo reenviar el código de verificación:', error.message);
      return res.status(503).json({ error: 'No se pudo enviar el correo de verificación. Inténtalo más tarde.' });
    }

    const response = {
      message: 'Enviamos un nuevo código de seguridad a tu correo.',
      expiresInSeconds: OTP_TTL_MS / 1000,
      resendAfterSeconds: OTP_RESEND_COOLDOWN_MS / 1000,
    };
    if (EMAIL_MODE === 'simulated') {
      response.simulated = true;
      response.developmentCode = code;
    }
    return res.json(response);
  } catch (error) {
    console.error('[JP-Ads] No se pudo reenviar el código de verificación:', error.message);
    return res.status(500).json({ error: 'No se pudo reenviar el código. Inténtalo de nuevo.' });
  }
});

app.post('/api/campanas', requireAdvertiserSession, requireSameOrigin, async (req, res) => {
  const input = req.body;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return res.status(400).json({ error: 'El cuerpo debe ser un objeto JSON válido.' });
  }

  const advertiser = typeof input.advertiser === 'string' ? input.advertiser.trim() : '';
  const adTitle = typeof input.adTitle === 'string' ? input.adTitle.trim() : '';
  const destination = typeof input.destinationUrl === 'string' ? input.destinationUrl.trim() : '';

  if (!advertiser || advertiser.length > 100) {
    return res.status(400).json({ error: 'El nombre del anunciante es obligatorio y no puede superar 100 caracteres.' });
  }
  if (!adTitle || adTitle.length > 120) {
    return res.status(400).json({ error: 'El título es obligatorio y no puede superar 120 caracteres.' });
  }
  if (destination.length > 2048) {
    return res.status(400).json({ error: 'La URL no puede superar 2048 caracteres.' });
  }

  let destinationUrl;
  try {
    destinationUrl = new URL(destination);
  } catch {
    return res.status(400).json({ error: 'Introduce una URL válida que comience con https:// o http://.' });
  }
  if (!['https:', 'http:'].includes(destinationUrl.protocol) || destinationUrl.username || destinationUrl.password) {
    return res.status(400).json({ error: 'La URL debe usar HTTP o HTTPS y no puede incluir credenciales.' });
  }

  const impressions = Number(input.impressions);
  if (!Number.isSafeInteger(impressions) || impressions < MIN_CAMPAIGN_IMPRESSIONS) {
    return res.status(400).json({ error: 'La cantidad de impresiones debe ser un número entero de al menos 1000.' });
  }

  const banner = input.banner;
  if (!banner || typeof banner !== 'object' || Array.isArray(banner)) {
    return res.status(400).json({ error: 'Debes adjuntar el banner de la campaña.' });
  }
  if (typeof banner.mimeType !== 'string' || !ALLOWED_IMAGE_TYPES.has(banner.mimeType)) {
    return res.status(400).json({ error: 'El banner debe ser JPG, PNG, GIF o WebP.' });
  }
  if (typeof banner.data !== 'string' || banner.data.length === 0 || banner.data.length > Math.ceil(MAX_BANNER_BYTES / 3) * 4) {
    return res.status(400).json({ error: 'El banner debe tener un tamaño máximo de 5 MB.' });
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(banner.data)) {
    return res.status(400).json({ error: 'El contenido del banner no tiene una codificación válida.' });
  }

  const bannerBuffer = Buffer.from(banner.data, 'base64');
  if (
    bannerBuffer.length === 0
    || bannerBuffer.length > MAX_BANNER_BYTES
    || bannerBuffer.toString('base64') !== banner.data
    || !matchesImageType(bannerBuffer, banner.mimeType)
  ) {
    return res.status(400).json({ error: 'El archivo no coincide con un banner de imagen válido o supera 5 MB.' });
  }

  const filename = typeof banner.filename === 'string'
    ? banner.filename.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255)
    : '';
  const pricing = calculateCampaignPricing(impressions);

  try {
    const campaign = await enqueueTransaction(() => run(
      `INSERT INTO campanas_publicitarias (
      owner_email,
      anunciante,
      titulo,
      url_destino,
      banner_nombre,
      banner_mime,
      banner_datos,
      impresiones_compradas,
      tarifa_cpm_usd_centavos,
      costo_total_usd_centavos
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.auth.email,
      advertiser,
      adTitle,
      destinationUrl.href,
      filename,
      banner.mimeType,
      bannerBuffer,
      impressions,
      pricing.cpmUsdCents,
      pricing.totalUsdCents,
      ]
    ));

    return res.status(201).json({
      id: campaign.lastID,
      advertiser,
      adTitle,
      impressions,
      currency: 'USD',
      cpmUsd: pricing.cpmUsdCents / 100,
      discountPercent: pricing.discountPercent,
      totalUsd: pricing.totalUsdCents / 100,
      status: 'pending',
    });
  } catch (error) {
    console.error('[JP-Ads] No se pudo guardar la campaña:', error.message);
    return res.status(500).json({ error: 'No se pudo guardar la campaña. Inténtalo de nuevo.' });
  }
});

app.post('/api/payments/checkout', requireAdvertiserSession, requireSameOrigin, async (req, res) => {
  const { campaignId, provider } = req.body || {};
  if (!Number.isSafeInteger(Number(campaignId)) || Number(campaignId) < 1) {
    return res.status(400).json({ error: 'La campaña indicada no es válida.' });
  }
  if (!['stripe', 'binance', 'btcpay', 'payoneer'].includes(provider)) {
    return res.status(400).json({ error: 'Selecciona un método de pago válido.' });
  }

  try {
    const campaign = await get(
      'SELECT id, anunciante, banner_nombre, impresiones_compradas, costo_total_usd_centavos, estado FROM campanas_publicitarias WHERE id = ? AND owner_email = ?',
      [Number(campaignId), req.auth.email]
    );
    if (!campaign) {
      return res.status(404).json({ error: 'No se encontró la campaña.' });
    }
    if (campaign.estado !== 'pendiente') {
      return res.status(409).json({ error: 'Esta campaña ya no está pendiente de pago.' });
    }
    if (!isProviderConfigured(provider)) {
      return res.status(503).json({ error: `El método ${provider} todavía no tiene sus credenciales comerciales configuradas.` });
    }

    const reservation = await enqueueTransaction(async () => {
      await run(
        `UPDATE pagos_publicitarios SET estado = 'fallido'
         WHERE campana_id = ? AND proveedor = ? AND estado = 'pendiente'
           AND expira_en IS NOT NULL AND expira_en <= ?`,
        [campaign.id, provider, new Date().toISOString()]
      );
      await run(
        `UPDATE transacciones SET estado = 'fallido'
         WHERE campana_id = ? AND metodo = ? AND estado = 'pendiente'
           AND pago_id IN (
             SELECT id FROM pagos_publicitarios
             WHERE campana_id = ? AND proveedor = ? AND estado = 'fallido'
           )`,
        [campaign.id, provider, campaign.id, provider]
      );
      const existingPayment = await get(
        `SELECT id, checkout_url, expira_en, qr_image_url
         FROM pagos_publicitarios
         WHERE campana_id = ? AND proveedor = ? AND estado = 'pendiente'
         ORDER BY creado_en DESC LIMIT 1`,
        [campaign.id, provider]
      );
      if (existingPayment) {
        return { existingPayment };
      }

      const paymentId = crypto.randomUUID();
      await run(
        `INSERT INTO pagos_publicitarios (
          id, campana_id, proveedor, monto_usd_centavos, moneda, estado, creado_en
        ) VALUES (?, ?, ?, ?, ?, 'pendiente', ?)`,
        [paymentId, campaign.id, provider, campaign.costo_total_usd_centavos, provider === 'binance' ? 'USDT' : 'USD', new Date().toISOString()]
      );
      await run(
        `INSERT INTO transacciones (
          pago_id, campana_id, usuario, owner_email, monto_usd_centavos, banner_nombre, metodo, fecha, estado
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente')`,
        [
          paymentId,
          campaign.id,
          campaign.anunciante,
          req.auth.email,
          campaign.costo_total_usd_centavos,
          campaign.banner_nombre,
          provider,
          new Date().toISOString(),
        ]
      );
      return { paymentId };
    });

    if (reservation.existingPayment) {
      const existingPayment = reservation.existingPayment;
      if (!existingPayment.checkout_url) {
        return res.status(409).json({ error: 'Ya se está preparando un checkout para esta campaña. Inténtalo en unos segundos.' });
      }
      return res.status(200).json({
        paymentId: existingPayment.id,
        provider,
        status: 'pending',
        checkoutUrl: existingPayment.checkout_url,
        qrImageUrl: existingPayment.qr_image_url,
        expiresAt: existingPayment.expira_en,
      });
    }

    const paymentId = reservation.paymentId;

    try {
      let checkout;
      if (provider === 'stripe') {
        checkout = await createStripeCheckout(paymentId, campaign);
      } else if (provider === 'binance') {
        checkout = await createBinanceCheckout(paymentId, campaign);
      } else if (provider === 'btcpay') {
        checkout = await createBtcpayCheckout(paymentId, campaign);
      } else {
        checkout = await createPayoneerCheckout(paymentId, campaign);
      }
      await enqueueTransaction(() => run(
        `UPDATE pagos_publicitarios
         SET checkout_url = ?, referencia_proveedor = ?, expira_en = ?, qr_image_url = ?
         WHERE id = ? AND estado = 'pendiente'`,
        [checkout.checkoutUrl, checkout.providerReference || null, checkout.expiresAt || null, checkout.qrImageUrl || null, paymentId]
      ));
      return res.status(201).json({
        paymentId,
        provider,
        status: 'pending',
        checkoutUrl: checkout.checkoutUrl,
        qrContent: checkout.qrContent || null,
        qrImageUrl: checkout.qrImageUrl || null,
        expiresAt: checkout.expiresAt || null,
      });
    } catch (error) {
      await enqueueTransaction(() => run(
        "UPDATE pagos_publicitarios SET estado = 'fallido' WHERE id = ? AND estado = 'pendiente'",
        [paymentId]
      ));
      await enqueueTransaction(() => run(
        "UPDATE transacciones SET estado = 'fallido' WHERE pago_id = ? AND estado = 'pendiente'",
        [paymentId]
      ));
      console.error(`[JP-Ads] No se pudo iniciar el checkout de ${provider}:`, error.message);
      return res.status(502).json({ error: `No se pudo iniciar el pago con ${provider}. Inténtalo de nuevo.` });
    }
  } catch (error) {
    console.error('[JP-Ads] No se pudo preparar el checkout:', error.message);
    return res.status(500).json({ error: 'No se pudo preparar el pago.' });
  }
});

app.get('/api/account/campaigns', requireAdvertiserSession, async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const campaigns = await all(
      `SELECT id, anunciante, titulo, banner_mime, impresiones_compradas, impresiones_consumidas,
        creditos_impresiones, estado, estado_revision, creada_en
       FROM campanas_publicitarias
       WHERE owner_email = ?
       ORDER BY creada_en DESC
       LIMIT 100`,
      [req.auth.email]
    );
    return res.json(campaigns.map((campaign) => ({
      id: campaign.id,
      advertiser: campaign.anunciante,
      title: campaign.titulo,
      impressionsPurchased: campaign.impresiones_compradas,
      impressionsConsumed: campaign.impresiones_consumidas,
      impressionsRemaining: Math.max(0, campaign.creditos_impresiones - campaign.impresiones_consumidas),
      impressionsCredited: campaign.creditos_impresiones,
      progressPercent: campaign.impresiones_compradas
        ? Math.min(100, Math.round((campaign.impresiones_consumidas / campaign.impresiones_compradas) * 100))
        : 0,
      status: campaign.estado,
      moderationStatus: campaign.estado_revision,
      createdAt: campaign.creada_en,
      bannerUrl: `/api/campaigns/${campaign.id}/banner`,
    })));
  } catch (error) {
    console.error('[JP-Ads] No se pudieron consultar las campañas del anunciante:', error.message);
    return res.status(500).json({ error: 'No se pudieron cargar tus campañas.' });
  }
});

app.get('/api/campaigns/:campaignId/banner', requireAdvertiserSession, async (req, res) => {
  if (!/^[1-9]\d*$/.test(req.params.campaignId)) {
    return res.status(400).json({ error: 'El identificador de campaña no es válido.' });
  }
  try {
    const campaign = await get(
      `SELECT banner_mime, banner_datos FROM campanas_publicitarias
       WHERE id = ? AND owner_email = ?`,
      [Number(req.params.campaignId), req.auth.email]
    );
    if (!campaign) {
      return res.status(404).json({ error: 'No se encontró el banner de la campaña.' });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.type(campaign.banner_mime).send(campaign.banner_datos);
  } catch (error) {
    console.error('[JP-Ads] No se pudo servir el banner:', error.message);
    return res.status(500).json({ error: 'No se pudo cargar el banner.' });
  }
});

app.get('/api/payments/:paymentId', requireAdvertiserSession, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.paymentId)) {
    return res.status(400).json({ error: 'El identificador de pago no es válido.' });
  }
  try {
    let payment = await get(
      `SELECT p.id, p.proveedor, p.estado, p.monto_usd_centavos, p.moneda, p.expira_en,
        c.creditos_impresiones, c.estado AS estado_campana
       FROM pagos_publicitarios p
       JOIN campanas_publicitarias c ON c.id = p.campana_id
       WHERE p.id = ? AND c.owner_email = ?`,
      [req.params.paymentId, req.auth.email]
    );
    if (!payment) {
      return res.status(404).json({ error: 'No se encontró el pago.' });
    }
    if (payment.estado === 'pendiente' && payment.expira_en && Date.parse(payment.expira_en) <= Date.now()) {
      await enqueueTransaction(async () => {
        await run("UPDATE pagos_publicitarios SET estado = 'fallido' WHERE id = ? AND estado = 'pendiente'", [payment.id]);
        await run("UPDATE transacciones SET estado = 'fallido' WHERE pago_id = ? AND estado = 'pendiente'", [payment.id]);
      });
      payment = { ...payment, estado: 'fallido', expiro: true };
    }
    return res.json({
      paymentId: payment.id,
      provider: payment.proveedor,
      status: payment.expiro ? 'expirado' : payment.estado,
      campaignStatus: payment.estado_campana,
      amountUsd: payment.monto_usd_centavos / 100,
      currency: payment.moneda,
      credits: payment.creditos_impresiones,
      expiresAt: payment.expira_en,
    });
  } catch (error) {
    console.error('[JP-Ads] No se pudo consultar el pago:', error.message);
    return res.status(500).json({ error: 'No se pudo consultar el estado del pago.' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta de JP-Ads no encontrada.' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'El cuerpo de la solicitud no contiene JSON válido.' });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'La solicitud supera el tamaño permitido de 8 MB.' });
  }

  console.error('[JP-Ads] Error interno de la API:', error.message);
  return res.status(500).json({ error: 'Error interno de la API de JP-Ads.' });
});

function isProviderConfigured(provider) {
  if (provider === 'stripe') {
    return Boolean(STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET);
  }
  if (provider === 'binance') {
    // Keep both supplied API credentials configured; signed Pay requests use the merchant ID, certificate serial, and HMAC secret.
    return Boolean(BINANCE_API_KEY && BINANCE_PAY_MERCHANT_ID && BINANCE_PAY_SECRET_KEY && BINANCE_PAY_CERT_SERIAL);
  }
  if (provider === 'btcpay') {
    return Boolean(BTCPAY_URL && BTCPAY_STORE_ID && BTCPAY_API_KEY && BTCPAY_WEBHOOK_SECRET);
  }
  return Boolean(PAYONEER_CHECKOUT_URL && PAYONEER_API_TOKEN && PAYONEER_WEBHOOK_SECRET);
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  let allowed = false;
  if (process.env.NODE_ENV === 'production') {
    try {
      allowed = origin === new URL(JP_ADS_PUBLIC_URL).origin;
    } catch {
      return res.status(503).json({ error: 'El origen público de JP-Ads no está configurado correctamente.' });
    }
  } else {
    const allowedLocalOrigins = new Set([
      `http://127.0.0.1:${PORT}`,
      `http://localhost:${PORT}`,
    ]);
    allowed = allowedLocalOrigins.has(origin)
      && origin === `http://${req.get('host')}`;
  }
  if (!allowed) {
    return res.status(403).json({ error: 'La solicitud debe originarse desde el sitio JP-Ads.' });
  }
  return next();
}

function requireAdminSession(req, res, next) {
  const token = getCookieValue(req.headers.cookie, ADMIN_SESSION_COOKIE_NAME);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return res.status(401).json({ error: 'Inicia sesión como administrador.' });
  }
  get(
    'SELECT token_hash FROM admin_sessions WHERE token_hash = ? AND expires_at > ?',
    [hashSessionToken(token), Date.now()]
  ).then((session) => {
    if (!session) {
      clearAdminSessionCookie(res);
      return res.status(401).json({ error: 'La sesión administrativa venció. Inicia sesión nuevamente.' });
    }
    req.auth = { sessionHash: hashSessionToken(token) };
    return next();
  }).catch((error) => {
    console.error('[JP-Ads] No se pudo validar la sesión administrativa:', error.message);
    return res.status(500).json({ error: 'No se pudo validar la sesión administrativa.' });
  });
}

function setAdminSessionCookie(res, token) {
  const secure = isHttpsUrl(JP_ADS_PUBLIC_URL) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}${secure}`
  );
}

function clearAdminSessionCookie(res) {
  const secure = isHttpsUrl(JP_ADS_PUBLIC_URL) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0${secure}`
  );
}

function constantTimeTextEquals(candidate, expected) {
  if (typeof candidate !== 'string') {
    return false;
  }
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
}

function requireAdvertiserSession(req, res, next) {
  const token = getCookieValue(req.headers.cookie, SESSION_COOKIE_NAME);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return respondUnauthenticated(req, res, 'Inicia sesión para continuar.');
  }
  findAdvertiserSession(token).then((session) => {
    if (!session) {
      return respondUnauthenticated(req, res, 'Tu sesión venció. Inicia sesión nuevamente.');
    }
    req.auth = { email: session.email, sessionHash: hashSessionToken(token) };
    return next();
  }).catch((error) => {
    console.error('[JP-Ads] No se pudo validar la sesión del anunciante:', error.message);
    return res.status(500).json({ error: 'No se pudo validar la sesión.' });
  });
}

function respondUnauthenticated(req, res, message) {
  if (req.method === 'GET' && req.accepts('html')) {
    const returnPath = `${req.path}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
    return res.redirect(302, `/registro.html?next=${encodeURIComponent(returnPath)}`);
  }
  return res.status(401).json({ error: message });
}

function findAdvertiserSession(token) {
  return get(
    `SELECT s.email
     FROM advertiser_sessions s
     JOIN cuentas_anunciantes a ON a.email = s.email
     WHERE s.token_hash = ? AND s.expires_at > ? AND a.email_verificado_en IS NOT NULL`,
    [hashSessionToken(token), Date.now()]
  );
}

async function issueAdvertiserSession(email, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const sessionHash = hashSessionToken(token);
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await enqueueTransaction(async () => {
    await run('DELETE FROM advertiser_sessions WHERE expires_at <= ?', [Date.now()]);
    await run(
      'INSERT INTO advertiser_sessions (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)',
      [sessionHash, email, expiresAt, new Date().toISOString()]
    );
  });

  const secure = isHttpsUrl(JP_ADS_PUBLIC_URL) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    [
      `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`,
      `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0${secure}`,
    ]
  );
}

function clearAdvertiserSessionCookie(res) {
  const secure = isHttpsUrl(JP_ADS_PUBLIC_URL) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    [
      `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`,
      `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0${secure}`,
    ]
  );
}

function getCookieValue(cookieHeader, name) {
  if (typeof cookieHeader !== 'string') {
    return null;
  }
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    return part.slice(separator + 1).trim();
  }
  return null;
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createPublisherEmbedCode(unitId, format) {
  const [width, height] = format.split('x');
  const publisherScriptUrl = new URL('/publisher.js', `${JP_ADS_PUBLIC_URL}/`).href;
  return `<script async src="${publisherScriptUrl}" data-ad-unit="${unitId}" data-width="${width}" data-height="${height}"></script>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

async function servePublisherImpression(unit, ipAddress) {
  if (typeof ipAddress !== 'string' || !ipAddress) {
    throw new Error('No se pudo determinar la IP del visitante para medir la impresión.');
  }
  const secret = await get("SELECT value FROM app_secrets WHERE key = 'publisher_ip_hmac'");
  if (!secret) {
    throw new Error('No está inicializado el secreto para anonimizar IPs de editores.');
  }
  const ipHash = crypto.createHmac('sha256', secret.value).update(ipAddress).digest('hex');
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return enqueueTransaction(async () => {
    const campaign = await get(
      `SELECT id, titulo, url_destino, banner_mime, banner_datos
       FROM campanas_publicitarias
       WHERE estado = 'activa' AND estado_revision = 'aprobada'
         AND creditos_impresiones > impresiones_consumidas
       ORDER BY impresiones_consumidas ASC, id ASC
       LIMIT 1`
    );
    if (!campaign) {
      return null;
    }
    const priorImpression = await get(
      `SELECT last_counted_at FROM publisher_ip_dedup
       WHERE owner_email = ? AND ip_hash = ?`,
      [unit.owner_email, ipHash]
    );
    if (priorImpression && Date.parse(priorImpression.last_counted_at) > Date.parse(cutoff)) {
      return campaign;
    }

    const consumed = await run(
      `UPDATE campanas_publicitarias
       SET impresiones_consumidas = impresiones_consumidas + 1
       WHERE id = ? AND estado = 'activa' AND estado_revision = 'aprobada'
         AND creditos_impresiones > impresiones_consumidas`,
      [campaign.id]
    );
    if (consumed.changes !== 1) {
      return null;
    }
    await run(
      `INSERT INTO publisher_ip_dedup (owner_email, ip_hash, last_counted_at)
       VALUES (?, ?, ?)
       ON CONFLICT(owner_email, ip_hash) DO UPDATE SET last_counted_at = excluded.last_counted_at`,
      [unit.owner_email, ipHash, now]
    );
    await run(
      `INSERT INTO publisher_impressions (
        owner_email, ad_unit_id, campaign_id, ip_hash, served_at, editor_microusd, owner_microusd
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        unit.owner_email,
        unit.id,
        campaign.id,
        ipHash,
        now,
        PUBLISHER_MICRO_USD_PER_VALID_IMPRESSION,
        OWNER_MICRO_USD_PER_VALID_IMPRESSION,
      ]
    );
    return campaign;
  });
}

async function createStripeCheckout(paymentId, campaign) {
  const parameters = new URLSearchParams({
    mode: 'payment',
    success_url: `${JP_ADS_PUBLIC_URL}/panel_anunciante.html?payment_id=${encodeURIComponent(paymentId)}`,
    cancel_url: `${JP_ADS_PUBLIC_URL}/panel_anunciante.html?payment_cancelled=1`,
    client_reference_id: paymentId,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(campaign.costo_total_usd_centavos),
    'line_items[0][price_data][product_data][name]': `JP-Ads · ${campaign.impresiones_compradas} impresiones`,
    'metadata[jp_ads_payment_id]': paymentId,
    'metadata[jp_ads_campaign_id]': String(campaign.id),
    'payment_intent_data[metadata][jp_ads_payment_id]': paymentId,
  });
  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': paymentId,
    },
    body: parameters,
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || typeof result.url !== 'string' || !result.id) {
    throw new Error(result.error && result.error.message ? result.error.message : 'Stripe no creó el Checkout Session.');
  }
  return {
    checkoutUrl: result.url,
    providerReference: result.id,
    expiresAt: result.expires_at ? new Date(result.expires_at * 1000).toISOString() : null,
  };
}

async function createBinanceCheckout(paymentId, campaign) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const merchantTradeNo = paymentId.replace(/-/g, '');
  const amount = (campaign.costo_total_usd_centavos / 100).toFixed(2);
  const payload = {
    env: { terminalType: 'WEB' },
    merchantTradeNo,
    orderAmount: amount,
    currency: 'USDT',
    description: `JP-Ads campaign ${campaign.id}`,
    goodsDetails: [{
      goodsType: '02',
      goodsCategory: 'Z000',
      referenceGoodsId: String(campaign.id),
      goodsName: `JP-Ads ${campaign.impresiones_compradas} impressions`,
      goodsDetail: 'Advertising campaign impressions',
    }],
    returnUrl: `${JP_ADS_PUBLIC_URL}/panel_anunciante.html?payment_id=${encodeURIComponent(paymentId)}`,
    cancelUrl: `${JP_ADS_PUBLIC_URL}/panel_anunciante.html?payment_cancelled=1`,
    webhookUrl: `${JP_ADS_PUBLIC_URL}/api/webhooks/binance-pay`,
    passThroughInfo: paymentId,
  };
  const body = JSON.stringify(payload);
  const signature = createBinanceSignature(timestamp, nonce, body, BINANCE_PAY_SECRET_KEY);
  const response = await fetch(`${BINANCE_PAY_API_URL}/binancepay/openapi/v3/order`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'BinancePay-Timestamp': timestamp,
      'BinancePay-Nonce': nonce,
      'BinancePay-Certificate-SN': BINANCE_PAY_CERT_SERIAL,
      'BinancePay-Signature': signature,
      'BinancePay-MerchantId': BINANCE_PAY_MERCHANT_ID,
    },
    body,
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || result.status !== 'SUCCESS' || !result.data || !result.data.universalUrl) {
    throw new Error(result.errorMessage || 'Binance Pay no creó la orden.');
  }
  return {
    checkoutUrl: result.data.universalUrl,
    qrContent: result.data.qrcodeLink || result.data.universalUrl,
    qrImageUrl: isHttpsUrl(result.data.qrcodeLink) ? result.data.qrcodeLink : null,
    providerReference: merchantTradeNo,
    expiresAt: result.data.expireTime
      ? new Date(Number(result.data.expireTime)).toISOString()
      : new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
}

async function createBtcpayCheckout(paymentId, campaign) {
  const response = await fetch(
    `${BTCPAY_URL}/api/v1/stores/${encodeURIComponent(BTCPAY_STORE_ID)}/invoices`,
    {
      method: 'POST',
      headers: {
        Authorization: `token ${BTCPAY_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Idempotency-Key': paymentId,
      },
      body: JSON.stringify({
        amount: (campaign.costo_total_usd_centavos / 100).toFixed(2),
        currency: 'USD',
        metadata: {
          orderId: paymentId,
          itemDesc: `JP-Ads campaign ${campaign.id}: ${campaign.impresiones_compradas} impressions`,
        },
        checkout: {
          redirectURL: `${JP_ADS_PUBLIC_URL}/panel_anunciante.html?payment_id=${encodeURIComponent(paymentId)}`,
        },
      }),
      signal: AbortSignal.timeout(10000),
    }
  );
  const result = await response.json();
  if (!response.ok || typeof result.id !== 'string' || typeof result.checkoutLink !== 'string') {
    throw new Error('BTCPay no creó una factura válida.');
  }
  const checkoutUrl = new URL(result.checkoutLink);
  if (checkoutUrl.protocol !== 'https:') {
    throw new Error('BTCPay devolvió un enlace de factura no seguro.');
  }
  return {
    checkoutUrl: checkoutUrl.href,
    providerReference: result.id,
    expiresAt: typeof result.expirationTime === 'string' ? result.expirationTime : null,
  };
}

async function createPayoneerCheckout(paymentId, campaign) {
  const checkoutEndpoint = new URL(PAYONEER_CHECKOUT_URL);
  if (checkoutEndpoint.protocol !== 'https:') {
    throw new Error('El endpoint comercial de Payoneer debe usar HTTPS.');
  }
  const response = await fetch(checkoutEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PAYONEER_API_TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': paymentId,
    },
    body: JSON.stringify({
      merchantReference: paymentId,
      amount: (campaign.costo_total_usd_centavos / 100).toFixed(2),
      currency: 'USD',
      description: `JP-Ads campaign ${campaign.id}: ${campaign.impresiones_compradas} impressions`,
      callbackUrl: `${JP_ADS_PUBLIC_URL}/api/webhooks/payoneer`,
      returnUrl: `${JP_ADS_PUBLIC_URL}/panel_anunciante.html?payment_id=${encodeURIComponent(paymentId)}`,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || typeof result.checkoutUrl !== 'string') {
    throw new Error('El adaptador comercial de Payoneer no devolvió checkoutUrl.');
  }
  const checkoutUrl = new URL(result.checkoutUrl);
  if (checkoutUrl.protocol !== 'https:') {
    throw new Error('Payoneer devolvió un enlace de checkout no seguro.');
  }
  return {
    checkoutUrl: checkoutUrl.href,
    providerReference: typeof result.reference === 'string' ? result.reference : paymentId,
    expiresAt: typeof result.expiresAt === 'string' ? result.expiresAt : null,
  };
}

function verifyStripeSignature(header, payload, secret) {
  if (typeof header !== 'string' || !Buffer.isBuffer(payload)) {
    return false;
  }
  const timestamp = header.match(/(?:^|,)t=(\d+)(?:,|$)/);
  const signatures = [...header.matchAll(/(?:^|,)v1=([a-f0-9]{64})(?:,|$)/gi)].map((match) => match[1]);
  if (!timestamp || signatures.length === 0 || Math.abs(Date.now() / 1000 - Number(timestamp[1])) > 300) {
    return false;
  }
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp[1]}.`).update(payload).digest();
  return signatures.some((signature) => {
    const received = Buffer.from(signature, 'hex');
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  });
}

function verifyBtcpaySignature(header, payload, secret) {
  if (typeof header !== 'string' || !Buffer.isBuffer(payload)) {
    return false;
  }
  const signature = header.match(/^sha256=([a-f0-9]{64})$/i);
  if (!signature) {
    return false;
  }
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  const received = Buffer.from(signature[1], 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function createBinanceSignature(timestamp, nonce, body, secret) {
  return crypto.createHmac('sha512', secret).update(`${timestamp}\n${nonce}\n${body}\n`).digest('hex').toUpperCase();
}

function verifyBinanceSignature(headers, body, secret) {
  const timestamp = headers['binancepay-timestamp'];
  const nonce = headers['binancepay-nonce'];
  const signature = headers['binancepay-signature'];
  const serial = headers['binancepay-certificate-sn'] || headers['binancepay-cert-sn'];
  if (
    typeof timestamp !== 'string'
    || typeof nonce !== 'string'
    || typeof signature !== 'string'
    || serial !== BINANCE_PAY_CERT_SERIAL
    || !Buffer.isBuffer(body)
    || Math.abs(Date.now() - Number(timestamp)) > 300000
  ) {
    return false;
  }
  const expected = Buffer.from(createBinanceSignature(timestamp, nonce, body, secret), 'hex');
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function verifyGenericHmacSignature(signature, body, secret) {
  if (typeof signature !== 'string' || !Buffer.isBuffer(body) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function isHttpsUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function toUsdCents(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) {
    return null;
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > Number.MAX_SAFE_INTEGER / 100) {
    return null;
  }
  return Math.round(amount * 100);
}

async function activateCampaignForPayment({ paymentId, provider, externalPaymentId, paidUsdCents, currency, eventId, rawEvent }) {
  if (!['stripe', 'binance', 'btcpay', 'payoneer'].includes(provider) || !Number.isSafeInteger(paidUsdCents)) {
    return false;
  }
  return enqueueTransaction(async () => {
    const payment = await get(
      `SELECT p.id, p.campana_id, p.proveedor, p.monto_usd_centavos, p.moneda, p.estado,
        c.impresiones_compradas, c.estado AS estado_campana
       FROM pagos_publicitarios p
       JOIN campanas_publicitarias c ON c.id = p.campana_id
       WHERE p.id = ?`,
      [paymentId]
    );
    if (!payment || payment.proveedor !== provider) {
      return false;
    }
    if (
      payment.monto_usd_centavos !== paidUsdCents
      || payment.moneda !== currency
    ) {
      return false;
    }
    if (payment.estado === 'pagado') {
      return true;
    }
    if (payment.estado !== 'pendiente' || payment.estado_campana !== 'pendiente') {
      return false;
    }

    const eventRecord = await run(
      `INSERT OR IGNORE INTO webhooks_procesados (proveedor, evento_id, recibido_en, payload)
       VALUES (?, ?, ?, ?)`,
      [provider, eventId || `${paymentId}:${externalPaymentId}`, new Date().toISOString(), rawEvent]
    );
    if (eventRecord.changes === 0) {
      return true;
    }

    const paymentUpdate = await run(
      `UPDATE pagos_publicitarios
       SET estado = 'pagado', referencia_proveedor = ?, pagado_en = ?
       WHERE id = ? AND estado = 'pendiente'`,
      [externalPaymentId, new Date().toISOString(), paymentId]
    );
    if (paymentUpdate.changes !== 1) {
      return false;
    }
    await run(
      `UPDATE transacciones SET estado = 'completado', pagado_en = ?
       WHERE pago_id = ? AND estado = 'pendiente'`,
      [new Date().toISOString(), paymentId]
    );

    const campaignUpdate = await run(
      `UPDATE campanas_publicitarias
       SET estado = 'activa', creditos_impresiones = impresiones_compradas, activada_en = ?
       WHERE id = ? AND estado = 'pendiente'`,
      [new Date().toISOString(), payment.campana_id]
    );
    if (campaignUpdate.changes !== 1) {
      throw new Error('La campaña ya no estaba pendiente al acreditar el pago.');
    }
    await run(
      `INSERT INTO creditos_publicitarios (campana_id, pago_id, impresiones_acreditadas, creado_en)
       VALUES (?, ?, ?, ?)`,
      [payment.campana_id, paymentId, payment.impresiones_compradas, new Date().toISOString()]
    );
    return true;
  });
}

function matchesImageType(buffer, mimeType) {
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3
      && buffer[0] === 0xff
      && buffer[1] === 0xd8
      && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return buffer.length >= 8
      && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === 'image/gif') {
    return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6));
  }
  if (mimeType === 'image/webp') {
    return buffer.length >= 12
      && buffer.toString('ascii', 0, 4) === 'RIFF'
      && buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) {
        return reject(error);
      }
      return resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        return reject(error);
      }
      return resolve(row);
    });
  });
}

function enqueueTransaction(work) {
  const transaction = transactionQueue.then(async () => {
    await run('BEGIN IMMEDIATE');
    try {
      const result = await work();
      await run('COMMIT');
      return result;
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
  });
  transactionQueue = transaction.catch(() => {});
  return transaction;
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function isValidEmail(email) {
  return typeof email === 'string'
    && email.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function createVerificationCode() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function hashVerificationCode(email, code) {
  return crypto.createHmac('sha256', OTP_SECRET).update(`${email}:${code}`).digest('hex');
}

function createSmtpTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (![SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM].every(Boolean)) {
    throw new Error('El modo SMTP requiere SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS y SMTP_FROM.');
  }

  const port = Number(SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT debe ser un puerto válido.');
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function sendVerificationEmail(email, code) {
  const message = {
    from: process.env.SMTP_FROM || '"JP-Ads" <no-reply@jp-ads.local>',
    to: email,
    subject: 'Tu código de verificación de JP-Ads',
    text: `Tu código de verificación de JP-Ads es ${code}. Vence en 10 minutos. Si no solicitaste esta cuenta, ignora este mensaje.`,
    html: `<div style="font-family:Arial,sans-serif;color:#172033;line-height:1.6"><h1 style="font-size:22px">Verifica tu cuenta JP-Ads</h1><p>Usa este código para activar tu cuenta:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</p><p>El código vence en 10 minutos. Si no solicitaste esta cuenta, ignora este mensaje.</p></div>`,
  };
  const result = await mailer.sendMail(message);
  if (EMAIL_MODE === 'simulated') {
    console.info(`[JP-Ads] Correo simulado preparado para ${email}; código disponible solo en respuesta de desarrollo.`);
  } else if (result.rejected && result.rejected.length > 0) {
    throw new Error('El servidor SMTP rechazó el destinatario.');
  }
}

async function initializeDatabase() {
  await run('PRAGMA foreign_keys = ON');
  await run(`CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`);
  await run(`CREATE TABLE IF NOT EXISTS cuentas_anunciantes (
      email TEXT PRIMARY KEY COLLATE NOCASE,
      password_hash BLOB NOT NULL,
      password_salt BLOB NOT NULL,
      email_verificado_en TEXT,
      creada_en TEXT NOT NULL
    )`);
  await run(`CREATE TABLE IF NOT EXISTS codigos_verificacion (
      email TEXT PRIMARY KEY COLLATE NOCASE REFERENCES cuentas_anunciantes(email) ON DELETE CASCADE,
      codigo_hash TEXT NOT NULL,
      expira_en INTEGER NOT NULL,
      enviado_en INTEGER NOT NULL,
      intentos INTEGER NOT NULL DEFAULT 0 CHECK(intentos BETWEEN 0 AND ${OTP_MAX_ATTEMPTS})
    )`);
  await run(`CREATE TABLE IF NOT EXISTS advertiser_sessions (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL REFERENCES cuentas_anunciantes(email) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`);
  await run('CREATE INDEX IF NOT EXISTS idx_advertiser_sessions_email ON advertiser_sessions (email)');
  await run('CREATE INDEX IF NOT EXISTS idx_advertiser_sessions_expiry ON advertiser_sessions (expires_at)');
  await run(`CREATE TABLE IF NOT EXISTS publisher_accounts (
      owner_email TEXT PRIMARY KEY REFERENCES cuentas_anunciantes(email) ON DELETE CASCADE,
      public_id TEXT NOT NULL UNIQUE,
      site_origin TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
  await run(`CREATE TABLE IF NOT EXISTS publisher_ad_units (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL REFERENCES publisher_accounts(owner_email) ON DELETE CASCADE,
      formato TEXT NOT NULL CHECK(formato IN ('300x250', '728x90', '160x600')),
      created_at TEXT NOT NULL
    )`);
  await run(`CREATE TABLE IF NOT EXISTS publisher_ip_dedup (
      owner_email TEXT NOT NULL REFERENCES publisher_accounts(owner_email) ON DELETE CASCADE,
      ip_hash TEXT NOT NULL,
      last_counted_at TEXT NOT NULL,
      PRIMARY KEY (owner_email, ip_hash)
    )`);
  await run(`CREATE TABLE IF NOT EXISTS publisher_impressions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_email TEXT NOT NULL REFERENCES publisher_accounts(owner_email) ON DELETE CASCADE,
      ad_unit_id TEXT NOT NULL REFERENCES publisher_ad_units(id),
      campaign_id INTEGER NOT NULL REFERENCES campanas_publicitarias(id),
      ip_hash TEXT NOT NULL,
      served_at TEXT NOT NULL,
      editor_microusd INTEGER NOT NULL CHECK(editor_microusd = ${PUBLISHER_MICRO_USD_PER_VALID_IMPRESSION}),
      owner_microusd INTEGER NOT NULL CHECK(owner_microusd = ${OWNER_MICRO_USD_PER_VALID_IMPRESSION})
    )`);
  await run('CREATE INDEX IF NOT EXISTS idx_publisher_impressions_owner_date ON publisher_impressions (owner_email, served_at DESC)');
  await run(`CREATE TABLE IF NOT EXISTS app_secrets (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
  const ipHmacSecret = await get("SELECT value FROM app_secrets WHERE key = 'publisher_ip_hmac'");
  if (!ipHmacSecret) {
    await run(
      "INSERT INTO app_secrets (key, value) VALUES ('publisher_ip_hmac', ?)",
      [crypto.randomBytes(32).toString('hex')]
    );
  }
  await run(`CREATE TABLE IF NOT EXISTS campanas_publicitarias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_email TEXT REFERENCES cuentas_anunciantes(email) ON DELETE SET NULL,
      anunciante TEXT NOT NULL CHECK(length(anunciante) BETWEEN 1 AND 100),
      titulo TEXT NOT NULL CHECK(length(titulo) BETWEEN 1 AND 120),
      url_destino TEXT NOT NULL,
      banner_nombre TEXT NOT NULL,
      banner_mime TEXT NOT NULL CHECK(banner_mime IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')),
      banner_datos BLOB NOT NULL,
      impresiones_compradas INTEGER NOT NULL CHECK(impresiones_compradas >= ${MIN_CAMPAIGN_IMPRESSIONS}),
      tarifa_cpm_usd_centavos INTEGER NOT NULL CHECK(
        (impresiones_compradas < 50000 AND tarifa_cpm_usd_centavos = 2500)
        OR (impresiones_compradas >= 50000 AND impresiones_compradas < 100000 AND tarifa_cpm_usd_centavos = 2250)
        OR (impresiones_compradas >= 100000 AND tarifa_cpm_usd_centavos = 2000)
      ),
      costo_total_usd_centavos INTEGER NOT NULL CHECK(costo_total_usd_centavos >= 0),
      estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente', 'activa', 'cancelada')),
      estado_revision TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado_revision IN ('pendiente', 'aprobada', 'pausada', 'eliminada')),
      creditos_impresiones INTEGER NOT NULL DEFAULT 0 CHECK(creditos_impresiones >= 0),
      impresiones_consumidas INTEGER NOT NULL DEFAULT 0 CHECK(impresiones_consumidas >= 0 AND impresiones_consumidas <= impresiones_compradas),
      creada_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      activada_en TEXT
    )`);
  await run(`CREATE TABLE IF NOT EXISTS payment_provider_metadata (
      provider TEXT PRIMARY KEY CHECK(provider IN ('stripe', 'binance', 'btcpay')),
      account_identifier TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  await seedPaymentProviderMetadata();
  await run(`CREATE TABLE IF NOT EXISTS pagos_publicitarios (
      id TEXT PRIMARY KEY,
      campana_id INTEGER NOT NULL REFERENCES campanas_publicitarias(id),
      proveedor TEXT NOT NULL CHECK(proveedor IN ('stripe', 'binance', 'btcpay', 'payoneer')),
      monto_usd_centavos INTEGER NOT NULL CHECK(monto_usd_centavos > 0),
      moneda TEXT NOT NULL CHECK(moneda IN ('USD', 'USDT')),
      estado TEXT NOT NULL CHECK(estado IN ('pendiente', 'pagado', 'fallido', 'reembolsado')),
      checkout_url TEXT,
      qr_image_url TEXT,
      referencia_proveedor TEXT,
      expira_en TEXT,
      creado_en TEXT NOT NULL,
      pagado_en TEXT
    )`);
  await ensurePaymentProviderConstraint();
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pago_pendiente_por_campana_proveedor
      ON pagos_publicitarios (campana_id, proveedor) WHERE estado = 'pendiente'`);
  await run(`CREATE TABLE IF NOT EXISTS webhooks_procesados (
      proveedor TEXT NOT NULL,
      evento_id TEXT NOT NULL,
      recibido_en TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (proveedor, evento_id)
    )`);
  await run(`CREATE TABLE IF NOT EXISTS creditos_publicitarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campana_id INTEGER NOT NULL REFERENCES campanas_publicitarias(id),
      pago_id TEXT NOT NULL UNIQUE REFERENCES pagos_publicitarios(id),
      impresiones_acreditadas INTEGER NOT NULL CHECK(impresiones_acreditadas > 0),
      creado_en TEXT NOT NULL
    )`);
  await ensureCampaignPaymentColumns();
  await ensureCampaignModerationColumn();
  await ensureCampaignPricingSchema();
  await run('CREATE INDEX IF NOT EXISTS idx_campaigns_owner_email ON campanas_publicitarias (owner_email)');
  await run(`CREATE TABLE IF NOT EXISTS transacciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pago_id TEXT NOT NULL UNIQUE REFERENCES pagos_publicitarios(id) ON DELETE CASCADE,
      campana_id INTEGER NOT NULL REFERENCES campanas_publicitarias(id) ON DELETE CASCADE,
      usuario TEXT NOT NULL,
      owner_email TEXT REFERENCES cuentas_anunciantes(email) ON DELETE SET NULL,
      monto_usd_centavos INTEGER NOT NULL CHECK(monto_usd_centavos > 0),
      banner_nombre TEXT NOT NULL,
      metodo TEXT NOT NULL CHECK(metodo IN ('stripe', 'binance', 'btcpay', 'payoneer')),
      fecha TEXT NOT NULL,
      pagado_en TEXT,
      estado TEXT NOT NULL CHECK(estado IN ('pendiente', 'completado', 'fallido', 'reembolsado'))
    )`);
  await run('CREATE INDEX IF NOT EXISTS idx_transacciones_owner_fecha ON transacciones (owner_email, fecha DESC)');
  await migratePaymentTransactions();
}

async function migratePaymentTransactions() {
  await run(
    `INSERT OR IGNORE INTO transacciones (
      pago_id, campana_id, usuario, owner_email, monto_usd_centavos,
      banner_nombre, metodo, fecha, pagado_en, estado
    )
    SELECT p.id, p.campana_id, c.anunciante, c.owner_email, p.monto_usd_centavos,
      c.banner_nombre, p.proveedor, p.creado_en, p.pagado_en,
      CASE p.estado
        WHEN 'pagado' THEN 'completado'
        WHEN 'fallido' THEN 'fallido'
        WHEN 'reembolsado' THEN 'reembolsado'
        ELSE 'pendiente'
      END
    FROM pagos_publicitarios p
    JOIN campanas_publicitarias c ON c.id = p.campana_id`
  );
}

async function ensureCampaignPricingSchema() {
  const schema = await get(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'campanas_publicitarias'"
  );
  if (
    !schema
    || !/impresiones_compradas\s+IN\s*\(\s*1000\s*,\s*5000\s*,\s*10000\s*\)/i.test(schema.sql)
  ) {
    return;
  }

  await run('PRAGMA foreign_keys = OFF');
  try {
    await run('BEGIN IMMEDIATE');
    await run(`CREATE TABLE campanas_publicitarias_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_email TEXT REFERENCES cuentas_anunciantes(email) ON DELETE SET NULL,
      anunciante TEXT NOT NULL CHECK(length(anunciante) BETWEEN 1 AND 100),
      titulo TEXT NOT NULL CHECK(length(titulo) BETWEEN 1 AND 120),
      url_destino TEXT NOT NULL,
      banner_nombre TEXT NOT NULL,
      banner_mime TEXT NOT NULL CHECK(banner_mime IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')),
      banner_datos BLOB NOT NULL,
      impresiones_compradas INTEGER NOT NULL CHECK(impresiones_compradas >= ${MIN_CAMPAIGN_IMPRESSIONS}),
      tarifa_cpm_usd_centavos INTEGER NOT NULL CHECK(
        (impresiones_compradas < 50000 AND tarifa_cpm_usd_centavos = 2500)
        OR (impresiones_compradas >= 50000 AND impresiones_compradas < 100000 AND tarifa_cpm_usd_centavos = 2250)
        OR (impresiones_compradas >= 100000 AND tarifa_cpm_usd_centavos = 2000)
      ),
      costo_total_usd_centavos INTEGER NOT NULL CHECK(costo_total_usd_centavos >= 0),
      estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente', 'activa', 'cancelada')),
      creditos_impresiones INTEGER NOT NULL DEFAULT 0 CHECK(creditos_impresiones >= 0),
      impresiones_consumidas INTEGER NOT NULL DEFAULT 0 CHECK(impresiones_consumidas >= 0 AND impresiones_consumidas <= impresiones_compradas),
      creada_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      activada_en TEXT
    )`);
    await run(`INSERT INTO campanas_publicitarias_new (
      id, owner_email, anunciante, titulo, url_destino, banner_nombre, banner_mime,
      banner_datos, impresiones_compradas, tarifa_cpm_usd_centavos,
      costo_total_usd_centavos, estado, creditos_impresiones, impresiones_consumidas,
      creada_en, activada_en
    )
    SELECT id, owner_email, anunciante, titulo, url_destino, banner_nombre, banner_mime,
      banner_datos, impresiones_compradas, tarifa_cpm_usd_centavos,
      costo_total_usd_centavos, estado, creditos_impresiones, impresiones_consumidas,
      creada_en, activada_en
    FROM campanas_publicitarias`);
    await run('DROP TABLE campanas_publicitarias');
    await run('ALTER TABLE campanas_publicitarias_new RENAME TO campanas_publicitarias');
    const violations = await all('PRAGMA foreign_key_check');
    if (violations.length > 0) {
      throw new Error('La migración de precios detectó referencias de campañas inválidas.');
    }
    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  } finally {
    await run('PRAGMA foreign_keys = ON');
  }
}

async function seedPaymentProviderMetadata() {
  const identifiers = [
    ['stripe', STRIPE_ACCOUNT_ID],
    ['binance', BINANCE_PAY_MERCHANT_ID],
    ['btcpay', BTCPAY_STORE_ID],
  ];
  for (const [provider, identifier] of identifiers) {
    if (!identifier) {
      continue;
    }
    await run(
      `INSERT INTO payment_provider_metadata (provider, account_identifier, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         account_identifier = excluded.account_identifier,
         updated_at = excluded.updated_at`,
      [provider, identifier, new Date().toISOString()]
    );
  }
}

async function ensurePaymentProviderConstraint() {
  const table = await get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pagos_publicitarios'");
  if (!table || table.sql.includes("'btcpay'")) {
    return;
  }

  await run('PRAGMA foreign_keys = OFF');
  try {
    await run('BEGIN IMMEDIATE');
    await run(`CREATE TABLE pagos_publicitarios_new (
        id TEXT PRIMARY KEY,
        campana_id INTEGER NOT NULL REFERENCES campanas_publicitarias(id),
        proveedor TEXT NOT NULL CHECK(proveedor IN ('stripe', 'binance', 'btcpay', 'payoneer')),
        monto_usd_centavos INTEGER NOT NULL CHECK(monto_usd_centavos > 0),
        moneda TEXT NOT NULL CHECK(moneda IN ('USD', 'USDT')),
        estado TEXT NOT NULL CHECK(estado IN ('pendiente', 'pagado', 'fallido', 'reembolsado')),
        checkout_url TEXT,
        qr_image_url TEXT,
        referencia_proveedor TEXT,
        expira_en TEXT,
        creado_en TEXT NOT NULL,
        pagado_en TEXT
      )`);
    await run(`INSERT INTO pagos_publicitarios_new (
        id, campana_id, proveedor, monto_usd_centavos, moneda, estado, checkout_url,
        qr_image_url, referencia_proveedor, expira_en, creado_en, pagado_en
      )
      SELECT id, campana_id, proveedor, monto_usd_centavos, moneda, estado, checkout_url,
        qr_image_url, referencia_proveedor, expira_en, creado_en, pagado_en
      FROM pagos_publicitarios`);
    await run('DROP TABLE pagos_publicitarios');
    await run('ALTER TABLE pagos_publicitarios_new RENAME TO pagos_publicitarios');
    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  } finally {
    await run('PRAGMA foreign_keys = ON');
  }
}

async function ensureCampaignPaymentColumns() {
  const paymentColumns = await new Promise((resolve, reject) => {
    db.all('PRAGMA table_info(pagos_publicitarios)', (error, rows) => {
      if (error) {
        return reject(error);
      }
      return resolve(new Set(rows.map((row) => row.name)));
    });
  });
  if (!paymentColumns.has('qr_image_url')) {
    await run('ALTER TABLE pagos_publicitarios ADD COLUMN qr_image_url TEXT');
  }

  const columns = await new Promise((resolve, reject) => {
    db.all('PRAGMA table_info(campanas_publicitarias)', (error, rows) => {
      if (error) {
        return reject(error);
      }
      return resolve(new Set(rows.map((row) => row.name)));
    });
  });

  if (!columns.has('estado')) {
    await run("ALTER TABLE campanas_publicitarias ADD COLUMN estado TEXT NOT NULL DEFAULT 'pendiente'");
  }
  if (!columns.has('creditos_impresiones')) {
    await run('ALTER TABLE campanas_publicitarias ADD COLUMN creditos_impresiones INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.has('activada_en')) {
    await run('ALTER TABLE campanas_publicitarias ADD COLUMN activada_en TEXT');
  }
  if (!columns.has('owner_email')) {
    await run('ALTER TABLE campanas_publicitarias ADD COLUMN owner_email TEXT REFERENCES cuentas_anunciantes(email) ON DELETE SET NULL');
  }
  if (!columns.has('impresiones_consumidas')) {
    await run('ALTER TABLE campanas_publicitarias ADD COLUMN impresiones_consumidas INTEGER NOT NULL DEFAULT 0 CHECK(impresiones_consumidas >= 0 AND impresiones_consumidas <= impresiones_compradas)');
  }
}

async function ensureCampaignModerationColumn() {
  const columns = await new Promise((resolve, reject) => {
    db.all('PRAGMA table_info(campanas_publicitarias)', (error, rows) => {
      if (error) {
        return reject(error);
      }
      return resolve(new Set(rows.map((row) => row.name)));
    });
  });
  if (!columns.has('estado_revision')) {
    await run(
      "ALTER TABLE campanas_publicitarias ADD COLUMN estado_revision TEXT NOT NULL DEFAULT 'pendiente'"
    );
  }
}

initializeDatabase()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`[JP-Ads] Panel y API disponibles en http://${HOST}:${PORT}`);
      console.log(`[JP-Ads] Base SQLite independiente: ${DATABASE_PATH}`);
    });
  })
  .catch((error) => {
    console.error('[JP-Ads] No se pudo inicializar la base SQLite:', error.message);
    db.close();
    process.exitCode = 1;
  });
