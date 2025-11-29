// netlify/functions/verifymyth.js

const fs = require("fs");
const path = require("path");

// CORS básico
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Rutas candidatas para carpeta data en Netlify
const DATA_DIR_CANDIDATES = [
  path.join(__dirname, "data"),
  path.join(__dirname, "../data"),
  "/var/task/netlify/functions/data",
  "/var/task/data",
  "/var/data",
];

// Localiza la carpeta data
function getDataDir() {
  const tried = [];
  for (const dir of DATA_DIR_CANDIDATES) {
    tried.push(dir);
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(
    "No se encontró carpeta 'data'. Probadas rutas: " + tried.join(" | ")
  );
}

// Carga lama_index.json y devuelve SIEMPRE un array de productos
function loadIndexProducts() {
  const dataDir = getDataDir();
  const indexPath = path.join(dataDir, "lama_index.json");

  if (!fs.existsSync(indexPath)) {
    throw new Error(
      `No se ha encontrado lama_index.json en ${indexPath}. Asegúrate de generarlo.`
    );
  }

  const raw = fs.readFileSync(indexPath, "utf8");
  const indexData = JSON.parse(raw);

  let products = [];
  if (Array.isArray(indexData)) {
    products = indexData;
  } else if (Array.isArray(indexData.products)) {
    products = indexData.products;
  } else if (indexData && typeof indexData === "object") {
    // caso objeto tipo mapa {ASIN: {...}, ...}
    products = Object.values(indexData);
  }

  return products;
}

// Busca producto en el array de productos por asin / ASIN
function findProductByAsin(products, asin) {
  if (!asin) return null;
  const target = asin.trim().toUpperCase();
  return (
    products.find((p) => {
      const a1 = (p.asin || "").toString().toUpperCase();
      const a2 = (p.ASIN || "").toString().toUpperCase();
      return a1 === target || a2 === target;
    }) || null
  );
}

// Carga la meta-review en texto
function loadBlog(asin, lang = "ES") {
  if (!asin) return null;
  const dataDir = getDataDir();
  const filename = `${asin}_${lang}_blog.txt`;
  const blogPath = path.join(dataDir, filename);
  if (!fs.existsSync(blogPath)) {
    throw new Error(
      `No se ha encontrado el blog ${filename}. Asegúrate de que existe en la carpeta data.`
    );
  }
  return fs.readFileSync(blogPath, "utf8");
}

// Llamada a Gemini
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No se ha configurado GEMINI_API_KEY en las variables de entorno."
    );
  }

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
    apiKey;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error("Error Gemini: " + JSON.stringify(data));
  }

  const text =
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts
      .map((p) => p.text || "")
      .join(" ")
      .trim();

  if (!text) {
    throw new Error("Gemini devolvió una respuesta vacía.");
  }

  return text;
}

exports.handler = async (event) => {
  // Preflight CORS
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: "",
    };
  }

  const queryParams = event.queryStringParameters || {};
  let bodyParams = {};
  if (event.httpMethod === "POST" && event.body) {
    try {
      bodyParams = JSON.parse(event.body);
    } catch (e) {
      console.error("Error parseando body JSON:", e);
      bodyParams = {};
    }
  }

  const rawMode = queryParams.mode || bodyParams.mode || "metrics";
  const mode = String(rawMode).toLowerCase();

  const asinA = (queryParams.asinA || bodyParams.asinA || "").trim();
  const asinB = (queryParams.asinB || bodyParams.asinB || "").trim();

  try {
    /*********************
     * MODO INDEX (GET)
     * Devuelve catálogo completo para buscador por nombre.
     *********************/
    if (mode === "index") {
      const products = loadIndexProducts();
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          mode: "index",
          entries: products.length,
          products,
        }),
      };
    }

    /*********************
     * MODOS QUE COMPARAN DOS ASIN
     *********************/
    if (!asinA || !asinB) {
      throw new Error(
        "Debes enviar asinA y asinB (por ejemplo asinA=XXX&asinB=YYY)."
      );
    }
    if (asinA === asinB) {
      throw new Error("Los dos productos deben ser distintos (ASIN diferentes).");
    }

    const products = loadIndexProducts();
    const productA = findProductByAsin(products, asinA);
    const productB = findProductByAsin(products, asinB);

    if (!productA || !productB) {
      throw new Error(
        `No se encontraron datos Lama en lama_index.json para uno o ambos productos (${asinA}, ${asinB}). ` +
          "Asegúrate de que ese ASIN esté incluido en lama_index.json (generándolo con tu script de índice agregado)."
      );
    }

    /*********************
     * MODO METRICS
     *********************/
    if (mode === "metrics") {
      const quickSummaryPrompt = `
Eres el asistente del Comparador Lama.

Tienes los datos JSON de dos productos (A y B), con puntuaciones medias, distribución de estrellas, probabilidad de chasco y los principales pros y contras.

Escribe un único resumen muy breve y claro (máximo unas 140 palabras) para un usuario medio, centrado en:
- Cómo se comparan en calidad percibida y riesgo de chasco.
- Qué tipo de ventajas destacan los usuarios en cada uno.
- Qué tipo de problemas son más frecuentes en cada uno.
- En qué escenarios generales parece encajar mejor A y en cuáles B.

No menciones “JSON”, ni “modelo de lenguaje”, ni “Gemini” y no uses listas ni títulos. Solo un texto corrido.

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
          mode: "metrics",
          products: [productA, productB],
          analysis: quickSummary,
        }),
      };
    }

    /*********************
     * MODO NARRATIVE
     *********************/
    if (mode === "narrative") {
      const blogA = loadBlog(asinA, "ES");
      const blogB = loadBlog(asinB, "ES");

      const prompt = `
Actúas como asesor imparcial del Comparador Lama.

Te doy dos meta-reviews en texto (A y B) más algunos datos de contexto. Con eso debes escribir una "opinión final" MUY breve y útil para un usuario medio.

Instrucciones:
- Máximo ~170 palabras en total.
- Empieza con 1–2 frases explicando muy rápido qué enfoque tiene cada producto (tipo de uso, sensaciones, a quién le suele gustar).
- Después, en 3–4 frases más, explica:
  - En qué tipo de persona o situación encaja mejor el Producto A.
  - En qué tipo de persona o situación encaja mejor el Producto B.
- Usa frases cortas, lenguaje sencillo y tono cercano.
- No uses títulos, listas ni negritas.
- No menciones "Amazon", "reseñas", "modelo de lenguaje", "Gemini" ni "JSON".

[PRODUCTO A – DATOS JSON]
${JSON.stringify(productA)}

[PRODUCTO A – META-REVIEW]
${blogA}

[PRODUCTO B – DATOS JSON]
${JSON.stringify(productB)}

[PRODUCTO B – META-REVIEW]
${blogB}
      `.trim();

      const finalOpinion = await callGemini(prompt);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          mode: "narrative",
          text: finalOpinion,
        }),
      };
    }

    // Modo no reconocido
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: "Modo no reconocido. Usa 'index', 'metrics' o 'narrative'.",
      }),
    };
  } catch (err) {
    console.error("Error general verifymyth:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error: "Error interno en verifymyth: " + (err.message || String(err)),
      }),
    };
  }
};
