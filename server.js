const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const https = require('https');

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
      headers: {
        'Content-Type': 'application/json',
        'Client-Token': ZAPI_TOKEN
      },
      body: JSON.stringify({ phone: telefone, message: mensagem })
    });
    return await response.json();
  } catch (err) {
    console.error('Erro ao enviar WhatsApp:', err);
  }
}

// Listar pedidos
app.get('/api/pedidos', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM pedidos 
      ORDER BY criado_em DESC 
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar status do pedido
app.patch('/api/pedidos/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    await pool.query('UPDATE pedidos SET status = $1 WHERE id = $2', [status, id]);

    // Se confirmou pagamento, avisa o cliente
    if (status === 'confirmado') {
      const pedido = await pool.query('SELECT * FROM pedidos WHERE id = $1', [id]);
      if (pedido.rows[0]) {
        const p = pedido.rows[0];
        await enviarWhatsApp(p.telefone,
          `✅ *Pagamento confirmado!*\n\nSeu pedido #${p.id} está em produção! 🎉\n\nAssim que estiver pronto, te avisaremos. Obrigado pela preferência! 😊`
        );
      }
    }

    // Se ficou pronto, avisa o cliente
    if (status === 'pronto') {
      const pedido = await pool.query('SELECT * FROM pedidos WHERE id = $1', [id]);
      if (pedido.rows[0]) {
        const p = pedido.rows[0];
        const msg = p.tipo === 'entrega'
          ? `🎉 *Seu pedido #${p.id} está pronto!*\n\nEstamos preparando para entrega. Em breve chegará até você! 🛵`
          : `🎉 *Seu pedido #${p.id} está pronto!*\n\nPode vir retirar na loja:\n📍 R. Aquiles, 231 - Vila Shangri-Lá, Apucarana/PR\n⏰ Seg-Sáb 06h30-19h30 | Dom 07h-11h30`;
        await enviarWhatsApp(p.telefone, msg);
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Salvar pedido parcial (menos de 4h)
app.post('/api/pedidos/parcial', async (req, res) => {
  const { telefone, nome_cliente, itens, observacoes, status } = req.body;
  try {
    // Verifica se já existe pedido aguardando horário para esse telefone
    const existing = await pool.query(
      "SELECT id FROM pedidos WHERE telefone = $1 AND status = 'aguardando_horario'",
      [telefone]
    );
    if (existing.rows.length > 0) {
      return res.json({ success: true, id: existing.rows[0].id });
    }
    const result = await pool.query(
      `INSERT INTO pedidos (telefone, nome_cliente, itens, observacoes, status, criado_em)
       VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
      [telefone, nome_cliente, itens, observacoes, status || 'aguardando_horario']
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confirmar horário (pedido com menos de 4h)
app.post('/api/pedidos/:id/confirmar-horario', async (req, res) => {
  const { id } = req.params;
  try {
    const pedido = await pool.query('SELECT * FROM pedidos WHERE id = $1', [id]);
    if (!pedido.rows[0]) return res.status(404).json({ error: 'Pedido não encontrado' });

    const p = pedido.rows[0];

    // Atualiza status do pedido
    await pool.query('UPDATE pedidos SET status = $1 WHERE id = $2', ['aguardando_pagamento', id]);

    // Atualiza estado_pedido para continuar o fluxo
    await pool.query(
      "UPDATE estado_pedido SET etapa = 'aguardando_tipo', atualizado_em = NOW() WHERE telefone = $1",
      [p.telefone]
    );

    // Envia mensagem ao cliente
    await enviarWhatsApp(p.telefone,
      `✅ Ótimas notícias! Conseguimos atender seu pedido no horário solicitado! 😊\n\n📍 Retirada na loja ou entrega?\n\n🏪 *1* — Retirada na loja\n🛵 *2* — Entrega`
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancelar horário (pedido com menos de 4h)
app.post('/api/pedidos/:id/cancelar-horario', async (req, res) => {
  const { id } = req.params;
  try {
    const pedido = await pool.query('SELECT * FROM pedidos WHERE id = $1', [id]);
    if (!pedido.rows[0]) return res.status(404).json({ error: 'Pedido não encontrado' });

    const p = pedido.rows[0];

    // Cancela o pedido
    await pool.query('UPDATE pedidos SET status = $1 WHERE id = $2', ['cancelado', id]);

    // Limpa estado_pedido
    await pool.query('DELETE FROM estado_pedido WHERE telefone = $1', [p.telefone]);

    // Envia mensagem ao cliente
    await enviarWhatsApp(p.telefone,
      `😔 Infelizmente não conseguimos atender no horário solicitado.\n\nNosso prazo mínimo é de 4 horas.\n\nPosso remarcar seu pedido para outro horário? 😊`
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Contar pedidos por status
app.get('/api/pedidos/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT status, COUNT(*) as total 
      FROM pedidos 
      GROUP BY status
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard rodando na porta ${PORT}`));
