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
  try { const r = await pool.query('SELECT valor FROM configuracoes WHERE chave=$1', [chave]); return r.rows[0]?.valor||null; } catch(e) { return null; }
}
async function enviarWhatsApp(tel, msg) {
  try { await fetch(ZAPI_URL,{method:'POST',headers:{'Content-Type':'application/json','Client-Token':ZAPI_TOKEN},body:JSON.stringify({phone:tel,message:msg})}); } catch(e) { console.error('WA:',e.message); }
}
async function registrarHistorico(pid,acao,desc,ant,nov) {
  try { await pool.query('INSERT INTO historico_pedidos(pedido_id,acao,descricao,dados_anteriores,dados_novos)VALUES($1,$2,$3,$4,$5)',[pid,acao,desc,JSON.stringify(ant||{}),JSON.stringify(nov||{})]); } catch(e) {}
}

// ===== PEDIDOS =====
app.get('/api/pedidos', async (req, res) => {
  try {
    const { telefone, data, busca, status, ordenar } = req.query;
    let q = "SELECT * FROM pedidos WHERE arquivado = FALSE";
    let p = []; let i = 1;
    if (telefone) { q+=` AND telefone=$${i++}`; p.push(telefone); }
    if (data) { q+=` AND DATE(criado_em AT TIME ZONE 'America/Sao_Paulo')=$${i++}`; p.push(data); }
    if (busca) { q+=` AND (nome_cliente ILIKE $${i} OR telefone ILIKE $${i} OR itens ILIKE $${i})`; p.push(`%${busca}%`); i++; }
    if (status && status!=='todos') { q+=` AND status=$${i++}`; p.push(status); }
    q += ordenar==='agendamento' ? ' ORDER BY data_agendamento ASC NULLS LAST, criado_em DESC' : ' ORDER BY criado_em DESC';
    q += ' LIMIT 300';
    res.json((await pool.query(q,p)).rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.patch('/api/pedidos/:id/status', async (req, res) => {
  const {id}=req.params; const {status}=req.body;
  try {
    const ant=(await pool.query('SELECT * FROM pedidos WHERE id=$1',[id])).rows[0];
    if(!ant) return res.status(404).json({error:'Não encontrado'});
    await pool.query('UPDATE pedidos SET status=$1 WHERE id=$2',[status,id]);
    await registrarHistorico(id,'status',`${ant.status} → ${status}`,{status:ant.status},{status});
    if(status==='confirmado') {
      await enviarWhatsApp(ant.telefone,`✅ *Pagamento confirmado!*\n\nSeu pedido #${ant.id} entrou em produção! Avisaremos quando estiver pronto. 😊`);
      // Gera pontos cashback
      if(ant.valor_total) await gerarPontos(ant.telefone,ant.nome_cliente,parseFloat(ant.valor_total),ant.id);
    }
    if(status==='pronto') {
      const end=await getConfig('endereco_padaria')||'R. Aquiles, 231';
      const msg=ant.tipo==='entrega'?`🎉 *Pedido #${ant.id} pronto!*\nEstamos preparando para entrega! 🛵`:`🎉 *Pedido #${ant.id} pronto para retirada!*\n📍 ${end}`;
      await enviarWhatsApp(ant.telefone,msg);
    }
    if(status==='confirmado'&&ant.itens) {
      try { await pool.query(`UPDATE produtos SET total_vendas=total_vendas+1 WHERE $1 ILIKE '%'||nome||'%'`,[ant.itens]); } catch(e) {}
    }
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.patch('/api/pedidos/:id/editar', async (req, res) => {
  const {id}=req.params; const body=req.body;
  try {
    const ant=(await pool.query('SELECT * FROM pedidos WHERE id=$1',[id])).rows[0];
    if(!ant) return res.status(404).json({error:'Não encontrado'});
    const f=[]; const v=[]; let i=1;
    ['nome_cliente','itens','forma_pagamento','valor_total','observacoes','endereco','tipo','status','data_agendamento'].forEach(c=>{if(body[c]!==undefined){f.push(`${c}=$${i++}`);v.push(body[c])}});
    if(!f.length) return res.json({success:true});
    v.push(id);
    await pool.query(`UPDATE pedidos SET ${f.join(',')} WHERE id=$${i}`,v);
    await registrarHistorico(id,'edicao','Editado manualmente',ant,body);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.delete('/api/pedidos/:id', async (req, res) => {
  const {id}=req.params;
  try {
    await pool.query('UPDATE pedidos SET arquivado=TRUE,arquivado_em=NOW() WHERE id=$1',[id]);
    await registrarHistorico(id,'excluido','Excluído manualmente',null,null);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/pedidos/:id/historico', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM historico_pedidos WHERE pedido_id=$1 ORDER BY criado_em DESC',[req.params.id])).rows); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/pedidos/parcial', async (req, res) => {
  const {telefone,nome_cliente,itens,observacoes,status}=req.body;
  try {
    const ex=await pool.query("SELECT id FROM pedidos WHERE telefone=$1 AND status='aguardando_horario'",[telefone]);
    if(ex.rows.length) return res.json({success:true,id:ex.rows[0].id});
    const r=await pool.query('INSERT INTO pedidos(telefone,nome_cliente,itens,observacoes,status,criado_em)VALUES($1,$2,$3,$4,$5,NOW())RETURNING id',[telefone,nome_cliente,itens,observacoes,status||'aguardando_horario']);
    res.json({success:true,id:r.rows[0].id});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/pedidos/:id/confirmar-horario', async (req, res) => {
  const {id}=req.params;
  try {
    const p=(await pool.query('SELECT * FROM pedidos WHERE id=$1',[id])).rows[0];
    if(!p) return res.status(404).json({error:'Não encontrado'});
    await pool.query("UPDATE pedidos SET status='aguardando_pagamento' WHERE id=$1",[id]);
    await pool.query("UPDATE estado_pedido SET etapa='aguardando_tipo',atualizado_em=NOW() WHERE telefone=$1",[p.telefone]);
    await enviarWhatsApp(p.telefone,`✅ Ótimas notícias! Conseguimos atender! 😊\n\n📍 Retirada na loja ou entrega?\n\n🏪 *1* — Retirada\n🛵 *2* — Entrega`);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/pedidos/:id/cancelar-horario', async (req, res) => {
  const {id}=req.params;
  try {
    const p=(await pool.query('SELECT * FROM pedidos WHERE id=$1',[id])).rows[0];
    if(!p) return res.status(404).json({error:'Não encontrado'});
    await pool.query("UPDATE pedidos SET status='cancelado' WHERE id=$1",[id]);
    await pool.query('DELETE FROM estado_pedido WHERE telefone=$1',[p.telefone]);
    await enviarWhatsApp(p.telefone,`😔 Não conseguimos atender no horário solicitado.\n\nNosso prazo mínimo é 4 horas. Posso remarcar? 😊`);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/pedidos/:id/cancelar', async (req, res) => {
  const {id}=req.params; const {motivo}=req.body;
  try {
    const p=(await pool.query('SELECT * FROM pedidos WHERE id=$1',[id])).rows[0];
    if(!p) return res.status(404).json({error:'Não encontrado'});
    await pool.query("UPDATE pedidos SET status='cancelado' WHERE id=$1",[id]);
    await pool.query('DELETE FROM estado_pedido WHERE telefone=$1',[p.telefone]);
    await registrarHistorico(id,'cancelado',motivo||'Cancelado',{status:p.status},{status:'cancelado'});
    await enviarWhatsApp(p.telefone,`😔 Seu pedido #${p.id} foi cancelado.${motivo?'\n\nMotivo: '+motivo:''}\n\nQualquer dúvida entre em contato. 😊`);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Atendimento humano pendente
app.get('/api/atendimento-pendente', async (req, res) => {
  try {
    const r=await pool.query("SELECT ep.*, (SELECT mensagem FROM conversas WHERE telefone=ep.telefone AND role='user' ORDER BY criado_em DESC LIMIT 1) as ultima_mensagem FROM estado_pedido ep WHERE ep.aguardando_atendente=TRUE OR ep.etapa='aguardando_verificacao' ORDER BY ep.atualizado_em ASC");
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/atendimento-pendente/:telefone/liberar', async (req, res) => {
  try {
    await pool.query("UPDATE estado_pedido SET aguardando_atendente=FALSE,etapa='idle',atualizado_em=NOW() WHERE telefone=$1",[req.params.telefone]);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ===== ENTREGADORES =====
app.get('/api/entregadores', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM entregadores ORDER BY ativo DESC,nome')).rows); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/entregadores', async (req, res) => {
  const {nome,telefone}=req.body;
  try {
    const r=await pool.query('INSERT INTO entregadores(nome,telefone)VALUES($1,$2)RETURNING *',[nome,telefone]);
    res.json({success:true,entregador:r.rows[0]});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.patch('/api/entregadores/:id', async (req, res) => {
  const {nome,telefone,ativo}=req.body;
  try {
    const f=[]; const v=[]; let i=1;
    if(nome!==undefined){f.push(`nome=$${i++}`);v.push(nome)}
    if(telefone!==undefined){f.push(`telefone=$${i++}`);v.push(telefone)}
    if(ativo!==undefined){f.push(`ativo=$${i++}`);v.push(ativo)}
    v.push(req.params.id);
    await pool.query(`UPDATE entregadores SET ${f.join(',')} WHERE id=$${i}`,v);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.delete('/api/entregadores/:id', async (req, res) => {
  try { await pool.query('DELETE FROM entregadores WHERE id=$1',[req.params.id]); res.json({success:true}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/entregadores/:id/chamar', async (req, res) => {
  const {pedido_id}=req.body;
  try {
    const ent=(await pool.query('SELECT * FROM entregadores WHERE id=$1',[req.params.id])).rows[0];
    if(!ent) return res.status(404).json({error:'Entregador não encontrado'});
    const ped=(await pool.query('SELECT * FROM pedidos WHERE id=$1',[pedido_id])).rows[0];
    if(!ped) return res.status(404).json({error:'Pedido não encontrado'});
    const msg=`🛵 *NOVO PEDIDO PARA ENTREGA*\n\n📦 *Pedido #${ped.id}*\n👤 Cliente: ${ped.nome_cliente||'—'}\n📱 Telefone: ${ped.telefone}\n📍 Endereço: ${ped.endereco||'—'}\n🛍️ Itens: ${ped.itens||'—'}\n💳 Pagamento: ${ped.forma_pagamento||'—'}\n💰 Valor: R$ ${ped.valor_total?Number(ped.valor_total).toFixed(2):'—'}\n\n✅ Retire na loja e entregue ao cliente!`;
    await enviarWhatsApp(ent.telefone,msg);
    await pool.query('UPDATE entregadores SET total_entregas=total_entregas+1 WHERE id=$1',[req.params.id]);
    await registrarHistorico(pedido_id,'entregador',`Entregador ${ent.nome} chamado`,null,{entregador:ent.nome});
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ===== PONTOS/CASHBACK =====
async function gerarPontos(telefone,nome,valorTotal,pedidoId) {
  try {
    const ativo=await getConfig('cashback_ativo');
    if(ativo!=='true') return;
    const porReal=parseInt(await getConfig('pontos_por_real')||'1');
    const pontos=Math.floor(valorTotal*porReal);
    if(pontos<=0) return;
    await pool.query(`INSERT INTO pontos_cashback(telefone,nome_cliente,pontos,total_gasto)VALUES($1,$2,$3,$4)
      ON CONFLICT(telefone) DO UPDATE SET pontos=pontos_cashback.pontos+$3,total_gasto=pontos_cashback.total_gasto+$4,nome_cliente=$2,atualizado_em=NOW()`,
      [telefone,nome,pontos,valorTotal]);
    await pool.query('INSERT INTO pontos_historico(telefone,acao,pontos,descricao,pedido_id)VALUES($1,$2,$3,$4,$5)',
      [telefone,'ganho',pontos,`Pedido #${pedidoId}`,pedidoId]);
    await pool.query('UPDATE pedidos SET pontos_gerados=$1 WHERE id=$2',[pontos,pedidoId]);
    // Atualiza nível
    const pc=(await pool.query('SELECT pontos FROM pontos_cashback WHERE telefone=$1',[telefone])).rows[0];
    if(pc) {
      const total=pc.pontos;
      const nivel=total>=(await getConfig('nivel_diamante_pontos')||5000)?'diamante':total>=(await getConfig('nivel_ouro_pontos')||2000)?'ouro':total>=(await getConfig('nivel_prata_pontos')||500)?'prata':'bronze';
      await pool.query('UPDATE pontos_cashback SET nivel=$1 WHERE telefone=$2',[nivel,telefone]);
    }
    // Notifica cliente
    await enviarWhatsApp(telefone,`⭐ Você ganhou *${pontos} pontos* neste pedido!\n\nAcumule pontos e troque por descontos na próxima compra. 🎉`);
  } catch(e) { console.error('Pontos:',e.message); }
}

app.get('/api/pontos/:telefone', async (req, res) => {
  try {
    const r=await pool.query('SELECT * FROM pontos_cashback WHERE telefone=$1',[req.params.telefone]);
    res.json(r.rows[0]||{pontos:0,nivel:'bronze',total_gasto:0});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/pontos', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM pontos_cashback ORDER BY pontos DESC LIMIT 100')).rows); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/pontos/:telefone/resgatar', async (req, res) => {
  const {pontos}=req.body;
  try {
    const pc=(await pool.query('SELECT * FROM pontos_cashback WHERE telefone=$1',[req.params.telefone])).rows[0];
    if(!pc||pc.pontos<pontos) return res.status(400).json({error:'Pontos insuficientes'});
    const minimo=parseInt(await getConfig('cashback_minimo_resgate')||'50');
    if(pontos<minimo) return res.status(400).json({error:`Mínimo para resgate: ${minimo} pontos`});
    await pool.query('UPDATE pontos_cashback SET pontos=pontos-$1,atualizado_em=NOW() WHERE telefone=$2',[pontos,req.params.telefone]);
    await pool.query('INSERT INTO pontos_historico(telefone,acao,pontos,descricao)VALUES($1,$2,$3,$4)',[req.params.telefone,'resgate',-pontos,`Resgate de ${pontos} pontos`]);
    const desconto=(pontos/100).toFixed(2);
    res.json({success:true,desconto:`R$ ${desconto}`});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ===== ZONAS DE ENTREGA =====
app.get('/api/zonas-entrega', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM zonas_entrega WHERE ativo=TRUE ORDER BY criado_em')).rows); }
  catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/zonas-entrega', async (req, res) => {
  const {nome,tipo,lat,lng,raio_km,cor}=req.body;
  try {
    const r=await pool.query('INSERT INTO zonas_entrega(nome,tipo,lat,lng,raio_km,cor)VALUES($1,$2,$3,$4,$5,$6)RETURNING *',[nome,tipo,lat,lng,raio_km,cor||'#2d6a4f']);
    res.json({success:true,zona:r.rows[0]});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.patch('/api/zonas-entrega/:id', async (req, res) => {
  const {nome,tipo,lat,lng,raio_km,cor,ativo}=req.body;
  try {
    const f=[]; const v=[]; let i=1;
    if(nome!==undefined){f.push(`nome=$${i++}`);v.push(nome)}
    if(tipo!==undefined){f.push(`tipo=$${i++}`);v.push(tipo)}
    if(lat!==undefined){f.push(`lat=$${i++}`);v.push(lat)}
    if(lng!==undefined){f.push(`lng=$${i++}`);v.push(lng)}
    if(raio_km!==undefined){f.push(`raio_km=$${i++}`);v.push(raio_km)}
    if(cor!==undefined){f.push(`cor=$${i++}`);v.push(cor)}
    if(ativo!==undefined){f.push(`ativo=$${i++}`);v.push(ativo)}
    v.push(req.params.id);
    await pool.query(`UPDATE zonas_entrega SET ${f.join(',')} WHERE id=$${i}`,v);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.delete('/api/zonas-entrega/:id', async (req, res) => {
  try { await pool.query('UPDATE zonas_entrega SET ativo=FALSE WHERE id=$1',[req.params.id]); res.json({success:true}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// ===== RELATÓRIOS =====
app.get('/api/relatorios/vendas', async (req, res) => {
  const {periodo}=req.query;
  const dias=periodo==='7'?7:periodo==='30'?30:periodo==='90'?90:30;
  try {
    const porDia=await pool.query(`SELECT DATE(criado_em AT TIME ZONE 'America/Sao_Paulo') as dia,COUNT(*) as pedidos,COALESCE(SUM(valor_total),0) as receita FROM pedidos WHERE status NOT IN ('cancelado') AND arquivado=FALSE AND criado_em>=NOW()-INTERVAL '${dias} days' GROUP BY dia ORDER BY dia`);
    const porStatus=await pool.query(`SELECT status,COUNT(*) as total FROM pedidos WHERE criado_em>=NOW()-INTERVAL '${dias} days' AND arquivado=FALSE GROUP BY status`);
    const porPgto=await pool.query(`SELECT forma_pagamento,COUNT(*) as total,COALESCE(SUM(valor_total),0) as receita FROM pedidos WHERE status='confirmado' OR status='em_producao' OR status='pronto' OR status='entregue' AND criado_em>=NOW()-INTERVAL '${dias} days' AND arquivado=FALSE GROUP BY forma_pagamento`);
    const totais=await pool.query(`SELECT COUNT(*) as total_pedidos,COALESCE(SUM(valor_total),0) as receita_total,COALESCE(AVG(valor_total),0) as ticket_medio FROM pedidos WHERE status NOT IN ('cancelado') AND arquivado=FALSE AND criado_em>=NOW()-INTERVAL '${dias} days'`);
    res.json({porDia:porDia.rows,porStatus:porStatus.rows,porPgto:porPgto.rows,totais:totais.rows[0]});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/relatorios/produtos', async (req, res) => {
  try {
    const maisVendidos=await pool.query('SELECT nome,categoria,total_vendas,preco FROM produtos WHERE total_vendas>0 ORDER BY total_vendas DESC LIMIT 20');
    const porCategoria=await pool.query(`SELECT categoria,COUNT(*) as qtd_produtos,SUM(total_vendas) as total_vendas FROM produtos GROUP BY categoria ORDER BY total_vendas DESC`);
    res.json({maisVendidos:maisVendidos.rows,porCategoria:porCategoria.rows});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/relatorios/entregas', async (req, res) => {
  try {
    const enderecos=await pool.query(`SELECT endereco,COUNT(*) as total FROM pedidos WHERE tipo='entrega' AND endereco IS NOT NULL AND arquivado=FALSE GROUP BY endereco ORDER BY total DESC LIMIT 30`);
    const porTipo=await pool.query(`SELECT tipo,COUNT(*) as total FROM pedidos WHERE arquivado=FALSE GROUP BY tipo`);
    const entregadores=await pool.query('SELECT nome,telefone,total_entregas FROM entregadores ORDER BY total_entregas DESC');
    res.json({enderecos:enderecos.rows,porTipo:porTipo.rows,entregadores:entregadores.rows});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ===== CATEGORIAS =====
app.get('/api/categorias', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM categorias ORDER BY ordem,nome')).rows); } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/categorias', async (req, res) => {
  const {nome,descricao,disponivel,dias_semana,horario_inicio,horario_fim,permite_delivery,permite_retirada,permite_salao,imagem_url,ordem}=req.body;
  try {
    const r=await pool.query('INSERT INTO categorias(nome,descricao,disponivel,dias_semana,horario_inicio,horario_fim,permite_delivery,permite_retirada,permite_salao,imagem_url,ordem)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)RETURNING *',
      [nome,descricao,disponivel!==false,dias_semana||'{0,1,2,3,4,5,6}',horario_inicio||'06:00',horario_fim||'20:00',permite_delivery!==false,permite_retirada!==false,permite_salao||false,imagem_url,ordem||0]);
    res.json({success:true,categoria:r.rows[0]});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.patch('/api/categorias/:id', async (req, res) => {
  const f=[]; const v=[]; let i=1;
  ['nome','descricao','disponivel','dias_semana','horario_inicio','horario_fim','permite_delivery','permite_retirada','permite_salao','imagem_url','ordem'].forEach(c=>{if(req.body[c]!==undefined){f.push(`${c}=$${i++}`);v.push(req.body[c])}});
  if(!f.length) return res.json({success:true}); v.push(req.params.id);
  try { await pool.query(`UPDATE categorias SET ${f.join(',')} WHERE id=$${i}`,v); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.patch('/api/categorias/:id/disponibilidade', async (req, res) => {
  try { await pool.query('UPDATE categorias SET disponivel=$1 WHERE id=$2',[req.body.disponivel,req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/categorias/:id', async (req, res) => {
  try { await pool.query('DELETE FROM categorias WHERE id=$1',[req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

// ===== PRODUTOS =====
app.get('/api/produtos', async (req, res) => {
  try {
    const {apenas_disponiveis,categoria_id}=req.query;
    let q=`SELECT p.*,c.nome as categoria_nome FROM produtos p LEFT JOIN categorias c ON p.categoria_id=c.id WHERE 1=1`;
    const params=[];
    if(apenas_disponiveis==='true') q+=' AND p.disponivel=true';
    if(categoria_id){q+=` AND p.categoria_id=$${params.length+1}`;params.push(categoria_id)}
    q+=' ORDER BY p.categoria,p.ordem,p.nome';
    res.json((await pool.query(q,params)).rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/produtos', async (req, res) => {
  const {nome,categoria,categoria_id,descricao,preco,unidade,disponivel,imagem_url,ordem,tipo_pedido,permite_delivery,permite_retirada,permite_salao,destaque}=req.body;
  try {
    const r=await pool.query('INSERT INTO produtos(nome,categoria,categoria_id,descricao,preco,unidade,disponivel,imagem_url,ordem,tipo_pedido,permite_delivery,permite_retirada,permite_salao,destaque,criado_em,atualizado_em)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())RETURNING *',
      [nome,categoria,categoria_id,descricao,preco,unidade||'unidade',disponivel!==false,imagem_url,ordem||0,tipo_pedido||'ambos',permite_delivery!==false,permite_retirada!==false,permite_salao||false,destaque||false]);
    res.json({success:true,produto:r.rows[0]});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.patch('/api/produtos/:id', async (req, res) => {
  const f=[]; const v=[]; let i=1;
  ['nome','categoria','categoria_id','descricao','preco','unidade','disponivel','imagem_url','ordem','tipo_pedido','permite_delivery','permite_retirada','permite_salao','destaque'].forEach(c=>{if(req.body[c]!==undefined){f.push(`${c}=$${i++}`);v.push(req.body[c])}});
  f.push('atualizado_em=NOW()'); v.push(req.params.id);
  try { await pool.query(`UPDATE produtos SET ${f.join(',')} WHERE id=$${i}`,v); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.patch('/api/produtos/:id/disponibilidade', async (req, res) => {
  try { await pool.query('UPDATE produtos SET disponivel=$1,atualizado_em=NOW() WHERE id=$2',[req.body.disponivel,req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/produtos/:id', async (req, res) => {
  try { await pool.query('DELETE FROM produtos WHERE id=$1',[req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/produtos/:id/imagem', async (req, res) => {
  const {imagem_base64,tipo}=req.body;
  try { await pool.query('UPDATE produtos SET imagem_url=$1,atualizado_em=NOW() WHERE id=$2',[`data:${tipo||'image/jpeg'};base64,${imagem_base64}`,req.params.id]); res.json({success:true}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// Cardápio para n8n e portal
app.get('/api/cardapio', async (req, res) => {
  try {
    const prods=(await pool.query('SELECT p.*,c.nome as cat_nome FROM produtos p LEFT JOIN categorias c ON p.categoria_id=c.id WHERE p.disponivel=true ORDER BY p.categoria,p.ordem,p.nome')).rows;
    const cats={}; prods.forEach(p=>{const c=p.categoria||p.cat_nome||'Geral';if(!cats[c])cats[c]=[];cats[c].push(`  - ${p.nome}: R$ ${Number(p.preco).toFixed(2)}/${p.unidade}${p.descricao?' ('+p.descricao+')':''}`);});
    res.json({values:Object.entries(cats).map(([c,i])=>`${c}:\n${i.join('\n')}`).join('\n\n'),produtos:prods});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ===== COMPLEMENTOS =====
app.get('/api/produtos/:id/complementos', async (req, res) => {
  try {
    const g=(await pool.query('SELECT * FROM complementos_grupos WHERE produto_id=$1 ORDER BY ordem',[req.params.id])).rows;
    for(const x of g) x.itens=(await pool.query('SELECT * FROM complementos_itens WHERE grupo_id=$1 ORDER BY ordem',[x.id])).rows;
    res.json(g);
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/complementos/grupos', async (req, res) => {
  const {produto_id,nome,descricao,obrigatorio,min_selecao,max_selecao,ordem}=req.body;
  try { const r=await pool.query('INSERT INTO complementos_grupos(produto_id,nome,descricao,obrigatorio,min_selecao,max_selecao,ordem)VALUES($1,$2,$3,$4,$5,$6,$7)RETURNING *',[produto_id,nome,descricao,obrigatorio||false,min_selecao||0,max_selecao||1,ordem||0]); res.json({success:true,grupo:r.rows[0]}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/complementos/grupos/:id', async (req, res) => {
  try { await pool.query('DELETE FROM complementos_grupos WHERE id=$1',[req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/complementos/itens', async (req, res) => {
  const {grupo_id,nome,descricao,preco_adicional,disponivel,ordem}=req.body;
  try { const r=await pool.query('INSERT INTO complementos_itens(grupo_id,nome,descricao,preco_adicional,disponivel,ordem)VALUES($1,$2,$3,$4,$5,$6)RETURNING *',[grupo_id,nome,descricao,preco_adicional||0,disponivel!==false,ordem||0]); res.json({success:true,item:r.rows[0]}); } catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/complementos/itens/:id', async (req, res) => {
  try { await pool.query('DELETE FROM complementos_itens WHERE id=$1',[req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error:e.message}); }
});

// ===== CLIENTES VIP =====
app.get('/api/clientes-vip',async(req,res)=>{try{res.json((await pool.query('SELECT * FROM clientes_vip ORDER BY criado_em DESC')).rows)}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/clientes-vip/:telefone',async(req,res)=>{try{const r=await pool.query('SELECT * FROM clientes_vip WHERE telefone=$1',[req.params.telefone]);res.json({vip:r.rows.length>0,dados:r.rows[0]||null})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/clientes-vip',async(req,res)=>{const{telefone,nome,observacao}=req.body;try{await pool.query('INSERT INTO clientes_vip(telefone,nome,observacao,criado_em)VALUES($1,$2,$3,NOW())ON CONFLICT(telefone)DO UPDATE SET nome=$2,observacao=$3',[telefone,nome,observacao]);res.json({success:true})}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/clientes-vip/:telefone',async(req,res)=>{try{await pool.query('DELETE FROM clientes_vip WHERE telefone=$1',[req.params.telefone]);res.json({success:true})}catch(e){res.status(500).json({error:e.message})}});

// ===== BLOQUEADOS =====
app.get('/api/numeros-bloqueados',async(req,res)=>{try{res.json((await pool.query('SELECT * FROM numeros_bloqueados ORDER BY criado_em DESC')).rows)}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/numeros-bloqueados',async(req,res)=>{const{telefone,nome,motivo}=req.body;try{await pool.query('INSERT INTO numeros_bloqueados(telefone,nome,motivo,criado_em)VALUES($1,$2,$3,NOW())ON CONFLICT(telefone)DO UPDATE SET nome=$2,motivo=$3',[telefone,nome,motivo]);res.json({success:true})}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/numeros-bloqueados/:telefone',async(req,res)=>{try{await pool.query('DELETE FROM numeros_bloqueados WHERE telefone=$1',[req.params.telefone]);res.json({success:true})}catch(e){res.status(500).json({error:e.message})}});

// ===== FAIXAS ENTREGA =====
app.get('/api/faixas-entrega',async(req,res)=>{try{res.json((await pool.query('SELECT * FROM faixas_entrega WHERE ativo=true ORDER BY km_min')).rows)}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/faixas-entrega',async(req,res)=>{const{km_min,km_max,preco,descricao}=req.body;try{await pool.query('INSERT INTO faixas_entrega(km_min,km_max,preco,descricao)VALUES($1,$2,$3,$4)',[km_min,km_max,preco,descricao]);res.json({success:true})}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/faixas-entrega/:id',async(req,res)=>{try{await pool.query('UPDATE faixas_entrega SET ativo=false WHERE id=$1',[req.params.id]);res.json({success:true})}catch(e){res.status(500).json({error:e.message})}});

// ===== CONFIGURAÇÕES =====
app.get('/api/configuracoes',async(req,res)=>{try{const r=await pool.query('SELECT chave,valor FROM configuracoes ORDER BY chave');const c={};r.rows.forEach(x=>c[x.chave]=x.valor);res.json(c)}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/configuracoes',async(req,res)=>{try{for(const[k,v]of Object.entries(req.body)){await pool.query('INSERT INTO configuracoes(chave,valor)VALUES($1,$2)ON CONFLICT(chave)DO UPDATE SET valor=$2',[k,String(v)])}res.json({success:true})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/ausencia',async(req,res)=>{try{const r=await pool.query("SELECT valor FROM configuracoes WHERE chave='modo_ausencia' LIMIT 1");res.json(r.rows.length?JSON.parse(r.rows[0].valor):{ativo:false,mensagem:''})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/ausencia',async(req,res)=>{const{ativo,mensagem}=req.body;try{await pool.query("INSERT INTO configuracoes(chave,valor)VALUES('modo_ausencia',$1)ON CONFLICT(chave)DO UPDATE SET valor=$1",[JSON.stringify({ativo,mensagem})]);res.json({success:true})}catch(e){res.status(500).json({error:e.message})}});

// ===== FRETE =====
app.post('/api/calcular-frete',async(req,res)=>{const{endereco_cliente}=req.body;try{const geo=await(await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(endereco_cliente+', Apucarana, PR, Brasil')}&format=json&limit=1`,{headers:{'User-Agent':'GodoyPadaria/1.0'}})).json();if(!geo?.length)return res.json({erro:'Endereço não encontrado',taxa:null});const{lat,lon}=geo[0];const osrm=await(await fetch(`https://router.project-osrm.org/route/v1/driving/-51.4332,-23.5505;${lon},${lat}?overview=false`)).json();if(osrm.code!=='Ok')return res.json({erro:'Erro na rota',taxa:null});const km=osrm.routes[0].distance/1000;const f=(await pool.query('SELECT * FROM faixas_entrega WHERE ativo=true AND km_min<=$1 AND km_max>$1 ORDER BY km_min LIMIT 1',[km])).rows[0];res.json({distanciaKm:km.toFixed(1),taxa:f?.preco||null,faixa:f||null})}catch(e){res.status(500).json({error:e.message})}});

// ===== VERIFICAÇÃO =====
app.post('/api/verificacao',async(req,res)=>{const{telefone,produto}=req.body;try{await pool.query("INSERT INTO estado_pedido(telefone,etapa,itens,criado_em,atualizado_em)VALUES($1,'aguardando_verificacao',$2,NOW(),NOW())ON CONFLICT(telefone)DO UPDATE SET etapa='aguardando_verificacao',itens=$2,atualizado_em=NOW()",[telefone,produto]);res.json({success:true})}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/verificacao/:telefone',async(req,res)=>{try{await pool.query("UPDATE estado_pedido SET etapa='idle',atualizado_em=NOW() WHERE telefone=$1",[req.params.telefone]);res.json({success:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/repasse',async(req,res)=>{try{const r=await pool.query("SELECT telefone FROM estado_pedido WHERE etapa='aguardando_verificacao' ORDER BY atualizado_em DESC LIMIT 1");res.json(r.rows[0]||null)}catch(e){res.status(500).json({error:e.message})}});

// ===== PORTAL PÚBLICO =====
app.get('/api/portal/cardapio',async(req,res)=>{
  try{
    const cats=(await pool.query('SELECT * FROM categorias WHERE disponivel=true ORDER BY ordem,nome')).rows;
    for(const c of cats){c.produtos=(await pool.query('SELECT id,nome,descricao,preco,unidade,imagem_url,tipo_pedido,permite_delivery,permite_retirada,permite_salao,destaque FROM produtos WHERE disponivel=true AND(categoria=$1 OR categoria_id=$2)ORDER BY destaque DESC,ordem,nome',[c.nome,c.id])).rows;for(const p of c.produtos){p.complementos=(await pool.query('SELECT g.*,(SELECT json_agg(i.*)FROM complementos_itens i WHERE i.grupo_id=g.id AND i.disponivel=true)as itens FROM complementos_grupos g WHERE g.produto_id=$1 ORDER BY g.ordem',[p.id])).rows;}}
    const cfg=(await pool.query("SELECT chave,valor FROM configuracoes WHERE chave IN('endereco_padaria','horario_loja','telefone_padaria','whatsapp_padaria','chave_pix','logo_url','logo_nome','cashback_ativo','pontos_por_real','cashback_percentual')")).rows;
    const config={};cfg.forEach(c=>config[c.chave]=c.valor);
    const mv=(await pool.query('SELECT * FROM produtos WHERE disponivel=true AND total_vendas>0 ORDER BY total_vendas DESC LIMIT 6')).rows;
    res.json({categorias:cats,configuracoes:config,maisVendidos:mv});
  }catch(e){res.status(500).json({error:e.message})}
});

app.post('/api/portal/pedido',async(req,res)=>{
  const{nome_cliente,telefone,email,itens,observacoes,tipo,endereco,forma_pagamento,valor_total}=req.body;
  try{
    const r=await pool.query('INSERT INTO pedidos(telefone,nome_cliente,itens,observacoes,tipo,endereco,forma_pagamento,valor_total,status,criado_em)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())RETURNING id',[telefone,nome_cliente,JSON.stringify(itens),observacoes,tipo||'retirada',endereco,forma_pagamento,valor_total,'aguardando_pagamento']);
    const pid=r.rows[0].id;
    const dono=await getConfig('telefone_notificacao_dono')||'5543991397163';
    const pix=await getConfig('chave_pix')||'07.215.675/0001-05';
    await enviarWhatsApp(telefone,`✅ *Pedido #${pid} recebido!*\n\n🛍️ ${typeof itens==='string'?itens:itens.map(i=>`${i.qtd}x ${i.nome}`).join(', ')}\n💳 ${forma_pagamento}\n💰 R$ ${Number(valor_total).toFixed(2)}\n\nEnvie o comprovante Pix:\n🔑 ${pix}`);
    await enviarWhatsApp(dono,`🔔 *NOVO PEDIDO PORTAL #${pid}*\n👤 ${nome_cliente} | 📱 ${telefone}\n💰 R$ ${Number(valor_total).toFixed(2)}\n\nhttps://sublime-insight-production.up.railway.app`);
    res.json({success:true,pedidoId:pid});
  }catch(e){res.status(500).json({error:e.message})}
});

app.get('/portal',(req,res)=>res.sendFile(path.join(__dirname,'public','portal.html')));

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Godoy na porta ${PORT}`));
