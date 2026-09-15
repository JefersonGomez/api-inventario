import type { Request, Response } from "express"
import {
  createSupplier,
  getAllSuppliers,
  getSupplierById,
  updateSupplier,
  deleteSupplier,
} from "./supplier.service.ts"

export async function createSupplierController(req: Request, res: Response) {
  try {
    const { name, email, phone, address } = req.body
    const supplier = await createSupplier(name, email, phone, address)
    res.status(201).json(supplier)
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}

export async function getAllSuppliersController(req: Request, res: Response) {
  try {
    const suppliers = await getAllSuppliers()
    res.status(200).json(suppliers)
  } catch (error) {
    res.status(500).json({ error: (error as Error).message })
  }
}

export async function getSupplierByIdController(req: Request, res: Response) {
  try {
    const { id } = req.params
    if (!id || typeof id !== "string") {
      return res.status(400).json({ message: "El ID es requerido y debe ser un texto" })
    }
    const supplier = await getSupplierById(id)
    res.status(200).json(supplier)
  } catch (error) {
    res.status(404).json({ error: (error as Error).message })
  }
}

export async function updateSupplierController(req: Request, res: Response) {
  try {
    const { id } = req.params
    if (!id || typeof id !== "string") {
      return res.status(400).json({ message: "El ID es requerido y debe ser un texto" })
    }
    const { name, email, phone, address } = req.body
    const supplier = await updateSupplier(id, name, email, phone, address)
    res.status(200).json(supplier)
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}

export async function deleteSupplierController(req: Request, res: Response) {
  try {
    const { id } = req.params
    if (!id || typeof id !== "string") {
      return res.status(400).json({ message: "El ID es requerido y debe ser un texto" })
    }
    const supplier = await deleteSupplier(id)
    res.status(200).json(supplier)
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}