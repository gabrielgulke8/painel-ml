const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const APP_ID = '1676926349566548';
const SECRET = 'mrmjbwY1pPyqODJ4XXKTZfyipbMwaRIM';
const REDIRECT = 'https://www.mercadolivre';
const TOKEN_FILE = path.join('/tmp', 'ml_tokens.json');

// ── TOKEN STORAGE ──
function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) {}
  return { access_token: null, refresh_token: null, user_id: null, expires_at: 0 };
}

function saveTokens(data) {
  try {
    const tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      user_id: data.user_id || loadTokens().user_id,
      expires_at: Date.now() + (data.expires_in || 21600) * 1000
    };
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
    return tokens;
  } catch (e) { console.error('Erro ao salvar tokens:', e); return null; }
}

// ── AUTO REFRESH ──
async function getValidToken() {
  const tokens = loadTokens();
  if (!tokens.access_token) return null;
  if (Date.now() > tokens.expires_at - 1800000) {
    console.log('Renovando token automaticamente...');
    try {
      const r = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: APP_ID, client_secret: SECRET, refresh_token: tokens.refresh_token })
      });
      const d = await r.json();
      if (d.access_token) { const saved = saveTokens(d); console.log('Token renovado'); return saved.access_token; }
    } catch (e) { console.error('Erro ao renovar:', e); }
  }
  return tokens.access_token;
}

setInterval(async () => { await getValidToken(); }, 5 * 60 * 60 * 1000);

// ── SERVE PAINEL HTML ──
app.get('/painel', (req, res) => {
  const painelPath = path.join(__dirname, 'painel-ml.html');
  if (fs.existsSync(painelPath)) {
    res.sendFile(painelPath);
  } else {
    res.status(404).send('painel-ml.html não encontrado no servidor');
  }
});

// ── TOKEN OAUTH ──
app.post('/token', async (req, res) => {
  try {
    const { code, refresh_token, grant_type } = req.body;
    const params = grant_type === 'refresh_token'
      ? { grant_type: 'refresh_token', client_id: APP_ID, client_secret: SECRET, refresh_token }
      : { grant_type: 'authorization_code', client_id: APP_ID, client_secret: SECRET, code, redirect_uri: REDIRECT };
    const r = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams(params)
    });
    const data = await r.json();
    if (data.access_token) { saveTokens(data); console.log('Tokens salvos para user:', data.user_id); }
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TOKEN STATUS ──
app.get('/token/status', (req, res) => {
  const tokens = loadTokens();
  const minutesLeft = tokens.expires_at ? Math.round((tokens.expires_at - Date.now()) / 60000) : 0;
  res.json({ connected: !!tokens.access_token, user_id: tokens.user_id, expires_in_minutes: minutesLeft, auto_renew: true });
});

// ── VENDAS COM TAXAS DETALHADAS ──
app.get('/vendas', async (req, res) => {
  try {
    const token = await getValidToken();
    if (!token) return res.status(401).json({ error: 'Token não encontrado. Faça login novamente.' });
    const seller = req.query.seller || loadTokens().user_id;
    const limit = req.query.limit || 50;
    const rOrders = await fetch(`https://api.mercadolibre.com/orders/search?seller=${seller}&sort=date_desc&limit=${limit}`, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (!rOrders.ok) return res.status(rOrders.status).json(await rOrders.json());
    const orders = (await rOrders.json()).results || [];
    const vendas = await Promise.all(orders.map(async (o) => {
      let freteVendedor = 0, freteComprador = 0, taxaParcelamento = 0;
      try {
        if (o.shipping?.id) {
          const rShip = await fetch(`https://api.mercadolibre.com/shipments/${o.shipping.id}`, { headers: { Authorization: 'Bearer ' + token } });
          if (rShip.ok) { const ship = await rShip.json(); freteVendedor = ship.shipping_option?.cost || ship.base_cost || 0; freteComprador = ship.shipping_option?.list_cost || 0; }
        }
      } catch (e) {}
      try { (o.payments || []).forEach(p => { if (p.installments > 1) taxaParcelamento += (p.total_paid_amount || 0) - (p.transaction_amount || 0); }); } catch (e) {}
      return (o.order_items || []).map(i => ({
        title: i.item?.title || '', item_id: i.item?.id || '',
        unit_price: i.unit_price || 0, quantity: i.quantity || 1,
        sale_fee: o.payments?.[0]?.marketplace_fee || 0,
        shipping_cost: freteVendedor, shipping_cost_comprador: freteComprador,
        taxa_parcelamento: taxaParcelamento, date_created: o.date_created,
        order_id: o.id, order_status: o.status,
        payment_status: o.payments?.[0]?.status || '',
        installments: o.payments?.[0]?.installments || 1,
      }));
    }));
    res.json({ results: vendas.flat() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROXY GENÉRICO ──
app.use('/api', async (req, res) => {
  try {
    const token = await getValidToken();
    if (!token) return res.status(401).json({ error: 'Token não encontrado' });
    const url = `https://api.mercadolibre.com${req.path}${Object.keys(req.query).length ? '?' + new URLSearchParams(req.query) : ''}`;
    const r = await fetch(url, { method: req.method, headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => {
  const tokens = loadTokens();
  res.send(`Painel ML Server ✅ | Conectado: ${!!tokens.access_token} | User: ${tokens.user_id || 'N/A'} | <a href="/painel">Abrir Painel</a>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server na porta ' + PORT));
