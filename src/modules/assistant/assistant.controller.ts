import type { Request, Response } from "express";
import { chatWithAssistant } from "./assistant.service.ts";
import { AiPausedError } from "../ai/ai.service.ts";

export async function chatHandler(req: Request, res: Response) {
  try {
    const { message } = req.body;
    const result = await chatWithAssistant(message, req.user!.permissions, req.user!.id);
    res.json(result);
  } catch (error) {
    // presupuesto de IA agotado: 503 con un mensaje claro (no es un error del servidor)
    const e = error as Error & { status?: number; code?: string };
    // presupuesto de la plataforma agotado: 503; tope del plan: 429 (los dos con mensaje claro)
    res.status(error instanceof AiPausedError ? 503 : e.status ?? 500).json({ error: e.message, ...(e.code && { code: e.code }) });
  }
}