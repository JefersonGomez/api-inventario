// src/modules/assistant/assistant.service.ts
import { GoogleGenAI } from "@google/genai";
import type { Content, Part } from "@google/genai";
import { toolDeclarations, toolExecutors } from "./assistant.tools.ts";
import { stripCosts } from "../../middlewares/costs.middleware.ts";

// Herramientas que solo se ofrecen con costs.view (devuelven valores a costo)
const COST_TOOLS = new Set(["getInventoryValueReport"]);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "API_KEY_DEFAULT" });
const MODEL = "gemini-3.6-flash";
const MAX_TOOL_ROUNDS = 5;

const SYSTEM_INSTRUCTION = `
Sos un asistente de solo lectura para un sistema de inventario.
Respondé siempre basándote en los datos reales que obtengas de las herramientas disponibles.
Nunca inventes cifras, nombres de productos, ni cantidades.
Si una pregunta requiere datos que no podés obtener con las herramientas disponibles, decilo explícitamente en vez de inventar una respuesta.
Respondé siempre en el mismo idioma en el que te escribe el usuario. Si te escribe en inglés, respondé en inglés; si te escribe en español, respondé en español; y así con cualquier otro idioma.
`.trim();
// El asistente respeta los permisos de quien pregunta: sin costs.view no se le ofrecen las
// herramientas de valor a costo y a lo que devuelven las demás se le quitan los costos.
export async function chatWithAssistant(userMessage: string, permissions: string[]) {
  const seesCosts = permissions.includes("costs.view");
  const declarations = toolDeclarations.filter((d) => seesCosts || !COST_TOOLS.has(d.name ?? ""));
  const contents: Content[] = [
    { role: "user", parts: [{ text: userMessage }] },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: [{ functionDeclarations: declarations }],
      },
    });

    const functionCalls = response.functionCalls;

    if (!functionCalls || functionCalls.length === 0) {
      return { reply: response.text };
    }

    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) {
      contents.push(modelContent);
    } else {
      // fallback defensivo, no debería pasar en la práctica
      contents.push({
        role: "model",
        parts: functionCalls.map((call) => ({ functionCall: call })),
      });
    }

    const functionResponseParts: Part[] = [];

    for (const call of functionCalls) {
      const toolName = call.name;
      const allowed = toolName && (seesCosts || !COST_TOOLS.has(toolName));
      const executor = allowed ? toolExecutors[toolName] : undefined;

      let result;

      if (typeof executor !== "function") {
        result = { error: `Herramienta desconocida o no ejecutable: ${toolName}` };
      } else {
        try {
          result = await executor(call.args);
          if (!seesCosts) result = stripCosts(JSON.parse(JSON.stringify(result)));
        } catch (error) {
          result = { error: (error as Error).message };
        }
      }

      functionResponseParts.push({
        functionResponse: {
          id: call.id ?? call.name ?? `call-${round}-${functionResponseParts.length}`,
          name: toolName ?? "unknown",
          response: { result },
        },
      });
    }

    contents.push({ role: "user", parts: functionResponseParts });
  }

  throw new Error("El asistente no pudo completar la respuesta tras varios intentos");
}