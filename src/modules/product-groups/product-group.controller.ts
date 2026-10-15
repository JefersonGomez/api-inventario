import type { Request, Response } from "express"
import { createProductGroup, deleteProductGroup, getProductGroups, updateProductGroup } from "./product-group.service.ts"
import { emit, EVERYONE, STOCK_TOPICS } from "../../shared/realtime.ts"

const TOPICS = [...STOCK_TOPICS, "product-groups"]

export async function getProductGroupsController(_req: Request, res: Response) {
  try {
    res.status(200).json(await getProductGroups())
  } catch (error) {
    res.status(500).json({ error: (error as Error).message })
  }
}

export async function createProductGroupController(req: Request, res: Response) {
  try {
    const group = await createProductGroup(req.body, req.user!.id)
    emit(EVERYONE, TOPICS)
    res.status(201).json(group)
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}

export async function updateProductGroupController(req: Request, res: Response) {
  try {
    const group = await updateProductGroup(String(req.params.id), req.body, req.user!.id)
    emit(EVERYONE, TOPICS)
    res.status(200).json(group)
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}

export async function deleteProductGroupController(req: Request, res: Response) {
  try {
    await deleteProductGroup(String(req.params.id), req.user!.id)
    emit(EVERYONE, TOPICS)
    res.status(204).end()
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}
