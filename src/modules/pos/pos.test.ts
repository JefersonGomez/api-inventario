// Bloque 7A: cajas, turnos con código, venta con tiquete y salida de stock, cierre con arqueo
import request from "supertest"
import app from "../../app.ts"
import { resetDb, createUser, mainLocationId } from "../../test/helpers.ts"
import { prismaRoot as prisma } from "../../config/database.ts"
import { Prisma } from "../../generated/prisma/client.ts"
import { computeDiscounts } from "./pos.service.ts"

type User = Awaited<ReturnType<typeof createUser>>

describe("Punto de venta", () => {
  let admin: User, manager: User, cashier: User, cashier2: User
  let main: string, registerId: string, productId: string, cashierPin: string, managerPin: string
  const stockAt = async () =>
    Number((await prisma.productStock.findUnique({ where: { productId_locationId: { productId, locationId: main } } }))?.quantity ?? 0)
  const sell = (u: User, body: object) => request(app).post("/pos/sales").set(u.auth).send(body)

  beforeAll(async () => {
    await resetDb()
    admin = await createUser("ADMIN")
    const c = admin.companyId
    main = await mainLocationId(c)
    manager = await createUser("MANAGER", c)
    cashier = await createUser("CASHIER", c)
    cashier2 = await createUser("CASHIER", c)
    managerPin = (await request(app).post(`/users/${manager.user.id}/pin`).set(admin.auth).send({ pin: "5937" })).body.pin
    cashierPin = (await request(app).post(`/users/${cashier.user.id}/pin`).set(manager.auth).send({ pin: "4821" })).body.pin
    await request(app).post(`/users/${cashier2.user.id}/pin`).set(manager.auth).send({ pin: "7364" })
    const category = await prisma.category.create({ data: { companyId: c, name: "General" } })
    productId = (await request(app).post("/products").set(admin.auth)
      .send({ sku: "ARZ", name: "Arroz", price: 1130, stock: 10, minStock: 0, categoryId: category.id, locationId: main })).body.id
  })

  afterAll(async () => {
    await resetDb()
    await prisma.$disconnect()
  })

  it("cajas: terminal correlativo, límite del plan y solo en sucursales", async () => {
    const res = await request(app).post("/pos/registers").set(admin.auth).send({ locationId: main, name: "Caja 1" })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ terminalCode: "00001", ticketWidth: 80 })
    registerId = res.body.id
    // plan BASIC: 1 caja por sucursal
    expect((await request(app).post("/pos/registers").set(admin.auth).send({ locationId: main, name: "Caja 2" })).body.error).toMatch(/Tu plan permite 1/)
    expect((await request(app).post("/pos/registers").set(cashier.auth).send({ locationId: main, name: "X" })).status).toBe(403)
    expect((await request(app).get("/pos/registers").set(cashier.auth)).body).toHaveLength(1)
  })

  it("abrir caja: con su código vigente; vencido = bloqueada y la renueva el encargado", async () => {
    expect((await request(app).post("/pos/session").set(cashier.auth).send({ registerId, pin: "0000", openingAmount: 20000 })).body.error).toMatch(/no es correcto/)
    // código vencido
    await prisma.membership.updateMany({ where: { userId: cashier.user.id }, data: { pinSetAt: new Date(2020, 0, 1) } })
    const locked = await request(app).post("/pos/session").set(cashier.auth).send({ registerId, pin: cashierPin, openingAmount: 20000 })
    expect(locked.status).toBe(423)
    expect(locked.body.code).toBe("PIN_EXPIRED")
    // el código de otro cajero no sirve para renovar; el del encargado sí
    expect((await request(app).post("/pos/session/renew-code").set(cashier.auth).send({ managerPin: "7364" })).status).toBe(403)
    const renewed = await request(app).post("/pos/session/renew-code").set(cashier.auth).send({ managerPin })
    expect(renewed.body.pin).toMatch(/^\d{6}$/)
    cashierPin = renewed.body.pin

    const open = await request(app).post("/pos/session").set(cashier.auth).send({ registerId, pin: cashierPin, openingAmount: 20000 })
    expect(open.status).toBe(201)
    expect(open.body).toMatchObject({ status: "OPEN", register: { id: registerId }, summary: { openingAmount: 20000, salesCount: 0 } })
    // la caja ya está abierta: otra persona no la abre
    expect((await request(app).post("/pos/session").set(cashier2.auth).send({ registerId, pin: "7364", openingAmount: 0 })).status).toBe(409)
    // y no se desactiva con el turno abierto
    expect((await request(app).patch(`/pos/registers/${registerId}`).set(admin.auth).send({ isActive: false })).body.error).toMatch(/turno abierto/)
  })

  it("vender: tiquete con consecutivo de la caja, pagos con vuelto y salida de stock", async () => {
    expect((await sell(cashier2, { lines: [{ productId, quantity: 1 }], payments: [{ method: "CASH", amount: 1130 }] })).body.code).toBe("NO_SESSION")
    const res = await sell(cashier, {
      lines: [{ productId, quantity: 3 }],
      payments: [{ method: "CASH", amount: 2000, tendered: 5000 }, { method: "SINPE", amount: 1390, reference: "SP123" }],
    })
    expect(res.status).toBe(201)
    expect(res.body.document).toMatchObject({ type: "TICKET", consecutive: "00100001040000000001" })
    expect(Number(res.body.document.total)).toBe(3390)
    expect(res.body.document.payments).toEqual(expect.arrayContaining([expect.objectContaining({ method: "CASH", tendered: 5000 })]))
    expect(res.body).toMatchObject({ register: { terminalCode: "00001", ticketWidth: 80 }, cashier: { id: cashier.user.id } })
    expect(await stockAt()).toBe(7)
    const moves = await prisma.stockMovement.findMany({ where: { source: "SALE", sourceId: res.body.document.id } })
    expect(moves).toEqual([expect.objectContaining({ type: "OUT", locationId: main })])
  })

  it("sin stock suficiente no se vende y no queda nada a medias", async () => {
    const res = await sell(cashier, { lines: [{ productId, quantity: 8 }], payments: [{ method: "CARD", amount: 9040 }] })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/Arroz \(hay 7\)/)
    expect((await sell(cashier, { lines: [{ productId, quantity: 1 }], payments: [{ method: "CARD", amount: 500 }] })).body.error).toMatch(/no suman/)
    expect(await stockAt()).toBe(7)
    expect(await prisma.document.count()).toBe(1)
  })

  it("negativas: sin stock se vende con el código del encargado, queda en negativo y le llega a inventario", async () => {
    const body = { lines: [{ productId, quantity: 9 }], payments: [{ method: "CARD", amount: 10170 }] }
    const ask = await sell(cashier, body)
    expect(ask.status).toBe(409)
    expect(ask.body).toMatchObject({ code: "NEGATIVE_NEEDS_AUTH", shortages: [{ productId, stock: 7, wanted: 9 }] })
    // el código de otro cajero no autoriza negativas
    expect((await sell(cashier, { ...body, negativePin: "7364" })).status).toBe(403)
    const res = await sell(cashier, { ...body, negativePin: managerPin })
    expect(res.status).toBe(201)
    expect(res.body.negatives).toBe(1)
    expect(await stockAt()).toBe(-2)
    const neg = await prisma.stockNegative.findFirstOrThrow()
    expect(neg).toMatchObject({ reportedById: cashier.user.id, authorizedById: manager.user.id, status: "OPEN" })
    expect(Number(neg.quantity)).toBe(2)
    expect(await prisma.notification.count({ where: { type: "stockNegative", userId: manager.user.id } })).toBe(1)

    // inventario la ve y la resuelve contando lo que hay de verdad
    expect((await request(app).get("/negatives").set(cashier.auth)).status).toBe(403)
    const list = await request(app).get("/negatives?status=OPEN").set(admin.auth)
    expect(list.body).toMatchObject({ openCount: 1, items: [{ product: { name: "Arroz" }, reportedBy: { id: cashier.user.id } }] })
    expect((await request(app).post(`/negatives/${neg.id}/resolve`).set(admin.auth).send({})).status).toBe(400)
    const solved = await request(app).post(`/negatives/${neg.id}/resolve`).set(admin.auth).send({ resolution: "Había 5 en la bodega de atrás", countedQuantity: 5 })
    expect(solved.body).toMatchObject({ status: "RESOLVED", resolvedBy: { id: admin.user.id } })
    expect(await stockAt()).toBe(5)
    expect((await request(app).post(`/negatives/${neg.id}/resolve`).set(admin.auth).send({ resolution: "otra vez" })).status).toBe(400)
  })

  it("cierre ciego del cajero y después el arqueo de la jefa de caja", async () => {
    expect((await request(app).post("/pos/session/movements").set(cashier.auth).send({ type: "OUT", amount: 999999, reason: "Depósito" })).body.error).toMatch(/tanto efectivo/)
    expect((await request(app).post("/pos/session/movements").set(cashier.auth).send({ type: "OUT", amount: 5000, reason: "Pago al proveedor" })).status).toBe(201)
    const session = (await request(app).get("/pos/session").set(cashier.auth)).body
    // el cajero no ve el efectivo esperado (cierre ciego)
    expect(session.summary).toMatchObject({ salesCount: 2, payments: { CASH: 2000, SINPE: 1390, CARD: 10170 }, cashOut: 5000 })
    expect(session.summary.expectedCash).toBeUndefined()

    // paso 1: el cajero cierra sin contar
    expect((await request(app).post(`/pos/sessions/${session.id}/close`).set(cashier2.auth).send({})).status).toBe(403)
    const closed = await request(app).post(`/pos/sessions/${session.id}/close`).set(cashier.auth).send({ note: "Todo normal" })
    expect(closed.status).toBe(200)
    expect(closed.body).toMatchObject({ status: "CLOSED", reconciledAt: null, summary: { salesCount: 2 } })
    expect(closed.body.expectedCash).toBeUndefined()
    expect(closed.body.summary.expectedCash).toBeUndefined()
    expect((await request(app).get("/pos/session").set(cashier.auth)).body).toBeNull()
    expect((await request(app).post(`/pos/sessions/${session.id}/close`).set(cashier.auth).send({})).status).toBe(404)

    // paso 2: la jefa de caja ve los pendientes y hace el arqueo con el cajero
    expect((await request(app).get("/pos/sessions?pending=1").set(cashier.auth)).status).toBe(403)
    const pending = await request(app).get("/pos/sessions?pending=1").set(manager.auth)
    expect(pending.body).toMatchObject({ pendingCount: 1, items: [{ id: session.id, openedBy: { id: cashier.user.id } }] })
    const reconcile = (body: object) => request(app).post(`/pos/sessions/${session.id}/reconcile`).set(manager.auth).send(body)
    const res = await reconcile({ denominations: { "10000": 1, "5000": 1, "1000": 1, "500": 1 }, cardDeclared: 10000, note: "Faltan 500" })
    // 20000 inicial + 2000 en efectivo − 5000 retirados = 17000; datáfono 10000 vs 10170 cobrados
    expect(res.body).toMatchObject({ expectedCash: 17000, countedCash: 16500, difference: -500, cardDeclared: 10000, cardDifference: -170, reconciledBy: { id: manager.user.id } })
    expect((await reconcile({ denominations: {} })).status).toBe(409)
    // el cajero ve su reporte con lo contado, sin el esperado ni la diferencia
    const mine = (await request(app).get(`/pos/sessions/${session.id}/report`).set(cashier.auth)).body
    expect(mine).toMatchObject({ countedCash: 16500 })
    expect(mine.expectedCash).toBeUndefined()
    expect(mine.difference).toBeUndefined()
    expect((await request(app).get(`/pos/sessions/${session.id}/report`).set(cashier2.auth)).status).toBe(404)
  })

  it("descuentos: por línea y sobre el total, siempre con el código del encargado; con cliente sale factura", async () => {
    const type = (body: object) => request(app).post("/pos/discount-types").set(admin.auth).send(body)
    expect((await request(app).post("/pos/discount-types").set(cashier.auth).send({ name: "X", kind: "PERCENT", value: 5 })).status).toBe(403)
    expect((await type({ name: "Libre", kind: "AMOUNT", value: null })).status).toBe(400) // libre sin tope
    const senior = (await type({ name: "Adulto mayor", kind: "PERCENT", value: 10, appliesTo: "LINE" })).body.id
    const free = (await type({ name: "Libre", kind: "AMOUNT", value: null, maxPercent: 20, appliesTo: "TOTAL" })).body.id
    expect((await request(app).get("/pos/discount-types").set(cashier2.auth)).body).toHaveLength(2)

    expect((await request(app).post("/pos/session").set(cashier2.auth).send({ registerId, pin: "7364", openingAmount: 0 })).status).toBe(201)
    const customerId = (await request(app).post("/customers").set(cashier2.auth).send({ name: "Ana Mora", idType: "FISICA", idNumber: "101110111" })).body.id
    // 2 × 1130 = 2260 − 10 % (226) = 2034 − 100 sobre el total = 1934
    const body = {
      customerId,
      lines: [{ productId, quantity: 2, discount: { typeId: senior } }],
      discount: { typeId: free, value: 100 },
      payments: [{ method: "CARD", amount: 1934 }],
    }
    expect((await sell(cashier2, body)).body.code).toBe("DISCOUNT_NEEDS_AUTH")
    expect((await sell(cashier2, { ...body, discountPin: "4821" })).status).toBe(403) // otro cajero no autoriza
    expect((await sell(cashier2, { ...body, discount: { typeId: free, value: 1000 }, discountPin: managerPin })).body.error).toMatch(/hasta 20/)
    expect((await sell(cashier2, { ...body, discount: { typeId: senior }, discountPin: managerPin })).body.error).toMatch(/por línea/)
    const res = await sell(cashier2, { ...body, discountPin: managerPin })
    expect(res.status).toBe(201)
    expect(res.body.document).toMatchObject({ type: "INVOICE", customer: { id: customerId }, discountAuthorizedBy: { id: manager.user.id } })
    expect(Number(res.body.document.total)).toBeCloseTo(1934, 2)
    expect(res.body.document.lines[0]).toMatchObject({ discountLabel: "Adulto mayor + Libre" })

    // ajuste de precio (góndola a 1000): solo hacia abajo, con motivo y el código; va como descuento
    const adjusted = { lines: [{ productId, quantity: 2, price: 1000, priceReason: "Precio de góndola" }], payments: [{ method: "CARD", amount: 2000 }] }
    expect((await sell(cashier2, { ...adjusted, lines: [{ productId, quantity: 2, price: 1000 }] })).status).toBe(400) // sin motivo
    expect((await sell(cashier2, adjusted)).body.code).toBe("DISCOUNT_NEEDS_AUTH")
    expect((await sell(cashier2, { ...adjusted, lines: [{ ...adjusted.lines[0], price: 1200 }], discountPin: managerPin })).body.error).toMatch(/menor/)
    const fixed = await sell(cashier2, { ...adjusted, discountPin: managerPin })
    expect(fixed.status).toBe(201)
    expect(Number(fixed.body.document.total)).toBeCloseTo(2000, 2)
    expect(fixed.body.document.lines[0]).toMatchObject({ discountLabel: "Ajuste de precio: Precio de góndola" })
  })

  it("sin conexión (8B): catálogo, la venta reenviada no se duplica, negativa sin código y el precio que vio el cajero", async () => {
    const catalog = await request(app).get("/pos/catalog").set(cashier2.auth)
    expect(catalog.status).toBe(200)
    const item = catalog.body.products.find((p: { id: string }) => p.id === productId)
    expect(item).toMatchObject({ name: "Arroz", price: 1130, stock: await stockAt() })

    // mientras la caja estaba sin red: subió el precio y vendió más de lo que había
    await prisma.product.update({ where: { id: productId }, data: { price: 1200 } })
    const before = await stockAt()
    const quantity = Math.max(before, 0) + 2
    const soldAt = new Date(Date.now() - 60_000)
    const body = {
      clientSaleId: crypto.randomUUID(), soldAt,
      lines: [{ productId, quantity, seenPrice: 1130 }],
      payments: [{ method: "CASH", amount: 1130 * quantity }],
    }
    const first = await sell(cashier2, body)
    expect(first.status).toBe(201)
    expect(Number(first.body.document.total)).toBeCloseTo(1130 * quantity, 2)
    expect(new Date(first.body.document.issuedAt).getTime()).toBe(soldAt.getTime())
    const again = await sell(cashier2, body) // se cortó la red y la caja la reenvía
    expect(again.body).toMatchObject({ duplicate: true, document: { id: first.body.document.id } })
    expect(await stockAt()).toBe(before - quantity)
    expect(await prisma.stockNegative.findFirst({ where: { documentId: first.body.document.id } })).toMatchObject({ offline: true, authorizedById: null })
    const audits = await prisma.auditLog.findMany({ where: { entityId: first.body.document.id } })
    expect(audits.find((a) => (a.changes as { offline?: boolean })?.offline)?.changes).toMatchObject({ offline: true, priceChanges: [{ product: "Arroz", charged: 1130, current: 1200 }] })

    // sin conexión solo contado simple, y con la hora de este turno
    const other = { ...body, clientSaleId: crypto.randomUUID(), lines: [{ productId, quantity: 1 }], payments: [{ method: "CASH", amount: 1200 }] }
    expect((await sell(cashier2, { ...other, lines: [{ productId, quantity: 1, price: 1000, priceReason: "Góndola" }] })).body.error).toMatch(/Sin conexión solo/)
    expect((await sell(cashier2, { ...other, soldAt: new Date(2020, 0, 1) })).body.error).toMatch(/no es de este turno/)
    await prisma.product.update({ where: { id: productId }, data: { price: 1130 } })

    // (8C) la que el servidor rechazó al sincronizar: auditoría + aviso a quien hace arqueos
    const failure = { clientSaleId: other.clientSaleId, error: "Algún producto no existe", total: 1200, soldAt }
    expect((await request(app).post("/pos/offline-failures").set(cashier2.auth).send(failure)).status).toBe(201)
    expect(await prisma.notification.findFirst({ where: { userId: admin.user.id, type: "offlineSaleFailed" } })).toMatchObject({
      link: "/cash-closings", meta: { total: 1200, reason: "Algún producto no existe" },
    })
    expect(await prisma.auditLog.findFirst({ where: { entityType: "OfflineSaleFailed", entityId: other.clientSaleId } })).not.toBeNull()
  })

  it("el descuento sobre el total se reparte entre las líneas sin perder centavos", () => {
    const types = new Map([["t", { id: "t", name: "Promo", kind: "AMOUNT" as const, value: new Prisma.Decimal(100), maxPercent: null, appliesTo: "BOTH" as const, isActive: true }]])
    const { lines } = computeDiscounts([1, 1, 1].map((v) => new Prisma.Decimal(v * 1000)), [], { typeId: "t" }, types)
    expect(lines.map((l) => l.amount.toNumber())).toEqual([33.34, 33.33, 33.33])
  })
})
