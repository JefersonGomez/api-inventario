// src/modules/assistant/assistant.service.ts
import type { Content, Part } from "@google/genai";
import { toolDeclarations, toolExecutors } from "./assistant.tools.ts";
import { stripCosts } from "../../middlewares/costs.middleware.ts";
import { generateMetered, MODELS } from "../ai/ai.service.ts";
import { assertAiChatQuota, getCompany } from "../company/company.service.ts";
import { checkScope, looksLikeCode, REFUSAL, sanitizeToolResult, SYSTEM_INSTRUCTION, type Generate } from "./assistant.guard.ts";

// Herramientas que solo se ofrecen con costs.view (devuelven valores a costo)
const COST_TOOLS = new Set(["getInventoryValueReport"]);

const MODEL = MODELS.chat;
const MAX_TOOL_ROUNDS = 5;

// las reglas y barreras (solo el negocio de quien pregunta) viven en assistant.guard.ts
// El asistente respeta los permisos de quien pregunta: sin costs.view no se le ofrecen las
// herramientas de valor a costo y a lo que devuelven las demás se le quitan los costos.
// generate: inyectable para las pruebas (por defecto, Gemini con medidor y presupuesto)
export async function chatWithAssistant(userMessage: string, permissions: string[], userId?: string, generate?: Generate) {
  const gen: Generate = generate ?? ((params) => generateMetered("CHAT", params, userId));
  await assertAiChatQuota(); // tope mensual de preguntas del plan (cuida el costo de la IA)
  // 1. fuera del negocio (código, conocimiento general, otras empresas, pedir las instrucciones…): no se responde
  const scope = await checkScope(userMessage, gen);
  if (!scope.inScope) return { reply: REFUSAL[scope.lang], blocked: true };

  const seesCosts = permissions.includes("costs.view");
  const { currency } = await getCompany();
  const money = currency === "USD" ? "dólares (US$)" : "colones (₡)";
  const declarations = toolDeclarations.filter((d) => seesCosts || !COST_TOOLS.has(d.name ?? ""));
  const contents: Content[] = [
    { role: "user", parts: [{ text: userMessage }] },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // cada vuelta con herramientas es una consulta: todas pasan por el medidor y el presupuesto
    const response = await gen({
      model: MODEL,
      contents,
      config: {
        // la fecha de hoy, para resolver "esta semana", "el mes pasado"…
        systemInstruction: `${SYSTEM_INSTRUCTION}
Hoy es ${new Date().toLocaleDateString("sv")}. Los montos están en ${money}: usa ese símbolo.`,
        tools: [{ functionDeclarations: declarations }],
      },
    });

    const functionCalls = response.functionCalls;

    if (!functionCalls || functionCalls.length === 0) {
      // 4. control de salida: una respuesta del negocio nunca trae código
      if (looksLikeCode(response.text ?? "")) return { reply: REFUSAL[scope.lang], blocked: true };
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
          result = sanitizeToolResult(JSON.parse(JSON.stringify(result))); // 3. sin identificadores de la empresa
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