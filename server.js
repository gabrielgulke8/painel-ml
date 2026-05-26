const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const APP_ID = '1676926349566548';
const SECRET = 'mrmjbwY1pPyqODJ4XXKTZfyipbMwaRIM';
const REDIRECT = 'https://www.mercadolivre';

// Troca código por token
app.post('/token', async (req, res) => {
  try {
    const { code, refresh_token, grant_type } = req.body;
    const params = grant_type === 'refresh_token'
      ? { grant_type: 'refresh_token', client_id: APP_ID, client_secret: SECRET, refresh_token }
      : { grant_type: 'authorization_code', client_id: APP_ID, client_secret: SECRET, code, redirect_uri: REDIRECT };
    const r = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params)
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy para API do ML
app.get('/api/*', async (req, res) => {
  try {
    const token = req.headers['authorization'];
    const path = req.params[0];
    const query = req.url.split('?')[1] || '';
    const url = `https://api.mercadolibre.com/${path}${query ? '?' + query : ''}`;
    const r = await fetch(url, { headers: { Authorization: token } });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('Painel ML Server rodando ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server rodando na porta ' + PORT));
