import type { Request, Response } from "express"
import { getProfile, updateAvatar, changePassword } from "./user.service.ts"

export async function getProfileController(req: Request, res: Response) {
  try {
    const userId = req.user!.id
    const profile = await getProfile(userId)
    res.status(200).json(profile)
  } catch (error) {
    res.status(404).json({ error: (error as Error).message })
  }
}

export async function updateAvatarController(req: Request, res: Response) {
  try {
    const userId = req.user!.id

    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ningún archivo" })
    }

    const updatedProfile = await updateAvatar(userId, req.file.filename)
    res.status(200).json(updatedProfile)
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}

export async function changePasswordController(req: Request, res: Response) {
  try {
    const userId = req.user!.id
    const { currentPassword, newPassword } = req.body

    const result = await changePassword(userId, currentPassword, newPassword)
    res.status(200).json(result)
  } catch (error) {
    res.status(400).json({ error: (error as Error).message })
  }
}