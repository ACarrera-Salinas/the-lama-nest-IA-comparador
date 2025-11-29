// netlify/functions/verifymyth.js
//
// Función Netlify para el Comparador Lama de TheLamaNest.
// Usa GEMINI_API_KEY (variable de entorno en Netlify) para llamar a Gemini.
//
// Espera peticiones POST JSON con este formato:
//
// {
//   "mode": "metrics" | "narrative",
//   "asinA": "B0B4SG34QP",
//   "asinB": "B07B756S34"
// }
//
// MODE "metrics":
//   - Lee netlify/functions/data/lama_index.json
//   - Busca los dos productos por ASIN
//   - Devuelve:
//     { success: true, products: [productA, productB] }
//     (incluyendo todos los campos Lama: market, stars_pct, lama_lb95, lama_ub95,
//      fecha_ultima_review, top_pros, top_contras, etc.)
//
// MODE "narrative":
//   - Lee netlify/functions/data/{asin}_ES_blog.txt para cada producto
//   - Llama a Gemini con ambos textos de blog/meta-review
//   - Devuelve:
//     { success: true, text: "..." }
//
// NOTA: asegúrate de que:
//   - GEMINI_API_KEY está configurado en Netlify
//   - netlify/functions/data/lama_index.json existe y tiene un array de objetos tipo Lama con:
//       asin, nombre_producto, market, categoria_inferida,
//       n_reviews, mean_stars, stars_pct, lama_lb95, lama_ub95,
//       prob_chasco, fecha_ultima_review, top_pros, top_contras, tags_tematica, etc.
//   - Para cada ASIN, existe un fichero {ASIN}_ES_blog.txt en la carpeta data.

const fs = require('fs');
const path = require('path');

let lamaIndexCache = null;

function loadLamaIndex() {
  if (lamaIndexCache) return lamaIndexCache;

  const dataPath = path.join(__dirname, 'data', 'lama_index.json');

  if (!fs.existsSync(dataPath)) {
    throw new Error('No se encuentra data/lama_index.json. Crea este archivo con tu índice Lama.');
  }

  const raw = fs.readFileSync(dataPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('Error parseando lama_index.json: ' + e.message);
  }

  // Permitimos tanto un array directo como un objeto { products: [...] }
  if (Array.isArray(parsed)) {
    lamaIndexCache = parsed;
  } else if (Array.isArray(parsed.products)) {
    lamaIndexCache = parsed.products;
  } else {
    throw new Error('lama_index.json debe ser un array o un objeto con propiedad "products" (array).');
  }

  return lamaIndexCache;
}

function findProductByAsin(asin) {
  const index = loadLamaIndex();
  return index.find(p => (p.asin || '').toLowerCase() === String(asin).toLowerCase());
}

function readBlogText(asin) {
  const filename = `${asin}_ES_blog.txt`;
  const blogPath = path.join(__dirname, 'data', filename);

  if (!fs.existsSync(blogPath)) {
    throw new Error(`No se encuentra el fichero de blog para ASIN ${asin}: ${filename}`);
  }

  return fs.readFileSync(blogPath, 'utf8');
}

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Falta GEMINI_API_KEY en las variables de entorno de Netlify.');
  }

  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

  const res = await fetch(`${endpoint}?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ]
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Error de Gemini API (${res.status}): ${text}`);
  }

  const data = await res.json();

  const candidates = data.candidates || [];
  if (!candidates.length || !candidates[0].content || !candidates[0].content.parts || !candidates[0].content.parts.length) {
    throw new Error('Respuesta inesperada de Gemini: falta texto.');
  }

  const text = candidates[0].content.parts[0].text || '';
  return text.trim();
}

function buildNarrativePrompt(productA, productB, blogA, blogB) {
  return `
Eres una IA experta en ayudar a usuarios a elegir entre dos productos de consumo basándote en meta-reviews largas de TheLamaNest.

Te doy información de dos productos (A y B) procedente de los blogs/meta-reviews de TheLamaNest.
Tu tarea:

1. Leer el contexto de ambos productos (solo a partir de los textos de blog que te doy).
2. Escribir SOLO un párrafo corto (6-10 líneas máximo) en español, muy claro y directo.
3. Dar tu opinión comparativa:
   - Para quién encaja mejor el producto A.
   - Para quién encaja mejor el producto B.
4. Terminar con una mini-conclusión clara donde, si tuvieras que elegir uno para la mayoría de usuarios, digas cuál sería y por qué, sin sonar agresivo, pero sí persuasivo.
5. No repitas textualmente frases largas del blog; sintetiza y prioriza lo que más pueda influir en la decisión.
6. No uses formato markdown, solo texto plano.

Producto A:
ASIN: ${productA.asin}
Nombre: ${productA.nombre_producto || ''}

Texto del blog A:
-----------------
${blogA}

Producto B:
ASIN: ${productB.asin}
Nombre: ${productB.nombre_producto || ''}

Texto del blog B:
-----------------
${blogB}

Ahora escribe la comparativa breve y tu recomendación final.
`.trim();
}

/**
 * Netlify Function handler
 */
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: 'Método no permitido. Usa POST.' })
      };
    }

    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (e) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: 'Body JSON inválido.' })
      };
    }

    const mode = payload.mode;
    const asinA = payload.asinA;
    const asinB = payload.asinB;

    if (!mode || !asinA || !asinB) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: 'Faltan campos: mode, asinA o asinB.' })
      };
    }

    const validModes = ['metrics', 'narrative'];
    if (!validModes.includes(mode)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: 'mode debe ser "metrics" o "narrative".' })
      };
    }

    const productA = findProductByAsin(asinA);
    const productB = findProductByAsin(asinB);

    if (!productA || !productB) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          error: 'No se han encontrado uno o ambos ASIN en lama_index.json.'
        })
      };
    }

    if (mode === 'metrics') {
      // Devuelve los productos tal cual vienen del índice
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          products: [productA, productB]
        })
      };
    }

    // mode === 'narrative'
    const blogA = readBlogText(productA.asin);
    const blogB = readBlogText(productB.asin);

    const prompt = buildNarrativePrompt(productA, productB, blogA, blogB);
    const text = await callGemini(prompt);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        text
      })
    };
  } catch (err) {
    console.error('Error en verifymyth:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: 'Error interno en la función verifymyth: ' + err.message
      })
    };
  }
};
