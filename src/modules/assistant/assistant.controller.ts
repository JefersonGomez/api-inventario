import type { Request, Response } from "express";
import { chatWithAssistant } from "./assistant.service.ts";

export async function chatHandler(req: Request, res: Response) {
  try {
    const { message } = req.body;
    const result = await chatWithAssistant(message);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
}