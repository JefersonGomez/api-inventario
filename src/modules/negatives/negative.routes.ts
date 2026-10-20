import { Router, type Request, type Response } from "express"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
import { validate, validateQuery } from "../../middlewares/validate.middleware.ts"
import { emit, EVERYONE, STOCK_TOPICS } from "../../shared/realtime.ts"
import { listNegatives, negativeListQuerySchema, resolveNegative, resolveNegativeSchema } from "./negative.service.ts"

const fail = (res: Response, error: unknown) =>
  res.status((error as { status?: number }).status ?? 400).json({ error: (error as Error).message })

async function listHandler(_req: Request, res: Response) {
  try {
    res.json(await listNegatives(res.locals.query))
  } catch (error) {
    fail(res, error)
  }
}

async function resolveHandler(req: Request<{ id: string }>, res: Response) {
  try {
    const negative = await resolveNegative(req.params.id, req.body, req.user!.id)
    emit(EVERYONE, [...STOCK_TOPICS, "negatives"])
    res.json(negative)
  } catch (error) {
    fail(res, error)
  }
}

// Las revisa y resuelve quien maneja el inventario (stock.move), en sus ubicaciones
export const router = Router()
router.get("/", validateQuery(negativeListQuerySchema), Authenticated, Can("stock.move"), listHandler)
router.post("/:id/resolve", validate(resolveNegativeSchema), Authenticated, Can("stock.move"), resolveHandler)
