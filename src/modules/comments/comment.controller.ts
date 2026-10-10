// comment.controller.ts
import type { Request, Response } from "express";
import * as service from "./comment.service.ts";
import { emit, userRoom } from "../../shared/realtime.ts";

// un handler por tipo de hilo; se montan en los routers de solicitudes y de órdenes
export function getCommentsHandler(kind: service.ThreadKind) {
  return async (req: Request, res: Response) => {
    try {
      const comments = await service.getComments(kind, req.params.id as string, req.user!);
      if (!comments) return res.status(404).json({ error: "No encontrado" });
      res.json(comments);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  };
}

export function addCommentHandler(kind: service.ThreadKind) {
  return async (req: Request, res: Response) => {
    try {
      const result = await service.addComment(kind, req.params.id as string, req.user!, req.body.body);
      if (!result) return res.status(404).json({ error: "No encontrado" });
      emit([req.user!.id, ...result.recipients].map(userRoom), ["comments", "notifications"]);
      res.status(201).json(result.comment);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  };
}
