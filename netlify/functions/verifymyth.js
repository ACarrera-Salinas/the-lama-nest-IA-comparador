// netlify/functions/verifymyth.js
// Función principal de TheLamaNest IA Comparator
// Modos soportados:
// - "index": devuelve índice ligero para el front
// - "metrics": devuelve 2 productos completos + análisis IA de datos
// - "narrative": compara los blogs y devuelve una opinión persuasiva

const fs = require("fs");
const path = require("path");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-2.5-flash";

// --- CORS ---
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

// --- Localización de la carpeta data (lama_index + blogs) ---

function getDataDir() {
  const candidates = [
    // carpeta data junto a la función
    path.join(__dirname, "data"),
    // si has creado verifymyth_data
    path.join(__dirname, "verifymyth_data"),
    path.join(__dirname, "../verifymyth_data"),
    // rutas típicas en el bundle de Netlify
    "/var/task/netlify/functions/data",
    "/var/task/netlify/functions/verifymyth_data",
    "/var/task/data",
    "/var/task/verifymyth_data"
  ];

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }

  throw new Error(
    "No se encontró carpeta 'data'. Probadas rutas: " +
      candidates.join(" | ")
  );
}

function loadIndex() {
  const dataDir = getDataDir();
  const indexPath = path.join(dataDir, "lama_index.json");
  const raw = fs.readFileSync(indexPath, "utf-8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.products)) return parsed.products;
  throw new Error("Formato inesperado en lama_index.json");
}

function loadBlog(asin, lang = "ES") {
  const dataDir = getDataDir();
  const upper = (lang || "ES").toUpperCase();
  const candidates = [
    `${asin}_${upper}_blog.txt`,
    `${asin}_${upper.toLowerCase()}_blog.txt`
  ];

  for (const fileName of candidates) {
    const fullPath = path.join(dataDir, fileName);
    if (fs.existsSync(fullPath)) {
      return fs.readFileSync(fullPath, "utf-8");
    }
  }

  throw new Error(
    `No se encontró blog para ASIN ${asin}. Probados nombres: ${candidates.join(
      " | "
    )}`
  );
}

// --- Llamada a Gemini 2.5-flash (API v1) ---

async function callGemini(promptText) {
  if (!GEMINI_API_KEY) {
    throw new Error("Falta GEMINI_API_KEY en variables de entorno");
  }

  const url =
    "https://generativelanguage.googleapis.com/v1/models/" +
    GEMINI_MODEL +
    ":generateContent?key=" +
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
    data.candidates[0].content.parts
      .map((p) => p.text || "")
      .join(" ")
      .trim();

  if (!text) {
    throw new Error("Gemini devolvió una respuesta vacía");
  }

  return text;
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
      body: JSON.stringify({ success: false, error: "Método no permitido" })
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

    // Cargamos índice una sola vez
    const products = loadIndex();

    // --- MODO INDEX: devuelve catálogo ligero para el front ---
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

      // IMPORTANTE: mantener { success, products } para que tu index.html funcione
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
        analysis = null; // devolvemos igualmente los datos
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
      let blogA = "";
      let blogB = "";

      try {
        blogA = loadBlog(prodA.asin, "ES");
        blogB = loadBlog(prodB.asin, "ES");
      } catch (err) {
        console.error("Error leyendo blogs:", err.message);
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
