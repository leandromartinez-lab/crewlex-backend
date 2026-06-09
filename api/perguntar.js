// =====================================================================
// CrewLex · /api/perguntar  (Vercel Serverless Function)
// AGORA com LOGIN (Supabase Auth) e LIMITE do plano grátis.
// Fluxo: valida o login do usuário -> confere/consome o limite do mês
// -> busca as cláusulas certas (buscar_clausulas) -> pede ao Claude
// (Haiku) uma resposta fundamentada SÓ nessas cláusulas, citando fontes.
// DNA: "sem dado fantasma".
//
// Variáveis de ambiente (Vercel):
//   SUPABASE_URL            (ex.: https://xxxx.supabase.co)
//   SUPABASE_SERVICE_ROLE   (service_role key — SÓ no backend)
//   ANTHROPIC_API_KEY       (chave da API da Anthropic)
//   CLAUDE_MODEL            (opcional; default Haiku)
//   ALLOWED_ORIGIN          (opcional; default '*')
//   LIMITE_MENSAL           (opcional; default 10 — perguntas/mês no grátis)
// =====================================================================

const ALLOWED_ORIGIN        = process.env.ALLOWED_ORIGIN || '*';
const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ANTHROPIC_API_KEY     = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL          = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const LIMITE_MENSAL         = parseInt(process.env.LIMITE_MENSAL || '10', 10);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// mês corrente no fuso de Brasília, formato 'YYYY-MM'
function anoMesBR() {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  return s.slice(0, 7);
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Use POST' });

  try {
    // ---- 1) Ler entrada -------------------------------------------------
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = {}; } }
    if (!body || typeof body !== 'object') body = {};

    const pergunta = String(body.pergunta || '').trim();
    const empresa  = String(body.empresa  || 'GOL').toUpperCase();
    const funcao   = String(body.funcao   || 'piloto').toLowerCase();

    if (!pergunta) return res.status(400).json({ erro: 'Pergunta vazia.' });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return res.status(500).json({ erro: 'Backend sem Supabase configurado.' });
    }

    // ---- 2) Login: identificar o usuário pelo token --------------------
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      return res.status(401).json({ erro_login: true, resposta: 'Faça login no CrewLex para usar a consulta.' });
    }
    let userId = null;
    try {
      const uResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { 'apikey': SUPABASE_SERVICE_ROLE, 'Authorization': `Bearer ${token}` }
      });
      if (uResp.ok) {
        const u = await uResp.json();
        userId = u && u.id;
      }
    } catch (e) { /* cai no 401 abaixo */ }
    if (!userId) {
      return res.status(401).json({ erro_login: true, resposta: 'Sua sessão expirou ou é inválida. Faça login novamente.' });
    }

    // ---- 3) Limite do plano grátis (consome 1, de forma atômica) -------
    let usadas = null, limite = LIMITE_MENSAL;
    try {
      const cResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/consumir_pergunta`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_ROLE,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`
        },
        body: JSON.stringify({ p_user_id: userId, p_ano_mes: anoMesBR(), p_limite: LIMITE_MENSAL })
      });
      if (cResp.ok) {
        const arr = await cResp.json();
        const row = Array.isArray(arr) ? arr[0] : arr;
        if (row) {
          limite = (typeof row.limite === 'number') ? row.limite : LIMITE_MENSAL;
          usadas = row.usadas;
          if (row.permitido === false) {
            return res.status(200).json({
              limite_atingido: true,
              usadas: row.usadas,
              limite: limite,
              resposta: `Você já usou suas ${limite} perguntas deste mês no plano grátis. O limite renova no início do próximo mês. Em breve teremos um plano com mais consultas.`,
              fontes: []
            });
          }
        }
      }
      // se a checagem falhar (cResp não-ok), seguimos (fail-open) p/ não travar o usuário
    } catch (e) { /* fail-open */ }

    // ---- 4) Buscar cláusulas (RAG) via RPC do Supabase -----------------
    const rpcResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/buscar_clausulas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`
      },
      body: JSON.stringify({ termo: pergunta, p_empresa: empresa, p_funcao: funcao, limite: 12 })
    });

    if (!rpcResp.ok) {
      const t = await rpcResp.text();
      return res.status(502).json({ erro: 'Falha ao buscar cláusulas.', detalhe: t.slice(0, 300) });
    }
    const clausulas = await rpcResp.json();

    // ---- 5) Sem cláusulas? Resposta honesta, sem gastar IA ------------
    if (!Array.isArray(clausulas) || clausulas.length === 0) {
      return res.status(200).json({
        encontrou: false,
        usadas, limite,
        resposta: 'Não encontrei, na base jurídica do CrewLex, uma cláusula que responda diretamente a essa pergunta para o seu contexto (empresa e função). Tente reformular com outras palavras ou consulte o SNA.',
        fontes: []
      });
    }

    if (!ANTHROPIC_API_KEY) {
      return res.status(200).json({
        encontrou: true,
        usadas, limite,
        resposta: 'Encontrei cláusulas relacionadas, mas a redação automática está indisponível no momento. Veja as fontes abaixo.',
        fontes: clausulas.map(toFonte)
      });
    }

    // ---- 6) Montar contexto e pedir resposta fundamentada ao Claude ---
    const contexto = clausulas.map((c, i) =>
      `[${i + 1}] (${c.fonte} · ${c.documento} · ${c.identificador || 's/ id'})\n` +
      `${c.titulo ? c.titulo + ': ' : ''}${c.texto}`
    ).join('\n\n');

    const system = [
      'Você é o assistente jurídico do CrewLex, especializado em legislação trabalhista e de gerenciamento de fadiga de aeronautas brasileiros.',
      'Responda SOMENTE com base nas CLÁUSULAS fornecidas pelo usuário. NÃO invente, não use conhecimento externo e não suponha valores, prazos ou limites que não estejam no texto. Esse princípio ("sem dado fantasma") é inegociável.',
      'HIERARQUIA DAS NORMAS — use para ORDENAR a resposta. Em matéria trabalhista (escala, folga, descanso/repouso, remuneração, deslocamento, hotel, base, sobreaviso e reserva), o que é acordado prevalece sobre o legislado: a norma que GOVERNA é o ACT da empresa e função do tripulante. Comece a resposta pela cláusula do ACT aplicável; a Lei e a CCT entram como piso ou complemento. Só responda pela Lei/CCT como regra principal se NENHUMA cláusula de ACT da empresa/função tratar do tema.',
      'A Lei é piso mínimo: o ACT não pode oferecer menos que o mínimo legal; havendo conflito, prevalece a condição mais favorável ao tripulante. Em SEGURANÇA OPERACIONAL e fadiga, prevalece o limite MAIS RESTRITIVO (RBAC).',
      'DEFINIÇÕES E DESAMBIGUAÇÃO: termos como descanso, repouso e folga têm definições próprias e DISTINTAS — descanso ocorre DURANTE a jornada (não é repouso nem folga); repouso é o período ininterrupto APÓS a jornada; folga é o período de 24h ou mais, na base contratual, sem prejuízo da remuneração. NÃO trate esses termos como sinônimos. Quando a pergunta envolver um desses conceitos (ou outros termos definidos: sobreaviso, reserva, jornada, tempo de voo, viagem, base contratual etc.), use a definição oficial que estiver nas cláusulas fornecidas e, se houver risco de confusão, esclareça a diferença citando a fonte (ex.: RBAC 117, 117.3).',
      'ESTRUTURA: comece com a resposta direta, baseada na norma que prevalece; em seguida mostre a base citando as fontes; por fim, ressalvas. NÃO inicie a resposta com aviso de "informação insuficiente" quando houver cláusula relevante — só sinalize lacuna se realmente nenhuma cláusula tratar do ponto, e nesse caso seja específico sobre o que falta.',
      'PERGUNTAS DE VÁRIAS PARTES: quando a pergunta tiver mais de uma questão (ex.: "isso é legal? e preciso de 12h de descanso entre reserva e voo?"), NÃO abra a resposta com um "Sim" ou "Não" isolado que valha como veredito de tudo — isso engana, porque cada parte pode ter resposta diferente. Responda cada parte separadamente, deixando claro a qual pergunta cada resposta se refere (ex.: começar pelo ponto, depois "Quanto ao descanso..."). Um "Sim"/"Não" só é permitido quando se referir explicitamente a UMA parte identificada, nunca como abertura ambígua do todo.',
      'Se faltar um valor específico (ex.: número exato de horas) que não esteja em nenhuma cláusula, diga objetivamente o que a norma estabelece e oriente procurar o SNA ou o setor competente da empresa para o detalhe — sem estimar números.',
      'Cite sempre as fontes que usar, pelo identificador e documento (ex.: "Art. 51 da Lei 13.475/2017", "Cláusula 5.19 do ACT GOL Pilotos", "RBAC 117, 117.17").',
      'FORMATO: o app só entende **negrito** e quebras de linha. NÃO use títulos com # ou ##, nem tabelas, nem listas com marcação especial. Escreva em texto corrido, direto e objetivo, em português do Brasil, com destaques apenas em **negrito**. Apresente o que a norma diz; não forneça aconselhamento jurídico definitivo.'
    ].join(' ');

    const userMsg =
      `Contexto do usuário: empresa = ${empresa}, função = ${funcao}.\n\n` +
      `Pergunta: ${pergunta}\n\n` +
      `CLÁUSULAS DISPONÍVEIS (use apenas estas):\n${contexto}`;

    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 700,
        system,
        messages: [{ role: 'user', content: userMsg }]
      })
    });

    if (!aiResp.ok) {
      const t = await aiResp.text();
      return res.status(200).json({
        encontrou: true,
        usadas, limite,
        erro: 'consulta_indisponivel',
        resposta: 'A consulta inteligente está temporariamente indisponível. As cláusulas relacionadas estão listadas abaixo; tente novamente mais tarde.',
        fontes: clausulas.map(toFonte),
        detalhe: t.slice(0, 200)
      });
    }

    const data = await aiResp.json();
    const resposta = (data.content || []).map(b => b.text || '').join('\n').trim();

    return res.status(200).json({
      encontrou: true,
      usadas, limite,
      resposta: resposta || 'Não consegui redigir uma resposta. Veja as fontes abaixo.',
      fontes: clausulas.map(toFonte)
    });

  } catch (e) {
    return res.status(500).json({ erro: 'Erro interno.', detalhe: (e && e.message) || String(e) });
  }
};

function toFonte(c) {
  return { fonte: c.fonte, documento: c.documento, identificador: c.identificador, titulo: c.titulo };
}
