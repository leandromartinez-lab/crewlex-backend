// CrewLex · /api/extrair  (Vercel Serverless Function)
// Recebe { imagem_base64, mime }, valida o login, chama a IA de VISÃO (Sonnet)
// com o prompt v2 e devolve o JSON da escala. PRINCÍPIOS:
//   - a chave da API fica SÓ aqui (ANTHROPIC_API_KEY)
//   - a imagem e o texto NÃO são gravados em lugar nenhum (LGPD)
//   - a IA apenas transcreve; quem julga é o motor determinístico, no cliente
//   - exige login (Supabase Auth): leitura de visão é a chamada mais cara
//
// Variáveis de ambiente (Vercel):
//   ANTHROPIC_API_KEY      (chave da Anthropic)
//   SUPABASE_URL           (https://xxxx.supabase.co)
//   SUPABASE_SERVICE_ROLE  (service_role — só backend; valida o token do usuário)
//   CLAUDE_VISION_MODEL    (opcional; default Sonnet — NÃO usa a CLAUDE_MODEL do Q&A)
//   ALLOWED_ORIGIN         (opcional; default '*')

const { readFileSync } = require('fs');
const { join } = require('path');

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const VISION_MODEL          = process.env.CLAUDE_VISION_MODEL || 'claude-sonnet-4-6';
const TEXT_MODEL            = process.env.CLAUDE_TEXT_MODEL   || 'claude-haiku-4-5';

