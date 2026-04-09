const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ZAPI_URL = 'https://api.z-api.io/instances/3F0EB5CA0ADBB327C02C169647C2B2C3/token/1EE074A50DF3F4E170483A75/send-text';
const ZAPI_TOKEN = 'F88f02816c1a84f1388071b54e6a17c27S';

async function getConfig(chave) {
  const r = await pool.query('SELECT valor FROM configuracoes WHERE chave = $1', [chave]);
  return r.rows[0]?.valor || null;
}

async function enviarWhatsApp(telefone, mensagem) {
  try {
    await fetch(ZAPI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Token': ZAPI_TOKEN },
      body: JSON.stringify({ phone: telefone, message: mensagem })
    });
  } catch (err) { console.error('Erro WhatsApp:', err.message); }
}

async function registrarHistorico(pedidoId, acao, descricao, dadosAnteriores, dadosNovos) {
  try {
    await pool.query(
      'INSERT INTO historico_pedidos (pedido_id, acao, descricao, dados_anteriores, dados_novos) VALUES ($1,$2,$3,$4,$5)',
      [pedidoId, acao, descricao, JSON.stringify(dadosAnteriores || {}), JSON.stringify(dadosNovos || {})]
    );
  } catch(e) { console.error('Erro histórico:', e.message); }
}

// Calcula valor total do pedido baseado nos itens e produtos do banco
async function calcularValorPedido(itensTexto) {
  try {
    const produtos = await pool.query('SELECT * FROM produtos WHERE disponivel = true');
    const itensLower = itensTexto.toLowerCase();
    let total = 0;
    let encontrados = [];

    for (const produto of produtos.rows) {
      const nomeLower = produto.nome.toLowerCase();
      const regex = new RegExp('(\\d+[\\.,]?\\d*)\\s*(?:kg|g|unidades?|un)?\\s*(?:de\\s+)?(?:' + nomeLower.replace(/\s+/g, '\\s+') + ')', 'i');
      const match = itensLower.match(regex);
      if (match) {
        const qtd = parseFloat(match[1].replace(',', '.'));
        const subtotal = qtd * parseFloat(produto.preco);
        total += subtotal;
        encontrados.push({ nome: produto.nome, qtd, preco: produto.preco, subtotal });
      }
    }

    return { total: total > 0 ? total.toFixed(2) : null, itens: encontrados };
  } catch(e) { return { total: null, itens: [] }; }
}

