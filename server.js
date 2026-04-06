const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ZAPI_URL = 'https://api.z-api.io/instances/3F0EB5CA0ADBB327C02C169647C2B2C3/token/1EE074A50DF3F4E170483A75/send-text';
const ZAPI_TOKEN = 'F88f02816c1a84f1388071b54e6a17c27S';

async function enviarWhatsApp(telefone, mensagem) {
  try {
    const response = await fetch(ZAPI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Token': ZAPI_TOKEN },
      body: JSON.stringify({ phone: telefone, message: mensagem })
    });
    return await response.json();
  } catch (err) { console.error('Erro WhatsApp:', err); }
}

// PEDIDOS
app.get('/api/pedidos', async (req, res) => {
  try {
    const { telefone } = req.query;
    let query = 'SELECT * FROM pedidos ORDER BY criado_em DESC LIMIT 100';
    let params = [];
    if (telefone) {
      query = 'SELECT * FROM pedidos WHERE telefone = $1 ORDER BY criado_em DESC LIMIT 10';
      params = [telefone];
    }
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/pedidos/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    await pool.query('UPDATE pedidos SET status = $1 WHERE id = $2', [status, id]);
    const pedido = await pool.query('SELECT * FROM pedidos WHERE id = $1', [id]);
    if (pedido.rows[0]) {
      const p = pedido.rows[0];
      if (status === 'confirmado') await enviarWhatsApp(p.telefone, `✅ *Pagamento confirmado!*\n\nSeu pedido #${p.id} entrou em produção! Avisaremos quando estiver pronto. 😊`);
      if (status === 'pronto') {
        const msg = p.tipo === 'entrega'
          ? `🎉 *Pedido #${p.id} pronto!*\n\nEstamos preparando para entrega. Em breve! 🛵`
          : `🎉 *Pedido #${p.id} pronto para retirada!*\n\n📍 R. Aquiles, 231 - Vila Shangri-Lá\n⏰ Seg-Sáb 06h30-19h30`;
        await enviarWhatsApp(p.telefone, msg);
      }
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pedidos/parcial', async (req, res) => {
  const { telefone, nome_cliente, itens, observacoes, status } = req.body;
  try {
    const existing = await pool.query("SELECT id FROM pedidos WHERE telefone = $1 AND status = 'aguardando_horario'", [telefone]);
    if (existing.rows.length > 0) return res.json({ success: true, id: existing.rows[0].id });
    const result = await pool.query(
      'INSERT INTO pedidos (telefone, nome_cliente, itens, observacoes, status, criado_em) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id',
      [telefone, nome_cliente, itens, observacoes, status || 'aguardando_horario']
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pedidos/:id/confirmar-horario', async (req, res) => {
  const { id } = req.params;
  try {
    const pedido = await pool.query('SELECT * FROM pedidos WHERE id = $1', [id]);
    if (!pedido.rows[0]) return res.status(404).json({ error: 'Pedido não encontrado' });
    const p = pedido.rows[0];
    await pool.query("UPDATE pedidos SET status = 'aguardando_pagamento' WHERE id = $1", [id]);
    await pool.query("UPDATE estado_pedido SET etapa = 'aguardando_tipo', atualizado_em = NOW() WHERE telefone = $1", [p.telefone]);
    await enviarWhatsApp(p.telefone, `✅ Ótimas notícias! Conseguimos atender! 😊\n\n📍 Retirada na loja ou entrega?\n\n🏪 *1* — Retirada na loja\n🛵 *2* — Entrega`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pedidos/:id/cancelar-horario', async (req, res) => {
  const { id } = req.params;
  try {
    const pedido = await pool.query('SELECT * FROM pedidos WHERE id = $1', [id]);
    if (!pedido.rows[0]) return res.status(404).json({ error: 'Pedido não encontrado' });
    const p = pedido.rows[0];
    await pool.query("UPDATE pedidos SET status = 'cancelado' WHERE id = $1", [id]);
    await pool.query('DELETE FROM estado_pedido WHERE telefone = $1', [p.telefone]);
    await enviarWhatsApp(p.telefone, `😔 Infelizmente não conseguimos atender no horário solicitado.\n\nNosso prazo mínimo é de 4 horas. Posso remarcar? 😊`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CLIENTES VIP
app.get('/api/clientes-vip', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clientes_vip ORDER BY criado_em DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clientes-vip/:telefone', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clientes_vip WHERE telefone = $1', [req.params.telefone]);
    res.json({ vip: result.rows.length > 0, dados: result.rows[0] || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clientes-vip', async (req, res) => {
  const { telefone, nome, observacao } = req.body;
  try {
    await pool.query(
      'INSERT INTO clientes_vip (telefone, nome, observacao, criado_em) VALUES ($1, $2, $3, NOW()) ON CONFLICT (telefone) DO UPDATE SET nome = $2, observacao = $3',
      [telefone, nome, observacao]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clientes-vip/:telefone', async (req, res) => {
  try {
    await pool.query('DELETE FROM clientes_vip WHERE telefone = $1', [req.params.telefone]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// NÚMEROS BLOQUEADOS
app.get('/api/numeros-bloqueados', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM numeros_bloqueados ORDER BY criado_em DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/numeros-bloqueados', async (req, res) => {
  const { telefone, nome, motivo } = req.body;
  try {
    await pool.query(
      'INSERT INTO numeros_bloqueados (telefone, nome, motivo, criado_em) VALUES ($1, $2, $3, NOW()) ON CONFLICT (telefone) DO UPDATE SET nome = $2, motivo = $3',
      [telefone, nome, motivo]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/numeros-bloqueados/:telefone', async (req, res) => {
  try {
    await pool.query('DELETE FROM numeros_bloqueados WHERE telefone = $1', [req.params.telefone]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// MODO AUSÊNCIA
app.get('/api/ausencia', async (req, res) => {
  try {
    const result = await pool.query("SELECT valor FROM configuracoes WHERE chave = 'modo_ausencia' LIMIT 1");
    res.json(result.rows.length > 0 ? JSON.parse(result.rows[0].valor) : { ativo: false, mensagem: '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ausencia', async (req, res) => {
  const { ativo, mensagem } = req.body;
  try {
    await pool.query(
      "INSERT INTO configuracoes (chave, valor) VALUES ('modo_ausencia', $1) ON CONFLICT (chave) DO UPDATE SET valor = $1",
      [JSON.stringify({ ativo, mensagem })]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard rodando na porta ${PORT}`));