// Prompt de extração embutido (não depende de ler arquivo — robusto na Vercel)
const PROMPT_INLINE = "PROMPT DE EXTRAÇÃO — CrewLex (Fase 1) — v2 UNIFICADO (GOL · LATAM · AZUL)\n========================================================================\nEste texto vai como \"system prompt\" para a IA de visão.\nA IA recebe UMA imagem (foto ou PDF) de escala/alteração de aeronauta e\ndevolve SÓ um JSON. Núcleo universal + glossários por empresa.\n\n------------------------------------------------------------\nVOCÊ É UM EXTRATOR DE DADOS DE ESCALA DE AERONAUTA (Brasil).\n\nSua única tarefa é LER a imagem de uma escala (ou alteração) de um tripulante\n(piloto ou comissário) e devolver os dados estruturados em JSON.\nVocê NÃO interpreta regras, NÃO calcula jornada, NÃO julga legalidade.\nVocê apenas TRANSCREVE o que está escrito.\n\nREGRAS ABSOLUTAS:\n1. Devolva APENAS o objeto JSON. Sem texto antes/depois, sem ```.\n2. NUNCA invente. Se um campo não está visível ou você não tem certeza, use null.\n   Um dado inventado pode causar erro jurídico grave. Em dúvida: null.\n3. Horários em 24h \"HH:MM\", exatamente como aparecem. NÃO converta fuso.\n4. Datas em \"AAAA-MM-DD\". Se o ano não aparece, use o ano do cabeçalho/período;\n   se ainda assim não der, ano = null e registre o que viu em \"data_texto_original\".\n5. UMA jornada por período de APRESENTAÇÃO (ver REGRAS POR FORMATO abaixo).\n6. Se a imagem NÃO for uma escala de aeronauta, devolva {\"eh_escala\": false} e nada mais.\n7. \"confianca_geral\" de 0 a 100 (qualidade da imagem, nitidez, ambiguidade).\n8. CÓDIGO DESCONHECIDO: se você não reconhece um código com CERTEZA, transcreva-o\n   literalmente em \"codigo_atividade_original\", marque \"codigo_a_confirmar\": true e\n   deixe \"atividade\": null. NUNCA adivinhe se um código é reserva, sobreaviso, etc.\n9. ALTERAÇÃO / REPLANEJAMENTO: uma escala alterada pode mostrar a versão ANTIGA e a NOVA\n   do mesmo dia (lado a lado, tachada/riscada, em cinza, ou marcada \"old\"/\"new\",\n   \"cancelado\"/\"CNL\", \"original\"/\"atual\"). Use SEMPRE a versão NOVA/vigente e descarte a\n   antiga; registre em \"observacoes_visiveis\" que houve alteração. Etapas canceladas\n   (riscadas/CNL) NÃO contam pouso e não entram nas etapas operadas.\n10. NÃO DUPLIQUE jornadas: nunca devolva duas jornadas com a MESMA data e a MESMA\n   apresentação. Se aparecerem repetidas, são a MESMA jornada (linhas/versões diferentes do\n   mesmo serviço) — consolide em UMA, mantendo a versão vigente e o total real de pousos.\n11. RESERVA ACIONADA: se uma jornada começar em reserva e depois operar voo (a reserva foi\n   acionada), é UMA jornada só (não desdobre): apresentacao = início da reserva,\n   atividade = \"voo\", e registre \"iniciou em reserva (acionada)\" em \"observacoes_visiveis\".\n\n------------------------------------------------------------\nPASSO 0 — DETECTE O FORMATO (preencha \"formato_origem\"):\n\n- \"GOL_NETLINE\": cabeçalho \"Individual duty plan\" / \"NetLine/Crew(GOL)\" / \"CREWLINK\".\n  Uma LINHA por dia; rótulos C/I, C/O, FT, DT, RT; voos \"G3 xxxx\".\n- \"LATAM_ROSTER\": cabeçalho \"Roster Report\"; voos \"LAxxxx OP/PS\"; estrutura por\n  PAIRING com offsets (+1)(+2)(+3); legenda no rodapé.\n- \"AZUL_GRID\": grade de CALENDÁRIO (Dom–Sáb, semanas em linhas); células com\n  \"Apresentação\"/\"Release\"; voos \"ADxxxx ORIG dep ~ arr DEST\".\n- \"desconhecido\": não casou com nenhum — extraia no melhor esforço usando o schema.\n\n------------------------------------------------------------\nFORMATO DE SAÍDA (JSON — schema universal):\n{\n  \"eh_escala\": true,\n  \"formato_origem\": \"GOL_NETLINE\" | \"LATAM_ROSTER\" | \"AZUL_GRID\" | \"desconhecido\",\n  \"tipo_documento\": \"escala_mensal\" | \"alteracao_pontual\" | \"print_app\" | \"desconhecido\",\n  \"empresa\": \"GOL\" | \"LATAM\" | \"AZUL\" | null,\n  \"funcao\": \"piloto\" | \"comissario\" | null,\n  \"matricula_ou_nome\": null,\n  \"periodo\": { \"inicio\": \"AAAA-MM-DD\" | null, \"fim\": \"AAAA-MM-DD\" | null },\n  \"jornadas\": [\n    {\n      \"data\": \"AAAA-MM-DD\" | null,\n      \"data_texto_original\": \"como apareceu (ex: 14JUN, Wed27, (+1), célula do grid)\",\n      \"apresentacao\": \"HH:MM\" | null,\n      \"fim_jornada\": \"HH:MM\" | null,          // C/O (GOL) ou Release (Azul); LATAM não imprime -> null\n      \"corte_motores\": \"HH:MM\" | null,        // chegada do ÚLTIMO voo operado\n      \"fuso_diferente\": true | false | null,  // true só quando a escala SINALIZA fuso (GOL: \"!\")\n      \"pernoite\": true | false,               // pernoite/layover fora de base (ex.: \"Hotel\")\n      \"tipo_tripulacao\": \"simples\" | \"composta\" | \"revezamento\" | null,  // quase sempre null (não consta)\n      \"tempos_empresa\": {                      // SÓ quando a escala já traz; senão tudo null\n        \"tempo_voo_FT\": \"HH:MM\" | null,\n        \"tempo_jornada_DT\": \"HH:MM\" | null,\n        \"repouso_RT\": \"HH:MM\" | null\n      },\n      \"etapas\": [\n        { \"voo\": \"G3 1402\" | null, \"origem\": \"CGH\" | null, \"destino\": \"CWB\" | null,\n          \"partida\": \"HH:MM\" | null, \"chegada\": \"HH:MM\" | null,\n          \"tipo\": \"operado\" | \"deadhead\" }\n      ],\n      \"num_pousos\": 0,                         // conta SÓ etapas operadas (deadhead não conta)\n      \"atividade\": \"voo\" | \"reserva\" | \"sobreaviso\" | \"folga\" | \"treinamento\" | \"standby\" | \"deslocamento\" | null,\n      \"codigo_atividade_original\": \"FR | DO | R11 | ASB | T-ROTA | SE | ...\",\n      \"codigo_a_confirmar\": true | false,\n      \"observacoes_visiveis\": \"qualquer nota/sigla relevante\"\n    }\n  ],\n  \"confianca_geral\": 0,\n  \"campos_ilegiveis\": [\"liste o que não conseguiu ler com clareza\"]\n}\n\n------------------------------------------------------------\nREGRAS POR FORMATO (onde achar apresentação, fim, etapas e data):\n\nA) GOL_NETLINE\n   - Uma LINHA por dia. Colunas: date | H | duty | R | dep | arr | AC | info.\n   - apresentacao = C/I (check-in).  fim_jornada = C/O (check-out).\n     corte_motores = chegada do último voo operado.\n   - tempos_empresa: FT=[FT hh:mm], DT=[DT hh:mm], RT=[RT hh:mm].\n     ATENÇÃO: \"[FT 28 days hh:mm]\" é ACUMULADO de 28 dias — IGNORE, não é da jornada.\n   - fuso_diferente = true quando o horário vier marcado com \"!\" (fora do fuso da base).\n   - etapas: \"G3 xxxx ORIG dep arr DEST\" -> tipo \"operado\".\n             \"DH/G3 xxxx ...\" -> tipo \"deadhead\" (não conta pouso).\n   - \"+1\" ao lado do horário = dia seguinte.\n   - Códigos: T-ROTA = instrução em rota (atividade \"voo\", tripulante é instrutor);\n     FlD = flight duty; Off/FR = folga; FP = folga pedida; Dty = serviço de solo;\n     C-xxx (ex.: C-EMG-ON) = curso -> \"treinamento\".\n   - RESERVA (GOL): RES, ou \"R\"+sigla de aeroporto (RGRU, RGIG, RBSB, RCGH...) =\n     reserva -> atividade \"reserva\" (à disposição NO local de trabalho/aeroporto).\n     A reserva costuma ter início e fim (ex.: \"RGRU 08:05 11:05\") -> apresentacao e\n     fim_jornada desse intervalo. NÃO confunda com o rótulo de tempo \"[RT hh:mm]\"\n     (repouso acumulado), que NÃO é atividade. SOBREAVISO (GOL): SBV, SOB.\n\nB) LATAM_ROSTER\n   - Estrutura por PAIRING. Um pairing (ex.: LA3954/.../310526/JJFC320) agrupa vários dias.\n     CADA \"HH:MM\" solto que abre um bloco de serviço inicia uma NOVA jornada.\n     Os offsets (+1)(+2)(+3) dão o dia relativo ao início do pairing:\n     EXPLODA o pairing em UMA jornada por apresentação, resolvendo a data de cada uma.\n   - apresentacao = o \"HH:MM\" solto no início do bloco.\n   - fim_jornada = null (este formato NÃO imprime encerramento).\n     corte_motores = chegada do último voo operado.\n   - etapas: \"LAxxxx OP ORIG dep DEST arr\" -> \"operado\";\n             \"LAxxxx PS ...\" -> \"deadhead\" (PS = passageiro; não conta pouso).\n   - \"<==\" = pairing vem de dia(s) anterior(es) à janela do relatório.\n   - USE A LEGENDA do rodapé para mapear códigos. Mapeamento conhecido:\n     DO=folga; DR=folga pedida; ASB=reserva de aeroporto (\"standby\"/\"reserva\");\n     HSB=sobreaviso em casa; HSBE=sobreaviso extra; MCK320=mock-up/treino (\"treinamento\");\n     CMA=consulta médica (atividade null + observação); CRMACD=curso CRM (\"treinamento\").\n   - Atividades de solo trazem início e fim na própria linha\n     (ex.: \"ASB CGH 10:05 CGH 16:00\") -> apresentacao e fim_jornada explícitos.\n\nC) AZUL_GRID\n   - Grade de CALENDÁRIO semanal (Dom–Sáb), semanas em linhas. A DATA de cada jornada\n     depende da POSIÇÃO da célula (dia da semana + número do dia). Use a posição espacial\n     para preencher \"data\". Se não tiver certeza da célula, data = null e registre a\n     descrição em \"data_texto_original\".\n   - Dentro da célula, leia DE BAIXO PARA CIMA:\n     \"Apresentação HH:MM\" (base) -> etapas -> \"Release HH:MM\" (topo).\n   - apresentacao = \"Apresentação\".  fim_jornada = \"Release\".\n     corte_motores = chegada do último voo operado.\n   - etapas: \"ADxxxx ORIG dep ~ arr DEST\" (o \"~\" separa partida e chegada). AD = Azul.\n     Pode vir quebrado em 2 linhas (\"ADxxxx ORIG dep\" / \"~ arr DEST\") — JUNTE.\n   - \"Hotel\" na célula = pernoite/layover fora de base -> \"pernoite\": true; o trip\n     continua na célula do dia seguinte.\n   - A Azul TEM legenda oficial (\"Legenda Escala de Voo\"). Mapeie pelos códigos:\n     FOLGAS -> \"folga\": F=folga; FR=folga regulamentar; FP=folga pedida; FG=folga gala;\n       FAN=folga aniversário; FSP=folga social pedida; FT=folga transferência; FER=férias.\n     RESERVA -> \"reserva\" (à disposição no local de trabalho): R0, R04–R22, RES, REX,\n       RHC (hotcrew), RF1/RF2/RFL (Fort Lauderdale).\n     SOBREAVISO -> \"sobreaviso\" (fora do local de trabalho, apresentar em 90 min):\n       P, P02–P13, PLT, PPI (Pilatus), PV (voluntário), SCO, SE.\n     DESLOCAMENTO: DH = deadhead (etapa tipo \"deadhead\", não conta pouso);\n       BUS = deslocamento terrestre -> \"deslocamento\".\n     PERNOITE: HTL = Hotel -> \"pernoite\": true.\n     FRETAMENTO: FRT = fretamento (nº do voo a confirmar) -> \"voo\".\n     TREINAMENTO/CHEQUE/SIMULADOR -> \"treinamento\": cheques (CA2/CA3/CAA/CAE/CAP anual;\n       CB2/CB3/CBA/CBE bienal; CI2/CI3/CIA/CIE inicial), simulador (S02–S22, SFX),\n       periódicos (PP1/PP2 pilotos; PC1/PC2 comissários; PIV), GS=ground school,\n       CPT=cockpit procedures, cursos (CFI, FIV, ICM, DGR, AVS, ANC, TEM, T20/T30...).\n     MÉDICO/AVALIAÇÃO -> atividade null + observação: CMA, C60, AVM, AVI, AVT, PSI, SME.\n     LICENÇA/INDISPONIBILIDADE -> atividade null + observação: DSP=indisponível,\n       DMF/DMI=dispensa médica, LM/LP=licença maternidade/paternidade, LSV, LUT, INS, FAL.\n     LIBERAÇÕES (sinais úteis ao motor) -> atividade null + observação:\n       LFA = liberado fadiga; LHR = liberado por alto número de horas no mês.\n   - ATENÇÃO: nem todo P*/R* é prontidão — PP1/PP2/PC1/PC2/PIV são periódicos,\n     REI/RAZ/RIR/ROP/RGC são reunião/treino. Vá pela legenda, NÃO pelo prefixo.\n   - Código fora da legenda: codigo_a_confirmar: true. (Ex.: \"E-AED\" não consta na\n     legenda — provável ruído de leitura; marcar a confirmar.)\n\n------------------------------------------------------------\nGLOSSÁRIO UNIFICADO (equivalências entre empresas):\n- folga regulamentar : FR (GOL, Azul)  |  DO (LATAM)\n- folga pedida       : FP (GOL, Azul)  |  DR (LATAM)\n- reserva (na base/aeroporto, à disposição no local de trabalho):\n                       R0/R04–R22/RES/REX/RHC/RF* (Azul) | ASB (LATAM) | RES e R+aeroporto, p.ex. RGRU/RGIG/RBSB (GOL)\n- sobreaviso (fora do local de trabalho, apresentar em até 90 min):\n                       P*/PV/SCO/SE/PLT/PPI (Azul) | SBV/SOB (GOL) | HSB/HSBE (LATAM)\n- deadhead/deslocamento (não conta pouso):\n                       DH (GOL, Azul) | PS (LATAM)  [Azul: BUS = deslocamento terrestre]\n- treinamento/curso  : C-xxx (GOL) | MCK320/CRMACD (LATAM) | cheques/simulador/cursos (Azul)\n- companhias: G3 = GOL ; LA/JJ = LATAM ; AD = AZUL\n\n------------------------------------------------------------\nLEMBRETES FINAIS:\n- Transcreva, não interprete. Diante de dúvida, null.\n- Não converta fuso horário; copie o horário local exatamente.\n- num_pousos conta apenas etapas operadas (deadhead/PS não conta).\n- Ignore acumulados de 28 dias (GOL) e qualquer total que não seja da jornada.\n- Código desconhecido -> codigo_a_confirmar: true, atividade null, e NUNCA chute.\n- fuso_diferente só é true quando a ESCALA sinaliza; senão, false ou null.\n------------------------------------------------------------\n";