// ===== PEDIDOS =====
app.get('/api/pedidos', async (req, res) => {
  try {
    const { telefone, data, busca } = req.query;
    let query = 'SELECT * FROM pedidos WHERE 1=1';
    let params = []; let idx = 1;
    if (telefone) { query += ` AND telefone = $${idx++}`; params.push(telefone); }
    if (data) { query += ` AND DATE(criado_em AT TIME ZONE 'America/Sao_Paulo') = $${idx++}`; params.push(data); }
    if (busca) { query += ` AND (nome_cliente ILIKE $${idx} OR telefone ILIKE $${idx} OR itens ILIKE $${idx})`; params.push(`%${busca}%`); idx++; }
    query += ' ORDER BY criado_em DESC LIMIT 200';
    res.json((await pool.query(query, params)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/pedidos/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    const anterior = await pool.query('SELECT * FROM pedidos WHERE id = $1', [id]);
    if (!anterior.rows[0]) return res.status(404).json({ error: 'Pedido não encontrado' });
    const p = anterior.rows[0];
    await pool.query('UPDATE pedidos SET status = $1 WHERE id = $2', [status, id]);
    await registrarHistorico(id, 'status', `${p.status} → ${status}`, { status: p.status }, { status });
    if (status === 'confirmado') {
      await enviarWhatsApp(p.telefone, `✅ *Pagamento confirmado!*\n\nSeu pedido #${p.id} entrou em produção! Avisaremos quando estiver pronto. 😊`);
    }
    if (status === 'pronto') {
      const endereco = await getConfig('endereco_padaria') || 'R. Aquiles, 231 - Vila Shangri-Lá, Apucarana/PR';
      const horario = await getConfig('horario_loja') || 'Seg-Sáb 06h30-19h30';
      const msg = p.tipo === 'entrega'
        ? `🎉 *Pedido #${p.id} pronto!*\n\nEstamos preparando para entrega. Em breve! 🛵`
        : `🎉 *Pedido #${p.id} pronto para retirada!*\n\n📍 ${endereco}\n⏰ ${horario}`;
      await enviarWhatsApp(p.telefone, msg);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/pedidos/:id/editar', async (req, res) => {
  const { id } = req.params;
  const { nome_cliente, itens, forma_pagamento, valor_total, observacoes, endereco, tipo } = req.body;
  try {
    const anterior = await pool.query('SELECT * FROM pedidos WHERE id = $1', [id]);
    if (!anterior.rows[0]) return res.status(404).json({ error: 'Pedido não encontrado' });
    const p = anterior.rows[0];
    const fields = []; const values = []; let idx = 1;
    if (nome_cliente !== undefined) { fields.push(`nome_cliente = $${idx++}`); values.push(nome_cliente); }
    if (itens !== undefined) { fields.push(`itens = $${idx++}`); values.push(itens); }
    if (forma_pagamento !== undefined) { fields.push(`forma_pagamento = $${idx++}`); values.push(forma_pagamento); }
    if (valor_total !== undefined) { fields.push(`valor_total = $${idx++}`); values.push(valor_total); }
    if (observacoes !== undefined) { fields.push(`observacoes = $${idx++}`); values.push(observacoes); }
    if (endereco !== undefined) { fields.push(`endereco = $${idx++}`); values.push(endereco); }
    if (tipo !== undefined) { fields.push(`tipo = $${idx++}`); values.push(tipo); }
    if (!fields.length) return res.status(400).json({ error: 'Nenhum campo' });
    values.push(id);
    await pool.query(`UPDATE pedidos SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    await registrarHistorico(id, 'edicao', 'Editado manualmente', p, req.body);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pedidos/:id/historico', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM historico_pedidos WHERE pedido_id = $1 ORDER BY criado_em DESC', [req.params.id])).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pedidos/parcial', async (req, res) => {
  const { telefone, nome_cliente, itens, observacoes, status } = req.body;
  try {
    const existing = await pool.query("SELECT id FROM pedidos WHERE telefone = $1 AND status = 'aguardando_horario'", [telefone]);
    if (existing.rows.length > 0) return res.json({ success: true, id: existing.rows[0].id });
    // Tenta calcular valor automaticamente
    let valor_total = null;
    if (itens) { const calc = await calcularValorPedido(itens); valor_total = calc.total; }
    const result = await pool.query(
      'INSERT INTO pedidos (telefone, nome_cliente, itens, observacoes, status, valor_total, criado_em) VALUES ($1,$2,$3,$4,$5,$6,NOW()) RETURNING id',
      [telefone, nome_cliente, itens, observacoes, status || 'aguardando_horario', valor_total]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pedidos/:id/confirmar-horario', async (req, res) => {
  const { id } = req.params;
  try {
    const pedido = await pool.query('SELECT * FROM pedidos WHERE id = $1', [id]);
    if (!pedido.rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    const p = pedido.rows[0];
    await pool.query("UPDATE pedidos SET status = 'aguardando_pagamento' WHERE id = $1", [id]);
    await pool.query("UPDATE estado_pedido SET etapa = 'aguardando_tipo', atualizado_em = NOW() WHERE telefone = $1", [p.telefone]);
    await registrarHistorico(id, 'confirmar_horario', 'Horário confirmado', null, null);
    await enviarWhatsApp(p.telefone, `✅ Ótimas notícias! Conseguimos atender! 😊\n\n📍 Retirada na loja ou entrega?\n\n🏪 *1* — Retirada na loja\n🛵 *2* — Entrega`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pedidos/:id/cancelar-horario', async (req, res) => {
  const { id } = req.params;
  try {
    const pedido = await pool.query('SELECT * FROM pedidos WHERE id = $1', [id]);
    if (!pedido.rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    const p = pedido.rows[0];
    await pool.query("UPDATE pedidos SET status = 'cancelado' WHERE id = $1", [id]);
    await pool.query('DELETE FROM estado_pedido WHERE telefone = $1', [p.telefone]);
    await registrarHistorico(id, 'cancelar_horario', 'Horário não disponível', null, null);
    await enviarWhatsApp(p.telefone, `😔 Infelizmente não conseguimos atender no horário solicitado.\n\nNosso prazo mínimo é de 4 horas. Posso remarcar? 😊`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pedidos/:id/cancelar', async (req, res) => {
  const { id } = req.params;
  const { motivo } = req.body;
  try {
    const pedido = await pool.query('SELECT * FROM pedidos WHERE id = $1', [id]);
    if (!pedido.rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    const p = pedido.rows[0];
    await pool.query("UPDATE pedidos SET status = 'cancelado' WHERE id = $1", [id]);
    await pool.query('DELETE FROM estado_pedido WHERE telefone = $1', [p.telefone]);
    await registrarHistorico(id, 'cancelado', motivo || 'Cancelado pelo atendente', { status: p.status }, { status: 'cancelado' });
    await enviarWhatsApp(p.telefone, `😔 Seu pedido #${p.id} foi cancelado.${motivo ? '\n\nMotivo: ' + motivo : ''}\n\nQualquer dúvida entre em contato. 😊`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== PRODUTOS (CARDÁPIO) =====
app.get('/api/produtos', async (req, res) => {
  try {
    const { apenas_disponiveis } = req.query;
    let query = 'SELECT * FROM produtos';
    if (apenas_disponiveis === 'true') query += ' WHERE disponivel = true';
    query += ' ORDER BY categoria, ordem, nome';
    res.json((await pool.query(query)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/produtos', async (req, res) => {
  const { nome, categoria, descricao, preco, unidade, disponivel, imagem_url, ordem } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO produtos (nome, categoria, descricao, preco, unidade, disponivel, imagem_url, ordem, criado_em, atualizado_em) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW()) RETURNING *',
      [nome, categoria, descricao, preco, unidade || 'unidade', disponivel !== false, imagem_url, ordem || 0]
    );
    res.json({ success: true, produto: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/produtos/:id', async (req, res) => {
  const { id } = req.params;
  const { nome, categoria, descricao, preco, unidade, disponivel, imagem_url, ordem } = req.body;
  try {
    const fields = []; const values = []; let idx = 1;
    if (nome !== undefined) { fields.push(`nome = $${idx++}`); values.push(nome); }
    if (categoria !== undefined) { fields.push(`categoria = $${idx++}`); values.push(categoria); }
    if (descricao !== undefined) { fields.push(`descricao = $${idx++}`); values.push(descricao); }
    if (preco !== undefined) { fields.push(`preco = $${idx++}`); values.push(preco); }
    if (unidade !== undefined) { fields.push(`unidade = $${idx++}`); values.push(unidade); }
    if (disponivel !== undefined) { fields.push(`disponivel = $${idx++}`); values.push(disponivel); }
    if (imagem_url !== undefined) { fields.push(`imagem_url = $${idx++}`); values.push(imagem_url); }
    if (ordem !== undefined) { fields.push(`ordem = $${idx++}`); values.push(ordem); }
    fields.push(`atualizado_em = NOW()`);
    values.push(id);
    await pool.query(`UPDATE produtos SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/produtos/:id/disponibilidade', async (req, res) => {
  const { id } = req.params;
  const { disponivel } = req.body;
  try {
    await pool.query('UPDATE produtos SET disponivel = $1, atualizado_em = NOW() WHERE id = $2', [disponivel, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/produtos/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM produtos WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Upload de imagem (base64)
app.post('/api/produtos/:id/imagem', async (req, res) => {
  const { id } = req.params;
  const { imagem_base64, tipo } = req.body;
  try {
    // Salva base64 diretamente no banco como URL de dados
    const imagem_url = `data:${tipo || 'image/jpeg'};base64,${imagem_base64}`;
    await pool.query('UPDATE produtos SET imagem_url = $1, atualizado_em = NOW() WHERE id = $2', [imagem_url, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cardápio para o n8n (substitui Google Sheets)
app.get('/api/cardapio', async (req, res) => {
  try {
    const produtos = (await pool.query('SELECT * FROM produtos WHERE disponivel = true ORDER BY categoria, ordem, nome')).rows;
    // Formata como texto para o GPT
    const categorias = {};
    produtos.forEach(p => {
      if (!categorias[p.categoria]) categorias[p.categoria] = [];
      categorias[p.categoria].push(`  - ${p.nome}: R$ ${Number(p.preco).toFixed(2)}/${p.unidade}${p.descricao ? ' (' + p.descricao + ')' : ''}`);
    });
    const cardapioTexto = Object.entries(categorias).map(([cat, items]) => `${cat}:\n${items.join('\n')}`).join('\n\n');
    res.json({ values: cardapioTexto, produtos });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Calcular valor do pedido
app.post('/api/calcular-valor', async (req, res) => {
  const { itens } = req.body;
  try {
    const resultado = await calcularValorPedido(itens);
    res.json(resultado);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== CLIENTES VIP =====
app.get('/api/clientes-vip', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM clientes_vip ORDER BY criado_em DESC')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clientes-vip/:telefone', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM clientes_vip WHERE telefone = $1', [req.params.telefone]);
    res.json({ vip: r.rows.length > 0, dados: r.rows[0] || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clientes-vip', async (req, res) => {
  const { telefone, nome, observacao } = req.body;
  try {
    await pool.query('INSERT INTO clientes_vip (telefone,nome,observacao,criado_em) VALUES ($1,$2,$3,NOW()) ON CONFLICT (telefone) DO UPDATE SET nome=$2,observacao=$3', [telefone, nome, observacao]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clientes-vip/:telefone', async (req, res) => {
  try { await pool.query('DELETE FROM clientes_vip WHERE telefone = $1', [req.params.telefone]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== NÚMEROS BLOQUEADOS =====
app.get('/api/numeros-bloqueados', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM numeros_bloqueados ORDER BY criado_em DESC')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/numeros-bloqueados', async (req, res) => {
  const { telefone, nome, motivo } = req.body;
  try {
    await pool.query('INSERT INTO numeros_bloqueados (telefone,nome,motivo,criado_em) VALUES ($1,$2,$3,NOW()) ON CONFLICT (telefone) DO UPDATE SET nome=$2,motivo=$3', [telefone, nome, motivo]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/numeros-bloqueados/:telefone', async (req, res) => {
  try { await pool.query('DELETE FROM numeros_bloqueados WHERE telefone = $1', [req.params.telefone]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== FAIXAS DE ENTREGA =====
app.get('/api/faixas-entrega', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM faixas_entrega WHERE ativo = true ORDER BY km_min')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/faixas-entrega', async (req, res) => {
  const { km_min, km_max, preco, descricao } = req.body;
  try {
    await pool.query('INSERT INTO faixas_entrega (km_min,km_max,preco,descricao) VALUES ($1,$2,$3,$4)', [km_min, km_max, preco, descricao]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/faixas-entrega/:id', async (req, res) => {
  try { await pool.query('UPDATE faixas_entrega SET ativo = false WHERE id = $1', [req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== CONFIGURAÇÕES =====
app.get('/api/configuracoes', async (req, res) => {
  try {
    const r = await pool.query('SELECT chave, valor FROM configuracoes ORDER BY chave');
    const config = {};
    r.rows.forEach(row => { config[row.chave] = row.valor; });
    res.json(config);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/configuracoes', async (req, res) => {
  try {
    for (const [chave, valor] of Object.entries(req.body)) {
      await pool.query('INSERT INTO configuracoes (chave,valor) VALUES ($1,$2) ON CONFLICT (chave) DO UPDATE SET valor=$2', [chave, String(valor)]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== MODO AUSÊNCIA =====
app.get('/api/ausencia', async (req, res) => {
  try {
    const r = await pool.query("SELECT valor FROM configuracoes WHERE chave = 'modo_ausencia' LIMIT 1");
    res.json(r.rows.length > 0 ? JSON.parse(r.rows[0].valor) : { ativo: false, mensagem: '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ausencia', async (req, res) => {
  const { ativo, mensagem } = req.body;
  try {
    await pool.query("INSERT INTO configuracoes (chave,valor) VALUES ('modo_ausencia',$1) ON CONFLICT (chave) DO UPDATE SET valor=$1", [JSON.stringify({ ativo, mensagem })]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== CALCULAR FRETE =====
app.post('/api/calcular-frete', async (req, res) => {
  const { endereco_cliente } = req.body;
  try {
    const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(endereco_cliente + ', Apucarana, PR, Brasil')}&format=json&limit=1`;
    const geoRes = await fetch(nominatimUrl, { headers: { 'User-Agent': 'GodoyPadaria/1.0' } });
    const geoData = await geoRes.json();
    if (!geoData || !geoData.length) return res.json({ erro: 'Endereço não encontrado', taxa: null });
    const { lat, lon } = geoData[0];
    const padLat = -23.5505; const padLon = -51.4332;
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${padLon},${padLat};${lon},${lat}?overview=false`;
    const osrmData = await (await fetch(osrmUrl)).json();
    if (osrmData.code !== 'Ok') return res.json({ erro: 'Erro na rota', taxa: null });
    const distanciaKm = osrmData.routes[0].distance / 1000;
    const faixa = await pool.query('SELECT * FROM faixas_entrega WHERE ativo = true AND km_min <= $1 AND km_max > $1 ORDER BY km_min LIMIT 1', [distanciaKm]);
    res.json({ distanciaKm: distanciaKm.toFixed(1), taxa: faixa.rows[0]?.preco || null, faixa: faixa.rows[0] || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== VERIFICAÇÃO DE DISPONIBILIDADE =====
app.post('/api/verificacao', async (req, res) => {
  const { telefone, produto } = req.body;
  try {
    await pool.query(
      "INSERT INTO estado_pedido (telefone, etapa, itens, criado_em, atualizado_em) VALUES ($1, 'aguardando_verificacao', $2, NOW(), NOW()) ON CONFLICT (telefone) DO UPDATE SET etapa = 'aguardando_verificacao', itens = $2, atualizado_em = NOW()",
      [telefone, produto]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/verificacao/pendente', async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM estado_pedido WHERE etapa = 'aguardando_verificacao'");
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/verificacao/:telefone', async (req, res) => {
  try {
    await pool.query("UPDATE estado_pedido SET etapa = 'idle', atualizado_em = NOW() WHERE telefone = $1", [req.params.telefone]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/repasse', async (req, res) => {
  try {
    const r = await pool.query("SELECT telefone FROM estado_pedido WHERE etapa = 'aguardando_verificacao' ORDER BY atualizado_em DESC LIMIT 1");
    res.json(r.rows[0] || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard Godoy na porta ${PORT}`));
