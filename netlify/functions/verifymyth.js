const fs = require("fs");
const path = require("path");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const DATA_DIR_CANDIDATES = [
  path.join(__dirname, "data"),
  path.join(__dirname, "../data"),
  "/var/task/netlify/functions/data",
  "/var/task/data",
  "/var/data",
];

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

function loadIndex() {
  const dataDir = getDataDir();
  const indexPath = path.join(dataDir, "lama_index.json");
  if (!fs.existsSync(indexPath)) {
    throw new Error(`No se ha encontrado lama_index.json en ${indexPath}`);
  }
  const raw = fs.readFileSync(indexPath, "utf8");
  return JSON.parse(raw);
}

function extractCatalog(indexData) {
  if (Array.isArray(indexData)) return indexData;

  if (indexData && Array.isArray(indexData.products)) {
    return indexData.products;
  }

  if (indexData && typeof indexData === "object") {
    return Object.keys(indexData).map((asin) => ({
      asin,
      ...(indexData[asin] || {}),
    }));
  }

  return [];
}

function findProductMeta(indexData, asin) {
  if (!asin || !indexData) return null;

  // 1) objeto con claves por ASIN
  if (!Array.isArray(indexData) && typeof indexData === "object") {
    if (indexData[asin]) return indexData[asin];

    // 2) array dentro de .products
    if (Array.isArray(indexData.products)) {
      const p = indexData.products.find(
        (x) => x.asin === asin || x.ASIN === asin
      );
      if (p) return p;
    }
  }

  // 3) índice como array plano
  if (Array.isArray(indexData)) {
    return (
      indexData.find((x) => x.asin === asin || x.ASIN === asin) || null
    );
  }

  return null;
}

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
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: "",
    };
  }

  let mode = "metrics";
  let asinA = "";
  let asinB = "";

  // GET -> query; POST -> body JSON
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    mode = (params.mode || "metrics").toLowerCase();
    asinA = (params.asinA || "").trim();
    asinB = (params.asinB || "").trim();
  } else {
    try {
      const body = event.body ? JSON.parse(event.body) : {};
      mode = (body.mode || "metrics").toLowerCase();
      asinA = (body.asinA || "").trim();
      asinB = (body.asinB || "").trim();
    } catch (e) {
      console.error("Error parseando body JSON:", e);
    }
  }

  try {
    const indexData = loadIndex();

    // --- MODO INDEX: devolver catálogo para el buscador ---
    if (mode === "index") {
      const catalog = extractCatalog(indexData);
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          mode: "index",
          entries: catalog.length,
          products: catalog,
        }),
      };
    }

    // A partir de aquí siempre necesitamos ambos ASIN
    if (!asinA || !asinB) {
      throw new Error(
        "Debes indicar asinA y asinB (por ejemplo asinA=B0XXXX y asinB=B0YYYY)."
      );
    }

    // --- MODO METRICS: tarjetas + resumen rápido de datos ---
    if (mode === "metrics") {
      const productA = findProductMeta(indexData, asinA);
      const productB = findProductMeta(indexData, asinB);

      if (!productA || !productB) {
        throw new Error(
          `No se encontraron datos Lama para uno o ambos productos (${asinA}, ${asinB}).`
        );
      }

      const quickSummaryPrompt = `
Eres el asistente del Comparador Lama.

Tienes los datos JSON de dos productos (A y B). Escribe un único resumen MUY breve y claro para un usuario medio (máximo 90–110 palabras).

Objetivo:
- Explicar en 3–5 frases en qué se diferencian sus puntos fuertes principales.
- Resumir de forma neutra para qué sirve mejor cada uno, sin decir todavía cuál debería comprar la persona.
- Tono neutro, cercano y fácil de leer.
- No menciones la palabra "JSON", ni "modelo de lenguaje", ni "Gemini". No hagas listas ni títulos, solo un texto corrido.

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
          analysis: quickSummary, // el frontend lo muestra directamente
          quickSummary,
        }),
      };
    }

    // --- MODO NARRATIVE: opinión final corta y orientada a decisión ---
    if (mode === "narrative") {
      const productA = findProductMeta(indexData, asinA);
      const productB = findProductMeta(indexData, asinB);

      if (!productA || !productB) {
        throw new Error(
          `No se encontraron datos Lama para uno o ambos productos (${asinA}, ${asinB}).`
        );
      }

      const blogA = loadBlog(asinA, "ES");
      const blogB = loadBlog(asinB, "ES");

      const prompt = `
Actúas como asesor imparcial del Comparador Lama.

El usuario ya ha leído un resumen rápido sobre las diferencias de los productos A y B.
Ahora quiere una ayuda FINAL para decidir.

Instrucciones:
- Máximo 150–170 palabras.
- No repitas frases ni ideas de forma casi idéntica al resumen rápido: aporta información más práctica y enfocada en la decisión.
- Organiza el texto en 3 bloques de 2–3 frases cada uno, separados por un salto de línea:
  1) Explica para qué tipo de persona o situación encaja mejor el Producto A (hábitos, espacio, nivel de experiencia, frecuencia de uso…).
  2) Explica para qué tipo de persona o situación encaja mejor el Producto B.
  3) Cierra con 1–2 frases ayudando a elegir: del tipo "si te ves más en X, ve a por A; si te ves más en Y, mejor B".
- Usa frases cortas y lenguaje sencillo. Nada de tecnicismos.
- No menciones "Amazon", "reseñas", "modelo de lenguaje", "Gemini" ni "JSON".
- No uses listas ni viñetas; basta con texto corrido separado en párrafos.

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
          mode: "narrative",
          text: finalOpinion, // el frontend usa data.text
          finalOpinion,
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
