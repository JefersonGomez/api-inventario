import type { Request, Response } from "express"
import { cancelCount, closeCount, createCount, getCount, listCounts, saveCount } from "./stock-count.service.ts"
import { emit, EVERYONE, STOCK_TOPICS } from "../../shared/realtime.ts"

const TOPICS = ["stock-counts"]

export async function listCountsHandler(_req: Request, res: Response) {
  try {
    res.json(await listCounts(res.locals.query))
  } catch (error) {
    res.status(500).json({ error: (error as Error).message })
  }
}

export async function getCountHandler(req: Request<{ id: string }>, res: Response) {
  try {
    res.json(await getCount(req.params.id))
  } catch (error) {
    res.status(404).json({ error: (error as Error).message })
  }
}

export async function createCountHandler(req: Request, res: Response) {
  try {
    const count = await createCount(req.body, req.user!)
    emit(EVERYONE, TOPICS)
    res.status(201).json(count)
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}

export async function saveCountHandler(req: Request<{ id: string }>, res: Response) {
  try {
    const count = await saveCount(req.params.id, req.body)
    emit(EVERYONE, TOPICS)
    res.json(count)
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}

export async function closeCountHandler(req: Request<{ id: string }>, res: Response) {
  try {
    const count = await closeCount(req.params.id, req.user!)
    emit(EVERYONE, [...TOPICS, ...STOCK_TOPICS])
    res.json(count)
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}

export async function cancelCountHandler(req: Request<{ id: string }>, res: Response) {
  try {
    const count = await cancelCount(req.params.id, req.user!)
    emit(EVERYONE, TOPICS)
    res.json(count)
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}
