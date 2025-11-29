// netlify/functions/verifymyth.js
// Función principal de TheLamaNest IA Comparator
// Modos soportados:
// - "index": devuelve el índice completo (catálogo ligero) para el front
// - "metrics": devuelve los 2 productos completos + breve análisis IA de datos
// - "narrative": compara los blogs y devuelve una opinión persuasiva

const fs = require("fs");
const path = require("path");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Cargamos el índice LAMA como dependencia estática para que Netlify
// lo incluya dentro del bundle de la función.
const lamaIndex = require("./data/lama_index.json");

// --- Utilidades comunes ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function loadIndex() {
  const parsed = lamaIndex;

  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.products)) return parsed.products;

  throw new Error(
    "Formato inesperado en lama_index.json (se esperaba un array o { products: [] })"
  );
}

async function callGemini(promptText) {
  if (!GEMINI_API_KEY) {
    throw new Error("Falta GEMINI_API_KEY en variables de entorno");
  }

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
    GEMINI_API_KEY;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: promptText }]
        }
      ]
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error("Error Gemini: " + txt);
  }

  const data = await res.json();
  const text =
    data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text;

  return (text || "").trim();
}

// --- Handler Netlify ---

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: "Método no permitido"
      })
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const mode = body.mode;
    const asinA = (body.asinA || "").trim();
    const asinB = (body.asinB || "").trim();

    if (!mode) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: "Falta 'mode' en la petición."
        })
      };
    }

    // Cargamos índice una sola vez por petición
    const products = loadIndex();

    // --- MODO INDEX: devolver catálogo ligero para el front ---
    if (mode === "index") {
      const lite = products.map((p) => ({
        asin: p.asin,
        nombre_producto: p.nombre_producto,
        market: p.market,
        categoria_inferida: p.categoria_inferida,
        n_reviews: p.n_reviews,
        mean_stars: p.mean_stars,
        tags_tematica: p.tags_tematica || []
      }));

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ success: true, products: lite })
      };
    }

    // A partir de aquí, los modos necesitan dos ASIN
    if (!asinA || !asinB) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: "Faltan 'asinA' y/o 'asinB' en la petición."
        })
      };
    }

    const prodA = products.find(
      (p) => (p.asin || "").toUpperCase() === asinA.toUpperCase()
    );
    const prodB = products.find(
      (p) => (p.asin || "").toUpperCase() === asinB.toUpperCase()
    );

    if (!prodA || !prodB) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error:
            "No encontramos uno o ambos ASIN en lama_index.json. Revisa el índice."
        })
      };
    }

    // --- MODO METRICS: IA sobre datos Lama (no usa blogs) ---
    if (mode === "metrics") {
      let analysis = null;

      try {
        const prompt = `
Eres el comparador de productos de TheLamaNest.

Tienes dos productos que ya han sido analizados con nuestro "Lama index".
Cada producto se describe con todas estas variables:
- nombre_producto
- market
- categoria_inferida
- mean_stars, n_reviews
- lama_lb95, lama_ub95
- prob_chasco
- fecha_ultima_review
- stars_pct (distribución reseñas 1–5)
- top_pros
- top_contras
- tags_tematica

Tu tarea:
1) Comparar los dos productos de forma clara y honesta.
2) Explicar en pocas frases quién debería elegir el Producto A y quién el Producto B.
3) Terminar con una recomendación clara, pero sin ser agresivo: ayuda al usuario a decidir cuál encaja mejor con su caso.
4) No uses markdown, no pongas títulos. Solo texto plano, 6–10 frases.

Producto A:
${JSON.stringify(prodA, null, 2)}

Producto B:
${JSON.stringify(prodB, null, 2)}
`;

        analysis = await callGemini(prompt);
      } catch (err) {
        console.error("Error en Gemini metrics:", err.message);
        analysis = null; // Devolvemos igualmente los datos
      }

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          products: [prodA, prodB],
          analysis
        })
      };
    }

    // --- MODO NARRATIVE: IA sobre blogs/meta-reviews ---
    if (mode === "narrative") {
      const blogPathA = path.join(
        __dirname,
        "data",
        `${prodA.asin}_ES_blog.txt`
      );
      const blogPathB = path.join(
        __dirname,
        "data",
        `${prodB.asin}_ES_blog.txt`
      );

      let blogA = "";
      let blogB = "";

      try {
        blogA = fs.readFileSync(blogPathA, "utf-8");
      } catch (err) {
        console.error("No se pudo leer blog A:", blogPathA, err.message);
      }

      try {
        blogB = fs.readFileSync(blogPathB, "utf-8");
      } catch (err) {
        console.error("No se pudo leer blog B:", blogPathB, err.message);
      }

      if (!blogA || !blogB) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error:
              "No se encontraron los blogs para uno o ambos productos. Revisa los archivos *_ES_blog.txt."
          })
        };
      }

      const prompt = `
Eres el "Lama Sabio" de TheLamaNest.

Tienes dos productos que ya hemos analizado en profundidad. A continuación verás:
- Información básica de cada producto (nombre y ASIN).
- El texto completo de nuestras meta-reviews (blogs) para cada uno.

Tu tarea:
1) Leer y comparar ambos textos.
2) Explicar en un único párrafo largo (8–12 frases) las diferencias clave entre Producto A y Producto B.
3) Señalar para qué tipo de usuario encaja mejor cada uno, usando un tono cercano, claro y honesto.
4) Terminar con una recomendación suave pero clara: si tuvieras que elegir solo uno para la mayoría de usuarios, ¿cuál sería y por qué?
5) No uses listas ni títulos, no uses markdown. Solo texto plano.

Producto A:
- Nombre: ${prodA.nombre_producto}
- ASIN: ${prodA.asin}
- Blog A:
${blogA}

Producto B:
- Nombre: ${prodB.nombre_producto}
- ASIN: ${prodB.asin}
- Blog B:
${blogB}
`;

      let text;
      try {
        text = await callGemini(prompt);
      } catch (err) {
        console.error("Error en Gemini narrative:", err.message);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error: "Error generando la opinión final de la IA."
          })
        };
      }

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ success: true, text })
      };
    }

    // --- Modo desconocido ---
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: "Modo no reconocido. Usa 'index', 'metrics' o 'narrative'."
      })
    };
  } catch (err) {
    console.error("Error general verifymyth:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: "Error interno en verifymyth: " + (err.message || String(err))
      })
    };
  }
};
