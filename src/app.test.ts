import app from "./app.ts"
import request from "supertest"

describe("GET /health", ()=>{
    it("deberia responder con status 200 y status ok", async ()=>{
        const res = await request(app).get("/health")
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ status: "ok" })
    })
})