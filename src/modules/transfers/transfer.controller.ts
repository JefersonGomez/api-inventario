import type { Request, Response } from "express"
import { cancelTransfer, createTransfer, getTransfer, listTransfers, receiveTransfer } from "./transfer.service.ts"
import { emit, EVERYONE, STOCK_TOPICS } from "../../shared/realtime.ts"

const TOPICS = [...STOCK_TOPICS, "transfers"]
const status = (error: unknown) => (error as { status?: number }).status ?? 400

export async function listTransfersHandler(_req: Request, res: Response) {
  try {
    res.json(await listTransfers(res.locals.query))
  } catch (error) {
    res.status(500).json({ error: (error as Error).message })
  }
}

export async function getTransferHandler(req: Request<{ id: string }>, res: Response) {
  try {
    res.json(await getTransfer(req.params.id))
  } catch (error) {
    res.status(404).json({ error: (error as Error).message })
  }
}

export async function createTransferHandler(req: Request, res: Response) {
  try {
    const transfer = await createTransfer(req.body, req.user!)
    emit(EVERYONE, TOPICS)
    res.status(201).json(transfer)
  } catch (error) {
    res.status(status(error)).json({ error: (error as Error).message })
  }
}

export async function receiveTransferHandler(req: Request<{ id: string }>, res: Response) {
  try {
    const transfer = await receiveTransfer(req.params.id, req.body, req.user!)
    emit(EVERYONE, TOPICS)
    res.json(transfer)
  } catch (error) {
    res.status(status(error)).json({ error: (error as Error).message })
  }
}

export async function cancelTransferHandler(req: Request<{ id: string }>, res: Response) {
  try {
    const transfer = await cancelTransfer(req.params.id, req.user!)
    emit(EVERYONE, TOPICS)
    res.json(transfer)
  } catch (error) {
    res.status(status(error)).json({ error: (error as Error).message })
  }
}
