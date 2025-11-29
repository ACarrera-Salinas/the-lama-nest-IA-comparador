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

function findProductMeta(indexData, asin) {
  if (!asin || !indexData) return null;

  // 1) Objeto con claves por ASIN
  if (!Array.isArray(indexData) && typeof indexData === "object") {
    if (indexData[asin]) return indexData[asin];

    // 2) Array dentro de .products
    if (Array.isArray(indexData.products)) {
      const p = indexData.products.find(
        (x) => x.asin === asin || x.ASIN === asin
      );
      if (p) return p;
    }
  }

  // 3) Índice como array
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
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: "",
    };
  }

  // Parámetros GET (para mode=index)
  const queryParams = event.queryStringParameters || {};

  // Parámetros POST (para metrics / narrative)
  let bodyParams = {};
  if (event.httpMethod === "POST" && event.body) {
    try {
      bodyParams = JSON.parse(event.body);
    } catch {
      bodyParams = {};
    }
  }

  const mode = (
    queryParams.mode ||
    bodyParams.mode ||
    "metrics"
  ).toLowerCase();

  const asinA = (queryParams.asinA || bodyParams.asinA || "").trim();
  const asinB = (queryParams.asinB || bodyParams.asinB || "").trim();

  try {
    // --- MODO INDEX: devolver catálogo para buscador por nombre ---
    if (mode === "index") {
      const indexData = loadIndex();

      let products = [];
      if (Array.isArray(indexData)) {
        products = indexData;
      } else if (Array.isArray(indexData.products)) {
        products = indexData.products;
      } else if (typeof indexData === "object" && indexData !== null) {
        products = Object.values(indexData);
      }

      const length = products.length;

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          mode: "index",
          entries: length,
          products,
        }),
      };
    }

    // A partir de aquí, todos los modos necesitan asinA y asinB
    if (!asinA || !asinB) {
      throw new Error(
        "Debes enviar asinA y asinB (por ejemplo asinA=XXX&asinB=YYY)."
      );
    }

    // --- MODO METRICS: tarjetas + resumen rápido centrado en datos ---
    if (mode === "metrics") {
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

    // --- MODO NARRATIVE: opinión final corta, basada en meta-reviews ---
    if (mode === "narrative") {
      const indexData = loadIndex();
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
