const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const ZAPI_URL = 'https://api.z-api.io/instances/3F0EB5CA0ADBB327C02C169647C2B2C3/token/1EE074A50DF3F4E170483A75/send-text';
const ZAPI_TOKEN = 'F88f02816c1a84f1388071b54e6a17c27S';

async function getConfig(chave) {
  const r = await pool.query('SELECT valor FROM configuracoes WHERE chave = $1', [chave]);
  return r.rows[0]?.valor || null;
}

async function enviarWhatsApp(telefone, mensagem) {
  try {
    await fetch(ZAPI_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Client-Token': ZAPI_TOKEN }, body: JSON.stringify({ phone: telefone, message: mensagem }) });
  } catch (e) { console.error('WA error:', e.message); }
}

async function registrarHistorico(pedidoId, acao, descricao, ant, nov) {
  try { await pool.query('INSERT INTO historico_pedidos (pedido_id,acao,descricao,dados_anteriores,dados_novos) VALUES ($1,$2,$3,$4,$5)', [pedidoId, acao, descricao, JSON.stringify(ant||{}), JSON.stringify(nov||{})]); } catch(e) {}
}

// ===== PEDIDOS =====
app.get('/api/pedidos', async (req, res) => {
  try {
    const { telefone, data, busca, status } = req.query;
    let q = 'SELECT * FROM pedidos WHERE 1=1'; let p = []; let i = 1;
    if (telefone) { q += ` AND telefone=$${i++}`; p.push(telefone); }
    if (data) { q += ` AND DATE(criado_em AT TIME ZONE 'America/Sao_Paulo')=$${i++}`; p.push(data); }
    if (busca) { q += ` AND (nome_cliente ILIKE $${i} OR telefone ILIKE $${i} OR itens ILIKE $${i})`; p.push(`%${busca}%`); i++; }
    if (status && status !== 'todos') { q += ` AND status=$${i++}`; p.push(status); }
    q += ' ORDER BY criado_em DESC LIMIT 300';
    res.json((await pool.query(q, p)).rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/pedidos/:id/status', async (req, res) => {
  const { id } = req.params; const { status } = req.body;
  try {
    const ant = await pool.query('SELECT * FROM pedidos WHERE id=$1', [id]);
    if (!ant.rows[0]) return res.status(404).json({ error: 'Não encontrado' });
    const p = ant.rows[0];
    await pool.query('UPDATE pedidos SET status=$1 WHERE id=$2', [status, id]);
    await registrarHistorico(id, 'status', `${p.status} → ${status}`, { status: p.status }, { status });
    if (status === 'confirmado') await enviarWhatsApp(p.telefone, `✅ *Pagamento confirmado!*\n\nSeu pedido #${p.id} entrou em produção! Avisaremos quando estiver pronto. 😊`);
    if (status === 'pronto') {
      const end = await getConfig('endereco_padaria') || 'R. Aquiles, 231';
      const msg = p.tipo === 'entrega' ? `🎉 *Pedido #${p.id} pronto!*\nEstamos preparando para entrega. Em breve! 🛵` : `🎉 *Pedido #${p.id} pronto para retirada!*\n📍 ${end}`;
      await enviarWhatsApp(p.telefone, msg);
    }
    // Atualiza total_vendas dos produtos
    if (status === 'confirmado' && p.itens) {
      try { await pool.query(`UPDATE produtos SET total_vendas = total_vendas + 1 WHERE nome ILIKE ANY(ARRAY(SELECT unnest(string_to_array($1,',')))) OR $1 ILIKE '%' || nome || '%'`, [p.itens]); } catch(e) {}
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/pedidos/:id/editar', async (req, res) => {
  const { id } = req.params; const body = req.body;
  try {
    const ant = (await pool.query('SELECT * FROM pedidos WHERE id=$1', [id])).rows[0];
    if (!ant) return res.status(404).json({ error: 'Não encontrado' });
    const fields = []; const vals = []; let i = 1;
    const cols = ['nome_cliente','itens','forma_pagamento','valor_total','observacoes','endereco','tipo','status'];
    cols.forEach(c => { if (body[c] !== undefined) { fields.push(`${c}=$${i++}`); vals.push(body[c]); } });
    if (!fields.length) return res.json({ success: true });
    vals.push(id);
    await pool.query(`UPDATE pedidos SET ${fields.join(',')} WHERE id=$${i}`, vals);
    await registrarHistorico(id, 'edicao', 'Editado manualmente', ant, body);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pedidos/:id/historico', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM historico_pedidos WHERE pedido_id=$1 ORDER BY criado_em DESC', [req.params.id])).rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pedidos/parcial', async (req, res) => {
  const { telefone, nome_cliente, itens, observacoes, status } = req.body;
  try {
    const ex = await pool.query("SELECT id FROM pedidos WHERE telefone=$1 AND status='aguardando_horario'", [telefone]);
    if (ex.rows.length) return res.json({ success: true, id: ex.rows[0].id });
    const r = await pool.query('INSERT INTO pedidos (telefone,nome_cliente,itens,observacoes,status,criado_em) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id', [telefone, nome_cliente, itens, observacoes, status||'aguardando_horario']);
    res.json({ success: true, id: r.rows[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pedidos/:id/confirmar-horario', async (req, res) => {
  const { id } = req.params;
  try {
    const p = (await pool.query('SELECT * FROM pedidos WHERE id=$1', [id])).rows[0];
    if (!p) return res.status(404).json({ error: 'Não encontrado' });
    await pool.query("UPDATE pedidos SET status='aguardando_pagamento' WHERE id=$1", [id]);
    await pool.query("UPDATE estado_pedido SET etapa='aguardando_tipo',atualizado_em=NOW() WHERE telefone=$1", [p.telefone]);
    await registrarHistorico(id, 'confirmar_horario', 'Horário confirmado', null, null);
    await enviarWhatsApp(p.telefone, `✅ Ótimas notícias! Conseguimos atender! 😊\n\n📍 Retirada na loja ou entrega?\n\n🏪 *1* — Retirada na loja\n🛵 *2* — Entrega`);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pedidos/:id/cancelar-horario', async (req, res) => {
  const { id } = req.params;
  try {
    const p = (await pool.query('SELECT * FROM pedidos WHERE id=$1', [id])).rows[0];
    if (!p) return res.status(404).json({ error: 'Não encontrado' });
    await pool.query("UPDATE pedidos SET status='cancelado' WHERE id=$1", [id]);
    await pool.query('DELETE FROM estado_pedido WHERE telefone=$1', [p.telefone]);
    await registrarHistorico(id, 'cancelar_horario', 'Horário não disponível', null, null);
    await enviarWhatsApp(p.telefone, `😔 Infelizmente não conseguimos atender no horário solicitado.\n\nNosso prazo mínimo é de 4 horas. Posso remarcar? 😊`);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pedidos/:id/cancelar', async (req, res) => {
  const { id } = req.params; const { motivo } = req.body;
  try {
    const p = (await pool.query('SELECT * FROM pedidos WHERE id=$1', [id])).rows[0];
    if (!p) return res.status(404).json({ error: 'Não encontrado' });
    await pool.query("UPDATE pedidos SET status='cancelado' WHERE id=$1", [id]);
    await pool.query('DELETE FROM estado_pedido WHERE telefone=$1', [p.telefone]);
    await registrarHistorico(id, 'cancelado', motivo||'Cancelado', { status: p.status }, { status: 'cancelado' });
    await enviarWhatsApp(p.telefone, `😔 Seu pedido #${p.id} foi cancelado.${motivo?'\n\nMotivo: '+motivo:''}\n\nQualquer dúvida entre em contato. 😊`);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Stats para kanban
app.get('/api/pedidos/kanban', async (req, res) => {
  try {
    const r = await pool.query(`SELECT status, COUNT(*) as total FROM pedidos WHERE status NOT IN ('cancelado') AND criado_em >= NOW() - INTERVAL '30 days' GROUP BY status`);
    const stats = {}; r.rows.forEach(x => { stats[x.status] = parseInt(x.total); });
    res.json(stats);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== CATEGORIAS =====
app.get('/api/categorias', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM categorias ORDER BY ordem, nome')).rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/categorias', async (req, res) => {
  const { nome, descricao, disponivel, dias_semana, horario_inicio, horario_fim, permite_delivery, permite_retirada, permite_salao, imagem_url, ordem } = req.body;
  try {
    const r = await pool.query('INSERT INTO categorias (nome,descricao,disponivel,dias_semana,horario_inicio,horario_fim,permite_delivery,permite_retirada,permite_salao,imagem_url,ordem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [nome, descricao, disponivel!==false, dias_semana||'{0,1,2,3,4,5,6}', horario_inicio||'06:00', horario_fim||'20:00', permite_delivery!==false, permite_retirada!==false, permite_salao||false, imagem_url, ordem||0]);
    res.json({ success: true, categoria: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/categorias/:id', async (req, res) => {
  const { id } = req.params; const body = req.body;
  try {
    const fields = []; const vals = []; let i = 1;
    const cols = ['nome','descricao','disponivel','dias_semana','horario_inicio','horario_fim','permite_delivery','permite_retirada','permite_salao','imagem_url','ordem'];
    cols.forEach(c => { if (body[c] !== undefined) { fields.push(`${c}=$${i++}`); vals.push(body[c]); } });
    if (!fields.length) return res.json({ success: true });
    vals.push(id);
    await pool.query(`UPDATE categorias SET ${fields.join(',')} WHERE id=$${i}`, vals);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/categorias/:id/disponibilidade', async (req, res) => {
  try { await pool.query('UPDATE categorias SET disponivel=$1 WHERE id=$2', [req.body.disponivel, req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/categorias/:id', async (req, res) => {
  try { await pool.query('DELETE FROM categorias WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== PRODUTOS =====
app.get('/api/produtos', async (req, res) => {
  try {
    const { apenas_disponiveis, categoria_id } = req.query;
    let q = `SELECT p.*, c.nome as categoria_nome FROM produtos p LEFT JOIN categorias c ON p.categoria_id = c.id WHERE 1=1`;
    const params = [];
    if (apenas_disponiveis === 'true') q += ' AND p.disponivel = true';
    if (categoria_id) { q += ` AND p.categoria_id = $${params.length+1}`; params.push(categoria_id); }
    q += ' ORDER BY p.categoria, p.ordem, p.nome';
    res.json((await pool.query(q, params)).rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/produtos/destaques', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM produtos WHERE disponivel=true AND destaque=true ORDER BY total_vendas DESC LIMIT 10')).rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/produtos/mais-vendidos', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM produtos WHERE disponivel=true AND total_vendas > 0 ORDER BY total_vendas DESC LIMIT 8')).rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/produtos', async (req, res) => {
  const { nome, categoria, categoria_id, descricao, preco, unidade, disponivel, imagem_url, ordem, tipo_pedido, permite_delivery, permite_retirada, permite_salao, destaque } = req.body;
  try {
    const r = await pool.query('INSERT INTO produtos (nome,categoria,categoria_id,descricao,preco,unidade,disponivel,imagem_url,ordem,tipo_pedido,permite_delivery,permite_retirada,permite_salao,destaque,criado_em,atualizado_em) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW()) RETURNING *',
      [nome, categoria, categoria_id, descricao, preco, unidade||'unidade', disponivel!==false, imagem_url, ordem||0, tipo_pedido||'ambos', permite_delivery!==false, permite_retirada!==false, permite_salao||false, destaque||false]);
    res.json({ success: true, produto: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/produtos/:id', async (req, res) => {
  const { id } = req.params; const body = req.body;
  try {
    const fields = []; const vals = []; let i = 1;
    const cols = ['nome','categoria','categoria_id','descricao','preco','unidade','disponivel','imagem_url','ordem','tipo_pedido','permite_delivery','permite_retirada','permite_salao','destaque'];
    cols.forEach(c => { if (body[c] !== undefined) { fields.push(`${c}=$${i++}`); vals.push(body[c]); } });
    fields.push('atualizado_em=NOW()');
    vals.push(id);
    await pool.query(`UPDATE produtos SET ${fields.join(',')} WHERE id=$${i}`, vals);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/produtos/:id/disponibilidade', async (req, res) => {
  try { await pool.query('UPDATE produtos SET disponivel=$1,atualizado_em=NOW() WHERE id=$2', [req.body.disponivel, req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/produtos/:id', async (req, res) => {
  try { await pool.query('DELETE FROM produtos WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/produtos/:id/imagem', async (req, res) => {
  const { imagem_base64, tipo } = req.body;
  try {
    await pool.query('UPDATE produtos SET imagem_url=$1,atualizado_em=NOW() WHERE id=$2', [`data:${tipo||'image/jpeg'};base64,${imagem_base64}`, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cardápio para o n8n
app.get('/api/cardapio', async (req, res) => {
  try {
    const produtos = (await pool.query('SELECT p.*, c.nome as cat_nome, c.permite_delivery, c.permite_retirada, c.permite_salao FROM produtos p LEFT JOIN categorias c ON p.categoria_id = c.id WHERE p.disponivel=true ORDER BY p.categoria, p.ordem, p.nome')).rows;
    const categorias = {};
    produtos.forEach(p => {
      const cat = p.categoria || p.cat_nome || 'Geral';
      if (!categorias[cat]) categorias[cat] = [];
      categorias[cat].push(`  - ${p.nome}: R$ ${Number(p.preco).toFixed(2)}/${p.unidade}${p.descricao?' ('+p.descricao+')':''}`);
    });
    const cardapioTexto = Object.entries(categorias).map(([cat, items]) => `${cat}:\n${items.join('\n')}`).join('\n\n');
    res.json({ values: cardapioTexto, produtos });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== COMPLEMENTOS =====
app.get('/api/produtos/:id/complementos', async (req, res) => {
  try {
    const grupos = (await pool.query('SELECT * FROM complementos_grupos WHERE produto_id=$1 ORDER BY ordem', [req.params.id])).rows;
    for (const g of grupos) {
      g.itens = (await pool.query('SELECT * FROM complementos_itens WHERE grupo_id=$1 ORDER BY ordem', [g.id])).rows;
    }
    res.json(grupos);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/complementos/grupos', async (req, res) => {
  const { produto_id, nome, descricao, obrigatorio, min_selecao, max_selecao, ordem } = req.body;
  try {
    const r = await pool.query('INSERT INTO complementos_grupos (produto_id,nome,descricao,obrigatorio,min_selecao,max_selecao,ordem) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [produto_id, nome, descricao, obrigatorio||false, min_selecao||0, max_selecao||1, ordem||0]);
    res.json({ success: true, grupo: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/complementos/grupos/:id', async (req, res) => {
  const { nome, descricao, obrigatorio, min_selecao, max_selecao, ordem } = req.body;
  try {
    await pool.query('UPDATE complementos_grupos SET nome=$1,descricao=$2,obrigatorio=$3,min_selecao=$4,max_selecao=$5,ordem=$6 WHERE id=$7',
      [nome, descricao, obrigatorio, min_selecao, max_selecao, ordem, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/complementos/grupos/:id', async (req, res) => {
  try { await pool.query('DELETE FROM complementos_grupos WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/complementos/itens', async (req, res) => {
  const { grupo_id, nome, descricao, preco_adicional, disponivel, imagem_url, ordem } = req.body;
  try {
    const r = await pool.query('INSERT INTO complementos_itens (grupo_id,nome,descricao,preco_adicional,disponivel,imagem_url,ordem) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [grupo_id, nome, descricao, preco_adicional||0, disponivel!==false, imagem_url, ordem||0]);
    res.json({ success: true, item: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/complementos/itens/:id', async (req, res) => {
  const { nome, descricao, preco_adicional, disponivel, ordem } = req.body;
  try {
    await pool.query('UPDATE complementos_itens SET nome=$1,descricao=$2,preco_adicional=$3,disponivel=$4,ordem=$5 WHERE id=$6',
      [nome, descricao, preco_adicional, disponivel, ordem, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/complementos/itens/:id', async (req, res) => {
  try { await pool.query('DELETE FROM complementos_itens WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== CLIENTES VIP =====
app.get('/api/clientes-vip', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM clientes_vip ORDER BY criado_em DESC')).rows); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/clientes-vip/:telefone', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM clientes_vip WHERE telefone=$1', [req.params.telefone]); res.json({ vip: r.rows.length > 0, dados: r.rows[0]||null }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/clientes-vip', async (req, res) => {
  const { telefone, nome, observacao } = req.body;
  try { await pool.query('INSERT INTO clientes_vip (telefone,nome,observacao,criado_em) VALUES ($1,$2,$3,NOW()) ON CONFLICT (telefone) DO UPDATE SET nome=$2,observacao=$3', [telefone, nome, observacao]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/clientes-vip/:telefone', async (req, res) => {
  try { await pool.query('DELETE FROM clientes_vip WHERE telefone=$1', [req.params.telefone]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== BLOQUEADOS =====
app.get('/api/numeros-bloqueados', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM numeros_bloqueados ORDER BY criado_em DESC')).rows); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/numeros-bloqueados', async (req, res) => {
  const { telefone, nome, motivo } = req.body;
  try { await pool.query('INSERT INTO numeros_bloqueados (telefone,nome,motivo,criado_em) VALUES ($1,$2,$3,NOW()) ON CONFLICT (telefone) DO UPDATE SET nome=$2,motivo=$3', [telefone, nome, motivo]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/numeros-bloqueados/:telefone', async (req, res) => {
  try { await pool.query('DELETE FROM numeros_bloqueados WHERE telefone=$1', [req.params.telefone]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== FAIXAS ENTREGA =====
app.get('/api/faixas-entrega', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM faixas_entrega WHERE ativo=true ORDER BY km_min')).rows); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/faixas-entrega', async (req, res) => {
  const { km_min, km_max, preco, descricao } = req.body;
  try { await pool.query('INSERT INTO faixas_entrega (km_min,km_max,preco,descricao) VALUES ($1,$2,$3,$4)', [km_min, km_max, preco, descricao]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/faixas-entrega/:id', async (req, res) => {
  try { await pool.query('UPDATE faixas_entrega SET ativo=false WHERE id=$1', [req.params.id]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== CONFIGURAÇÕES =====
app.get('/api/configuracoes', async (req, res) => {
  try { const r = await pool.query('SELECT chave,valor FROM configuracoes ORDER BY chave'); const c = {}; r.rows.forEach(x => c[x.chave] = x.valor); res.json(c); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/configuracoes', async (req, res) => {
  try { for (const [k, v] of Object.entries(req.body)) { await pool.query('INSERT INTO configuracoes (chave,valor) VALUES ($1,$2) ON CONFLICT (chave) DO UPDATE SET valor=$2', [k, String(v)]); } res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ausencia', async (req, res) => {
  try { const r = await pool.query("SELECT valor FROM configuracoes WHERE chave='modo_ausencia' LIMIT 1"); res.json(r.rows.length ? JSON.parse(r.rows[0].valor) : { ativo: false, mensagem: '' }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ausencia', async (req, res) => {
  const { ativo, mensagem } = req.body;
  try { await pool.query("INSERT INTO configuracoes (chave,valor) VALUES ('modo_ausencia',$1) ON CONFLICT (chave) DO UPDATE SET valor=$1", [JSON.stringify({ ativo, mensagem })]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== FRETE =====
app.post('/api/calcular-frete', async (req, res) => {
  const { endereco_cliente } = req.body;
  try {
    const geo = await (await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(endereco_cliente+', Apucarana, PR, Brasil')}&format=json&limit=1`, { headers: { 'User-Agent': 'GodoyPadaria/1.0' } })).json();
    if (!geo?.length) return res.json({ erro: 'Endereço não encontrado', taxa: null });
    const { lat, lon } = geo[0];
    const osrm = await (await fetch(`https://router.project-osrm.org/route/v1/driving/-51.4332,-23.5505;${lon},${lat}?overview=false`)).json();
    if (osrm.code !== 'Ok') return res.json({ erro: 'Erro na rota', taxa: null });
    const km = osrm.routes[0].distance / 1000;
    const faixa = (await pool.query('SELECT * FROM faixas_entrega WHERE ativo=true AND km_min<=$1 AND km_max>$1 ORDER BY km_min LIMIT 1', [km])).rows[0];
    res.json({ distanciaKm: km.toFixed(1), taxa: faixa?.preco||null, faixa: faixa||null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== VERIFICAÇÃO =====
app.post('/api/verificacao', async (req, res) => {
  const { telefone, produto } = req.body;
  try { await pool.query("INSERT INTO estado_pedido (telefone,etapa,itens,criado_em,atualizado_em) VALUES ($1,'aguardando_verificacao',$2,NOW(),NOW()) ON CONFLICT (telefone) DO UPDATE SET etapa='aguardando_verificacao',itens=$2,atualizado_em=NOW()", [telefone, produto]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/verificacao/:telefone', async (req, res) => {
  try { await pool.query("UPDATE estado_pedido SET etapa='idle',atualizado_em=NOW() WHERE telefone=$1", [req.params.telefone]); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/repasse', async (req, res) => {
  try { const r = await pool.query("SELECT telefone FROM estado_pedido WHERE etapa='aguardando_verificacao' ORDER BY atualizado_em DESC LIMIT 1"); res.json(r.rows[0]||null); } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== PORTAL PÚBLICO =====
app.get('/api/portal/cardapio', async (req, res) => {
  try {
    const cats = (await pool.query('SELECT * FROM categorias WHERE disponivel=true ORDER BY ordem, nome')).rows;
    for (const cat of cats) {
      cat.produtos = (await pool.query('SELECT id,nome,descricao,preco,unidade,imagem_url,tipo_pedido,permite_delivery,permite_retirada,permite_salao,destaque FROM produtos WHERE disponivel=true AND (categoria=$1 OR categoria_id=$2) ORDER BY destaque DESC,ordem,nome', [cat.nome, cat.id])).rows;
      for (const prod of cat.produtos) {
        prod.complementos = (await pool.query('SELECT g.*,(SELECT json_agg(i.*) FROM complementos_itens i WHERE i.grupo_id=g.id AND i.disponivel=true) as itens FROM complementos_grupos g WHERE g.produto_id=$1 ORDER BY g.ordem', [prod.id])).rows;
      }
    }
    const configuracoes = (await pool.query("SELECT chave,valor FROM configuracoes WHERE chave IN ('endereco_padaria','horario_loja','telefone_padaria','whatsapp_padaria','instagram_padaria','chave_pix')")).rows;
    const config = {}; configuracoes.forEach(c => config[c.chave] = c.valor);
    const maisVendidos = (await pool.query('SELECT * FROM produtos WHERE disponivel=true AND total_vendas > 0 ORDER BY total_vendas DESC LIMIT 6')).rows;
    res.json({ categorias: cats, configuracoes: config, maisVendidos });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/portal/pedido', async (req, res) => {
  const { nome_cliente, telefone, email, itens, observacoes, tipo, endereco, forma_pagamento, valor_total } = req.body;
  try {
    const r = await pool.query('INSERT INTO pedidos (telefone,nome_cliente,itens,observacoes,tipo,endereco,forma_pagamento,valor_total,status,criado_em) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING id',
      [telefone, nome_cliente, JSON.stringify(itens), observacoes, tipo||'retirada', endereco, forma_pagamento, valor_total, 'aguardando_pagamento']);
    const pedidoId = r.rows[0].id;
    const donoTel = await getConfig('telefone_notificacao_dono') || '5543991397163';
    const chavePix = await getConfig('chave_pix') || '07.215.675/0001-05';
    await enviarWhatsApp(telefone, `✅ *Pedido #${pedidoId} recebido pelo portal!*\n\n🛍️ ${typeof itens === 'string' ? itens : JSON.stringify(itens)}\n💳 ${forma_pagamento}\n💰 R$ ${Number(valor_total).toFixed(2)}\n\nEnvie o comprovante Pix para confirmar:\n🔑 ${chavePix}`);
    await enviarWhatsApp(donoTel, `🔔 *NOVO PEDIDO PORTAL #${pedidoId}*\n👤 ${nome_cliente} | 📱 ${telefone}\n🛍️ ${typeof itens === 'string' ? itens : JSON.stringify(itens)}\n💰 R$ ${Number(valor_total).toFixed(2)}\n\nhttps://sublime-insight-production.up.railway.app`);
    res.json({ success: true, pedidoId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Serve portal
app.get('/portal', (req, res) => res.sendFile(path.join(__dirname, 'public', 'portal.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Godoy Dashboard na porta ${PORT}`));
