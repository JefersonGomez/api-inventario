import type { Request, Response } from "express"
import { createLocation, listLocations, updateLocation } from "./location.service.ts"
import { emit, EVERYONE } from "../../shared/realtime.ts"

const TOPICS = ["locations"]

// GET /locations?inactive=1 (las desactivadas solo le sirven a quien administra la empresa)
export async function listLocationsHandler(req: Request, res: Response) {
  try {
    const inactive = req.query.inactive === "1" && req.user!.permissions.includes("company.manage")
    res.json(await listLocations(inactive))
  } catch (error) {
    res.status(500).json({ error: (error as Error).message })
  }
}

export async function createLocationHandler(req: Request, res: Response) {
  try {
    const location = await createLocation(req.body, req.user!.id)
    emit(EVERYONE, TOPICS)
    res.status(201).json(location)
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}

export async function updateLocationHandler(req: Request<{ id: string }>, res: Response) {
  try {
    const location = await updateLocation(req.params.id, req.body, req.user!.id)
    emit(EVERYONE, TOPICS)
    res.json(location)
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}
