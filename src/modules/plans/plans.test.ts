// Límites públicos de los planes (los usa la landing en Precios)
import request from "supertest"
import app from "../../app.ts"
import { PLANS } from "../../config/plans.ts"

describe("GET /plans", () => {
  it("es público, en orden y sin detalles internos", async () => {
    const res = await request(app).get("/plans")
    expect(res.status).toBe(200)
    expect(res.body.map((p: { code: string }) => p.code)).toEqual(["INVOICING", "BASIC", "PRO", "BUSINESS"])
    const pro = res.body.find((p: { code: string }) => p.code === "PRO")
    expect(pro).toMatchObject({ maxUsersPerCompany: PLANS.PRO.maxUsersPerCompany, maxBranches: PLANS.PRO.maxBranches, invoicingOnly: false })
    expect(pro).not.toHaveProperty("aiImportsPerMonth")
  })
})
