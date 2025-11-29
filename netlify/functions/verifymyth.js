// netlify/functions/verifymyth.js

const fs = require("fs");
const path = require("path");

// ---------------------- CORS ----------------------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ---------------------- HELPERS RUTAS DATA ----------------------
function getDataDir() {
  // Candidatas donde Netlify suele empaquetar los archivos incluidos
  const candidates = [
    path.join(__dirname, "data"),
    path.join(__dirname, "netlify", "functions", "data"),
    "/var/task/netlify/functions/data",
    "/var/task/data",
  ];

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }

  throw new Error(
    `No se encontró carpeta 'data'. Probadas rutas: ${candidates.join(" | ")}`
  );
}

function loadJsonFromData(fileName) {
  const dataDir = getDataDir();
  const fullPath = path.join(dataDir, fileName);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`No se encontró el archivo: ${fullPath}`);
  }

  const raw = fs.readFileSync(fullPath, "utf8");
  return JSON.parse(raw);
}

function loadTextFromData(fileName) {
  const dataDir = getDataDir();
  const fullPath = path.join(dataDir, fileName);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`No se encontró el archivo: ${fullPath}`);
  }

  return fs.readFileSync(fullPath, "utf8");
}

// Carga del índice LAMA
function loadLamaIndex() {
  return loadJsonFromData("lama_index.json");
}

// Carga de blogs por ASIN e idioma
function loadBlogByAsin(asin, lang = "ES") {
  const langUpper = (lang || "ES").toUpperCase();
  const fileName = `${asin}_${langUpper}_blog.txt`; // p.ej. B0CLLCDM7R_ES_blog.txt
  return loadTextFromData(fileName);
}

// ---------------------- GEMINI 2.5 FLASH ----------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Petición a Gemini 2.5-flash
async function callGemini(promptText) {
  if (!GEMINI_API_KEY) {
    throw new Error("Falta la variable de entorno GEMINI_API_KEY");
  }

  const url = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: promptText }],
      },
    ],
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Error Gemini: ${errorText}`);
  }

  const data = await response.json();

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join(" ")
      .trim() || "";

  if (!text) {
    throw new Error("Gemini devolvió una respuesta vacía");
  }

  return text;
}

// Prompt para la opinión final de la IA
function buildFinalOpinionPrompt({ asinA, asinB, blogA, blogB, lang }) {
  const langUpper = (lang || "ES").toUpperCase();

  if (langUpper === "ES") {
    return `
Eres una IA experta en comparar productos de Amazon.
Tienes a continuación DOS borradores de posts de blog escritos con la metodología LAMA.
Cada post analiza un producto diferente y contiene secciones como:
- "Resumen Lama"
- "Lo que más gusta"
- "Áreas de mejora"
- "Pros y contras"
- "A quién le recomendamos este producto"
- "Conclusión"

No repitas el texto literal de los blogs, pero ÚSALOS como base para entender los puntos fuertes y débiles de cada producto.

DATOS:
- Producto A (ASIN ${asinA}):
${blogA}

- Producto B (ASIN ${asinB}):
${blogB}

TAREA:
1. Escribe una única OPINIÓN FINAL COMPARATIVA en español, en 1–2 párrafos cortos.
2. Deja claro:
   - Para qué tipo de persona o uso recomendarías más el Producto A.
   - Para qué tipo de persona o uso recomendarías más el Producto B.
   - Si tuvieras que elegir SOLO UNO para la mayoría de usuarios, cuál y por qué.
3. Estilo:
   - Lenguaje claro, cercano y honesto.
   - No uses formato markdown, ni listas con guiones, ni emojis.
   - No inventes funcionalidades que no se deduzcan de los textos.
`;
  } else {
    // Versión en inglés, por si algún día la necesitas
    return `
You are an AI that compares two Amazon products using two blog drafts written with the LAMA methodology.
Each blog has sections like "Lama summary", "Highlights", "Improvements", "Pros and Cons",
"Recommended for", and "Conclusion".

Do NOT copy the blogs verbatim, but USE them as the basis for your reasoning.

DATA:
- Product A (ASIN ${asinA}):
${blogA}

- Product B (ASIN ${asinB}):
${blogB}

TASK:
1. Write a single FINAL COMPARATIVE OPINION in English, 1–2 short paragraphs.
2. Make clear:
   - For what type of person/use Product A is a better fit.
   - For what type of person/use Product B is a better fit.
   - If you had to pick ONLY ONE for most users, which one and why.
3. Style:
   - Clear, friendly, honest language.
   - No markdown formatting, no bullet lists, no emojis.
   - Do not invent features that are not supported by the texts.
`;
  }
}

// ---------------------- HANDLER PRINCIPAL ----------------------
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: "",
    };
  }

  try {
    const query = event.queryStringParameters || {};
    const mode = query.mode || "index";

    // Cuerpo por si el frontend manda JSON en POST
    let bodyData = {};
    if (event.body) {
      try {
        bodyData = JSON.parse(event.body);
      } catch {
        bodyData = {};
      }
    }

    if (mode === "index") {
      // Devuelve el índice LAMA completo
      const indexData = loadLamaIndex();
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          mode: "index",
          data: indexData,
        }),
      };
    }

    if (mode === "metrics") {
      // Si algún día lo necesitas, puedes construir métricas aquí.
      // De momento devuelve un stub para no romper nada.
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          mode: "metrics",
          message:
            "Endpoint 'metrics' disponible. Implementa aquí las métricas si las necesitas.",
        }),
      };
    }

    if (mode === "narrative") {
      // Obtenemos ASIN y idioma desde query o body
      const asinA =
        bodyData.asinA || bodyData.asin1 || query.asinA || query.asin1;
      const asinB =
        bodyData.asinB || bodyData.asin2 || query.asinB || query.asin2;
      const lang = bodyData.lang || query.lang || "ES";

      if (!asinA || !asinB) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error:
              "Faltan ASINs para generar la opinión final de la IA (asinA y asinB).",
          }),
        };
      }

      let blogA;
      let blogB;

      try {
        blogA = loadBlogByAsin(asinA, lang);
        blogB = loadBlogByAsin(asinB, lang);
      } catch (fileErr) {
        console.error("Error cargando blogs:", fileErr);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error:
              "No se encontraron los blogs para uno o ambos productos. Revisa los archivos *_ES_blog.txt.",
          }),
        };
      }

      const prompt = buildFinalOpinionPrompt({
        asinA,
        asinB,
        blogA,
        blogB,
        lang,
      });

      try {
        const opinion = await callGemini(prompt);

        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            success: true,
            mode: "narrative",
            opinion,
          }),
        };
      } catch (gemErr) {
        console.error("Error generando la opinión final de la IA:", gemErr);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({
            success: false,
            error:
              "Error generando la opinión final de la IA: " +
              (gemErr.message || String(gemErr)),
          }),
        };
      }
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
        error:
          "Error interno en verifymyth: " + (err.message || String(err)),
      }),
    };
  }
};
