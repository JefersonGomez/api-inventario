// Bloque 6C: importar con IA — solo una muestra, respuesta validada, guardada por formato y con tope por plan
import request from "supertest"
import app from "../../app.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { resetDb, createUser } from "../../test/helpers.ts"
import { setImportAskerForTests } from "./ai-import.service.ts"
import { recordAiUsage } from "../ai/ai.service.ts"

describe("Importar productos con ayuda de la IA", () => {
  let admin: Awaited<ReturnType<typeof createUser>>
  const prompts: string[] = []
  let answer = ""

  // en vez de Gemini: guarda lo que se le mandaría y anota el consumo como lo haría generateMetered
  setImportAskerForTests(async (prompt, userId) => {
    prompts.push(prompt)
    await recordAiUsage("IMPORT", "gemini-3.5-flash-lite", 800, 120, userId)
    return answer
  })

  const messy = [
    ["LISTA DE PRECIOS OCTUBRE", "", ""],
    ["", "", ""],
    ["Artículo", "P. Venta ₡", "Cant", "Cód. barra"],
    ["Martillo", "5.500", 10, "7501234567893"],
    ["Clavos 1kg", "1.200,50", 4, ""],
  ]
  const send = (rows: unknown[][], u = admin) => request(app).post("/products/import/ai-map").set(u.auth).send({ rows })

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
  })
  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("manda solo la muestra y devuelve fila de encabezados y columnas validadas", async () => {
    answer = JSON.stringify({
      headerRow: 2,
      columns: [
        { field: "name", column: 0 }, { field: "price", column: 1 }, { field: "stock", column: 2 }, { field: "barcode", column: 3 },
        { field: "cost", column: 1 }, // columna repetida: se ignora
        { field: "inventado", column: 2 }, // campo desconocido: se ignora
        { field: "sku", column: 40 }, // fuera de la muestra: se ignora
      ],
    })
    const res = await send(messy)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ headerRow: 2, mapping: { name: 0, price: 1, stock: 2, barcode: 3 }, cached: false, used: 1, limit: 5, remaining: 4 })
    expect(Object.keys(res.body.mapping)).toHaveLength(4)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("Martillo")
  })

  it("el mismo formato otra vez usa la respuesta guardada: no consulta ni gasta", async () => {
    const res = await send(messy)
    expect(res.body).toMatchObject({ cached: true, headerRow: 2, used: 1 })
    expect(prompts).toHaveLength(1)
  })

  it("nunca manda más de 25 filas ni celdas largas", async () => {
    answer = JSON.stringify({ headerRow: 0, columns: [{ field: "name", column: 0 }] })
    const big = Array.from({ length: 25 }, (_, i) => [`Producto ${i} ${"x".repeat(200)}`])
    await send(big)
    expect(prompts.at(-1)).not.toContain("x".repeat(81))
    expect((await send(Array.from({ length: 26 }, () => ["a"]))).status).toBe(400) // el cliente tampoco puede mandar más
  })

  it("respuesta inválida de la IA → error claro; al llegar al tope del plan → 429", async () => {
    answer = "esto no es JSON"
    expect((await send([["otro formato", 1]])).body.error).toMatch(/respuesta válida/)
    answer = JSON.stringify({ headerRow: 0, columns: [] })
    // Básico: 5 al mes (ya van 3 consultas reales)
    await send([["formato 4"]])
    await send([["formato 5"]])
    const over = await send([["formato 6"]])
    expect(over.status).toBe(429)
    expect(over.body.error).toMatch(/5 importaciones con IA/)
    expect((await request(app).get("/products/import/ai-quota").set(admin.auth)).body).toEqual({ used: 5, limit: 5, remaining: 0 })
    // lo ya guardado sigue funcionando sin tope
    expect((await send(messy)).body.cached).toBe(true)

    const employee = await createUser("EMPLOYE", admin.companyId)
    expect((await send(messy, employee)).status).toBe(403)
  })
})
