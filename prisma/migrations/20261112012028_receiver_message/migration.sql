-- CreateTable
CREATE TABLE "ReceiverMessage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "detail" TEXT,
    "condition" TEXT,
    "taxCredit" DECIMAL(18,5),
    "consecutive" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "xml" TEXT,
    "status" "EInvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "responseXml" TEXT,
    "message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiverMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReceiverMessage_invoiceId_key" ON "ReceiverMessage"("invoiceId");

-- CreateIndex
CREATE INDEX "ReceiverMessage_companyId_status_idx" ON "ReceiverMessage"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiverMessage_companyId_consecutive_key" ON "ReceiverMessage"("companyId", "consecutive");

-- AddForeignKey
ALTER TABLE "ReceiverMessage" ADD CONSTRAINT "ReceiverMessage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiverMessage" ADD CONSTRAINT "ReceiverMessage_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiverMessage" ADD CONSTRAINT "ReceiverMessage_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

