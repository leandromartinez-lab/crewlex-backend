// =====================================================================
// CrewLex · /api/metar  (Vercel Serverless Function)
// Busca METAR e TAF (texto bruto) de um aeródromo pelo código ICAO,
// direto da fonte oficial e gratuita: Aviation Weather Center (NOAA/NWS).
// Feito no backend porque o site não libera acesso do navegador (CORS).
// DNA: "sem dado fantasma" — devolve exatamente o que a fonte oficial diz.
//
// Uso:  GET /api/metar?icao=SBGR
// Resposta: { icao, metar, taf }
//
// Variáveis de ambiente (Vercel):
//   ALLOWED_ORIGIN   (opcional; default '*')
// =====================================================================

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const BASE = 'https://aviationweather.gov/api/data/';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Método não permitido' }); return; }

  const icao = ((req.query && req.query.icao) || '').toString().trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(icao)) {
    res.status(400).json({ error: 'Código ICAO inválido — são 4 letras (ex.: SBGR).' });
    return;
  }

  try {
    const [mR, tR] = await Promise.all([
      fetch(BASE + 'metar?ids=' + icao + '&format=raw'),
      fetch(BASE + 'taf?ids='  + icao + '&format=raw')
    ]);
    const metar = (await mR.text() || '').trim();
    const taf   = (await tR.text() || '').trim();
    // A fonte devolve texto vazio quando não há estação/dado para o ICAO.
    res.status(200).json({ icao, metar, taf });
  } catch (e) {
    res.status(502).json({ error: 'Falha ao acessar a fonte de METAR/TAF.', detail: String((e && e.message) || e) });
  }
};
