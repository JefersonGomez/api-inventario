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
    res.status(error instanceof AiPausedError ? 503 : 500).json({ error: (error as Error).message });
  }
}