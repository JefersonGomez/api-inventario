// src/modules/assistant/assistant.service.ts
import type { Content, Part } from "@google/genai";
import { toolDeclarations, toolExecutors } from "./assistant.tools.ts";
import { stripCosts } from "../../middlewares/costs.middleware.ts";
import { generateMetered, MODELS } from "../ai/ai.service.ts";

// Herramientas que solo se ofrecen con costs.view (devuelven valores a costo)
const COST_TOOLS = new Set(["getInventoryValueReport"]);

const MODEL = MODELS.chat;
const MAX_TOOL_ROUNDS = 5;

const SYSTEM_INSTRUCTION = `
Sos un asistente de solo lectura para un sistema de inventario y punto de venta (ventas, devoluciones, crédito y cuentas por cobrar).
Respondé siempre basándote en los datos reales que obtengas de las herramientas disponibles.
Nunca inventes cifras, nombres de productos, ni cantidades.
Si una pregunta requiere datos que no podés obtener con las herramientas disponibles, decilo explícitamente en vez de inventar una respuesta.
Respondé siempre en el mismo idioma en el que te escribe el usuario. Si te escribe en inglés, respondé en inglés; si te escribe en español, respondé en español; y así con cualquier otro idioma.
`.trim();
// El asistente respeta los permisos de quien pregunta: sin costs.view no se le ofrecen las
// herramientas de valor a costo y a lo que devuelven las demás se le quitan los costos.
export async function chatWithAssistant(userMessage: string, permissions: string[], userId?: string) {
  const seesCosts = permissions.includes("costs.view");
  const declarations = toolDeclarations.filter((d) => seesCosts || !COST_TOOLS.has(d.name ?? ""));
  const contents: Content[] = [
    { role: "user", parts: [{ text: userMessage }] },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // cada vuelta con herramientas es una consulta: todas pasan por el medidor y el presupuesto
    const response = await generateMetered("CHAT", {
      model: MODEL,
      contents,
      config: {
        // la fecha de hoy, para resolver "esta semana", "el mes pasado"…
        systemInstruction: `${SYSTEM_INSTRUCTION}
Hoy es ${new Date().toLocaleDateString("sv")}.`,
        tools: [{ functionDeclarations: declarations }],
      },
    }, userId);

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
          result = await executor(call.args, { permissions });
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