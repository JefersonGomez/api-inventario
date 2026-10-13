-- Costo por producto (promedio ponderado de las compras). null = sin costo conocido.
ALTER TABLE "Product" ADD COLUMN "cost" DECIMAL(12,4);

-- Costo inicial = promedio ponderado de todo lo ya recibido por órdenes de compra.
-- (Aproximación: no reconstruye el promedio móvil en el tiempo, solo el promedio de lo comprado.)
UPDATE "Product" p SET "cost" = s.avg_cost
FROM (
  SELECT i."productId", SUM(i."quantity" * i."unitCost") / NULLIF(SUM(i."quantity"), 0) AS avg_cost
  FROM "PurchaseOrderItem" i
  JOIN "PurchaseOrder" o ON o."id" = i."purchaseOrderId"
  WHERE o."status" = 'RECEIVED'
  GROUP BY i."productId"
) s
WHERE p."id" = s."productId";
