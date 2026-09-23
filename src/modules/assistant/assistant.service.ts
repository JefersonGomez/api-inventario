// src/modules/assistant/assistant.service.ts
import { GoogleGenAI } from "@google/genai";
import type { Content, Part } from "@google/genai";
import { toolDeclarations, toolExecutors } from "./assistant.tools.ts";

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
export async function chatWithAssistant(userMessage: string) {
  const contents: Content[] = [
    { role: "user", parts: [{ text: userMessage }] },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: [{ functionDeclarations: toolDeclarations }],
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
      const executor = toolName ? toolExecutors[toolName] : undefined;

      let result;

      if (typeof executor !== "function") {
        result = { error: `Herramienta desconocida o no ejecutable: ${toolName}` };
      } else {
        try {
          result = await executor(call.args);
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