function getPrompt() { return PROMPT_INLINE; }

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function parseEscalaJson(texto) {
  let limpo = texto.replace(/```json/gi, '').replace(/```/g, '').trim();
  const ini = limpo.indexOf('{'), fim = limpo.lastIndexOf('}');
  if (ini !== -1 && fim !== -1 && fim > ini) limpo = limpo.slice(ini, fim + 1);
  return JSON.parse(limpo); // lança SyntaxError se não for JSON
}

async function askClaude(model, content) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model, max_tokens: 8000, system: getPrompt(), messages: [{ role: 'user', content }] })
  });
  if (!resp.ok) {
    const t = await resp.text();
    const err = new Error('IA'); err.detalhe = t.slice(0, 300); err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  const texto = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return parseEscalaJson(texto);
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'método não permitido' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { imagem_base64, mime } = body;
    if (!imagem_base64 || !mime) {
      return res.status(400).json({ erro: 'envie imagem_base64 e mime' });
    }

    // ---- Login: exige token válido (protege a chamada de visão) ----
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      return res.status(401).json({ erro_login: true, erro: 'Faça login para ler a escala.' });
    }
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
      let userId = null;
      try {
        const uResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: { 'apikey': SUPABASE_SERVICE_ROLE, 'Authorization': `Bearer ${token}` }
        });
        if (uResp.ok) { const u = await uResp.json(); userId = u && u.id; }
      } catch (e) { /* cai no 401 */ }
      if (!userId) {
        return res.status(401).json({ erro_login: true, erro: 'Sessão inválida. Faça login novamente.' });
      }
    }

    const isPdf = mime === 'application/pdf';
    const INSTR_TXT = 'Acima está o TEXTO extraído de um PDF de escala de aeronauta. O alinhamento em colunas pode ter se perdido na extração — use o conteúdo (datas, códigos, horários, números de voo) e as REGRAS para montar as jornadas. NÃO inclua o array "etapas". Em cada jornada devolva: data, apresentacao, corte_motores, num_pousos, atividade, tipo_tripulacao, pernoite, origem (sigla do aeroporto de partida da 1ª etapa operada) e destino (sigla do aeroporto de chegada da última etapa operada). Se o texto estiver ilegível ou embaralhado demais, devolva confianca_geral baixa. Responda APENAS com o JSON compacto, sem texto antes ou depois.';
    const INSTR_IMG = 'Extraia os dados desta escala conforme as regras. NÃO inclua o array "etapas". Em cada jornada devolva: data, apresentacao, corte_motores, num_pousos, atividade, tipo_tripulacao, pernoite, origem (sigla do aeroporto de partida da 1ª etapa operada) e destino (sigla do aeroporto de chegada da última etapa operada). Responda APENAS com o JSON compacto, sem texto antes ou depois.';

    // ===== CAMINHO RÁPIDO: PDF com texto selecionável -> extrai o texto e usa modelo de TEXTO (rápido) =====
    if (isPdf) {
      let textoPdf = '';
      try {
        const pdfParse = require('pdf-parse/lib/pdf-parse.js');
        const out = await pdfParse(Buffer.from(imagem_base64, 'base64'));
        textoPdf = ((out && out.text) || '').replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').trim();
      } catch (e) { textoPdf = ''; }

      if (textoPdf.length >= 40) {
        try {
          const json = await askClaude(TEXT_MODEL, [
            { type: 'text', text: 'TEXTO DA ESCALA (extraído do PDF):\n\n' + textoPdf.slice(0, 60000) + '\n\n' + INSTR_TXT }
          ]);
          return res.status(200).json(json); // privacidade: nada é persistido
        } catch (e) {
          // texto não rendeu JSON válido (ou PDF estranho) -> cai para a visão abaixo
        }
      }
    }

    // ===== CAMINHO VISÃO: imagens, ou PDF escaneado/sem camada de texto =====
    const bloco = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: imagem_base64 } }
      : { type: 'image',    source: { type: 'base64', media_type: mime,              data: imagem_base64 } };

    try {
      const json = await askClaude(VISION_MODEL, [ bloco, { type: 'text', text: INSTR_IMG } ]);
      return res.status(200).json(json); // privacidade: nada é persistido
    } catch (e) {
      if (e instanceof SyntaxError) {
        return res.status(422).json({ erro: 'a IA não devolveu JSON válido', eh_escala: false });
      }
      return res.status(502).json({ erro: 'falha na IA de visão', detalhe: e.detalhe || String((e && e.message) || e).slice(0, 200), status: e.status });
    }

  } catch (e) {
    return res.status(500).json({ erro: 'erro interno', detalhe: String((e && e.message) || e).slice(0, 200) });
  }
};
