const fs = require('fs');
const path = require('path');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const DATA_DIR_CANDIDATES = [
  path.join(__dirname, 'data'),
  path.join(__dirname, '../data'),
  '/var/task/netlify/functions/data',
  '/var/task/data',
  '/var/data',
];

function getDataDir() {
  const tried = [];
  for (const dir of DATA_DIR_CANDIDATES) {
    tried.push(dir);
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(
    "No se encontró carpeta 'data'. Probadas rutas: " + tried.join(' | ')
  );
}

function loadIndex() {
  const dataDir = getDataDir();
  const indexPath = path.join(dataDir, 'lama_index.json');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`No se ha encontrado lama_index.json en ${indexPath}`);
  }
  const raw = fs.readFileSync(indexPath, 'utf8');
  return JSON.parse(raw);
}

function findProductMeta(indexData, asin) {
  if (!asin || !indexData) return null;

  // 1) map por clave
  if (!Array.isArray(indexData) && typeof indexData === 'object') {
    if (indexData[asin]) return indexData[asin];

    // 2) array dentro de .products
    if (Array.isArray(indexData.products)) {
      const p = indexData.products.find(
        (x) => x.asin === asin || x.ASIN === asin
      );
      if (p) return p;
    }
  }

  // 3) index como array
  if (Array.isArray(indexData)) {
    return (
      indexData.find((x) => x.asin === asin || x.ASIN === asin) || null
    );
  }

  return null;
}

function loadBlog(asin, lang = 'ES') {
  if (!asin) return null;
  const dataDir = getDataDir();
  const filename = `${asin}_${lang}_blog.txt`;
  const blogPath = path.join(dataDir, filename);
  if (!fs.existsSync(blogPath)) {
    throw new Error(
      `No se ha encontrado el blog ${filename}. Asegúrate de que existe en la carpeta data.`
    );
  }
  return fs.readFileSync(blogPath, 'utf8');
}

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'No se ha configurado GEMINI_API_KEY en las variables de entorno.'
    );
  }

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' +
    apiKey;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error('Error Gemini: ' + JSON.stringify(data));
  }

  const text =
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts
      .map((p) => p.text || '')
      .join(' ')
      .trim();

  if (!text) {
    throw new Error('Gemini devolvió una respuesta vacía.');
  }

  return text;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: '',
    };
  }

  const params = event.queryStringParameters || {};
  const mode = (params.mode || 'metrics').toLowerCase();
  const asinA = (params.asinA || '').trim();
  const asinB = (params.asinB || '').trim();

  try {
    if (!asinA || !asinB) {
      throw new Error(
        'Debes enviar asinA y asinB en la query (por ejemplo ?mode=metrics&asinA=XXX&asinB=YYY).'
      );
    }

    // --- MODO INDEX: simple check del índice ---
    if (mode === 'index') {
      const indexData = loadIndex();
      const length = Array.isArray(indexData)
        ? indexData.length
        : Object.keys(indexData).length;
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          mode: 'index',
          entries: length,
        }),
      };
    }

    // --- MODO METRICS: tarjetas + resumen rápido de la IA ---
    if (mode === 'metrics') {
      const indexData = loadIndex();
      const productA = findProductMeta(indexData, asinA);
      const productB = findProductMeta(indexData, asinB);

      if (!productA || !productB) {
        throw new Error(
          `No se encontraron datos Lama para uno o ambos productos (${asinA}, ${asinB}).`
        );
      }

      const quickSummaryPrompt = `
Eres el asistente del Comparador Lama.

Tienes los datos JSON de dos productos (A y B). Escribe un único resumen muy breve y claro para un usuario medio (máximo ~140 palabras).

Objetivo:
- Explicar en qué se diferencian sus puntos fuertes y débiles.
- Indicar en qué casos encaja mejor el Producto A y en qué casos el Producto B.
- Tono neutro, cercano y fácil de leer.
- No menciones la palabra "JSON", ni "modelo de lenguaje", ni "Gemini". No incluyas títulos ni listados, solo un texto corrido.

[PRODUCTO A JSON]
${JSON.stringify(productA)}

[PRODUCTO B JSON]
${JSON.stringify(productB)}
      `.trim();

      const quickSummary = await callGemini(quickSummaryPrompt);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          mode: 'metrics',
          products: {
            A: productA,
            B: productB,
          },
          analysis: {
            quickSummary,
          },
          quickSummary,
        }),
      };
    }

    // --- MODO NARRATIVE: Opinión final corta y UX-friendly ---
    if (mode === 'narrative') {
      const indexData = loadIndex();
      const productA = findProductMeta(indexData, asinA);
      const productB = findProductMeta(indexData, asinB);

      if (!productA || !productB) {
        throw new Error(
          `No se encontraron datos Lama para uno o ambos productos (${asinA}, ${asinB}).`
        );
      }

      const blogA = loadBlog(asinA, 'ES');
      const blogB = loadBlog(asinB, 'ES');

      const prompt = `
Actúas como asesor imparcial del Comparador Lama.

Te doy información JSON y un resumen de opiniones para dos productos (A y B). Con eso debes escribir una "opinión final" MUY breve y útil para un usuario medio.

Instrucciones:
- Máximo ~170 palabras en total.
- Empieza con 1–2 frases que expliquen muy rápido la diferencia de enfoque entre A y B.
- Después, en 3–4 frases más, explica:
  - Cuándo tiene más sentido elegir A.
  - Cuándo tiene más sentido elegir B.
- Usa frases cortas y lenguaje sencillo. Nada de tecnicismos.
- No uses títulos, listas ni negritas. Solo texto corrido.
- No menciones "Amazon", "reseñas", "modelo de lenguaje", "Gemini" ni "JSON".

[PRODUCTO A – DATOS JSON]
${JSON.stringify(productA)}

[PRODUCTO A – RESUMEN BLOG]
${blogA}

[PRODUCTO B – DATOS JSON]
${JSON.stringify(productB)}

[PRODUCTO B – RESUMEN BLOG]
${blogB}
      `.trim();

      const finalOpinion = await callGemini(prompt);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          mode: 'narrative',
          finalOpinion,
          analysis: {
            finalOpinion,
          },
        }),
      };
    }

    // --- modo desconocido ---
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: "Modo no reconocido. Usa 'index', 'metrics' o 'narrative'.",
      }),
    };
  } catch (err) {
    console.error('Error general verifymyth:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error:
          'Error interno en verifymyth: ' + (err.message || String(err)),
      }),
    };
  }
};
