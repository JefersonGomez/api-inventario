import type { Request, Response } from "express"
import { createCustomer, deleteCustomer, getCustomerById, getCustomers, updateCustomer } from "./customer.service.ts"
import { emit, EVERYONE } from "../../shared/realtime.ts"

const TOPICS = ["customers"]

export async function getCustomersController(_req: Request, res: Response) {
  try {
    res.status(200).json(await getCustomers())
  } catch (error) {
    res.status(500).json({ error: (error as Error).message })
  }
}

export async function getCustomerByIdController(req: Request, res: Response) {
  try {
    res.status(200).json(await getCustomerById(String(req.params.id)))
  } catch (error) {
    res.status(404).json({ error: (error as Error).message })
  }
}

export async function createCustomerController(req: Request, res: Response) {
  try {
    const customer = await createCustomer(req.body, req.user!.id)
    emit(EVERYONE, TOPICS)
    res.status(201).json(customer)
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}

export async function updateCustomerController(req: Request, res: Response) {
  try {
    const customer = await updateCustomer(String(req.params.id), req.body, req.user!.id)
    emit(EVERYONE, TOPICS)
    res.status(200).json(customer)
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}

export async function deleteCustomerController(req: Request, res: Response) {
  try {
    await deleteCustomer(String(req.params.id), req.user!.id)
    emit(EVERYONE, TOPICS)
    res.status(204).end()
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}
