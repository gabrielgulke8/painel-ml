const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const APP_ID = '1676926349566548';
const SECRET = 'mrmjbwY1pPyqODJ4XXKTZfyipbMwaRIM';
const REDIRECT = 'https://www.mercadolivre';

// Token OAuth
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
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Buscar vendas com detalhes completos de taxas e frete
app.get('/vendas', async (req, res) => {
  try {
    const token = req.headers['authorization'] || '';
    const seller = req.query.seller;
    const limit = req.query.limit || 50;

    // 1. Buscar lista de pedidos
    const rOrders = await fetch(
      `https://api.mercadolibre.com/orders/search?seller=${seller}&sort=date_desc&limit=${limit}`,
      { headers: { Authorization: token, Accept: 'application/json' } }
    );
    if (!rOrders.ok) {
      const err = await rOrders.json();
      return res.status(rOrders.status).json(err);
    }
    const ordersData = await rOrders.json();
    const orders = ordersData.results || [];

    // 2. Para cada pedido, buscar detalhes de frete
    const vendas = await Promise.all(orders.map(async (o) => {
      let freteVendedor = 0;
      let freteComprador = 0;
      let taxaParcelamento = 0;

      // Buscar detalhes do shipment para frete real
      try {
        if (o.shipping && o.shipping.id) {
          const rShip = await fetch(
            `https://api.mercadolibre.com/shipments/${o.shipping.id}`,
            { headers: { Authorization: token, Accept: 'application/json' } }
          );
          if (rShip.ok) {
            const ship = await rShip.json();
            freteVendedor = ship.shipping_option?.cost || ship.base_cost || 0;
            freteComprador = ship.shipping_option?.list_cost || 0;
          }
        }
      } catch (e) { /* ignora erro de shipment */ }

      // Taxa de parcelamento dos pagamentos
      try {
        const payments = o.payments || [];
        payments.forEach(p => {
          if (p.installments && p.installments > 1) {
            taxaParcelamento += (p.total_paid_amount || 0) - (p.transaction_amount || 0);
          }
        });
      } catch (e) { /* ignora */ }

      // Montar itens
      const items = (o.order_items || []).map(i => ({
        title: i.item?.title || '',
        item_id: i.item?.id || '',
        unit_price: i.unit_price || 0,
        quantity: i.quantity || 1,
        // Taxa ML real do marketplace_fee
        sale_fee: o.payments?.[0]?.marketplace_fee || 0,
        // Frete real do vendedor
        shipping_cost: freteVendedor,
        // Frete cobrado do comprador
        shipping_cost_comprador: freteComprador,
        // Taxa de parcelamento
        taxa_parcelamento: taxaParcelamento,
        date_created: o.date_created,
        order_id: o.id,
        order_status: o.status,
        payment_status: o.payments?.[0]?.status || '',
        payment_type: o.payments?.[0]?.payment_type || '',
        installments: o.payments?.[0]?.installments || 1,
      }));

      return items;
    }));

    res.json({ results: vendas.flat() });
  } catch (e) {
    console.error('Erro /vendas:', e);
    res.status(500).json({ error: e.message });
  }
});

// Proxy genérico para outros endpoints ML
app.use('/api', async (req, res) => {
  try {
    const token = req.headers['authorization'] || '';
    const mlPath = req.path;
    const query = Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '';
    const url = `https://api.mercadolibre.com${mlPath}${query}`;
    console.log('Proxy ->', url);
    const r = await fetch(url, {
      method: req.method,
      headers: { 'Authorization': token, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    console.error('Proxy error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('Painel ML Server rodando ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server na porta ' + PORT));
