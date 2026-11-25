-- CreateEnum
CREATE TYPE "SubscriptionPaymentKind" AS ENUM ('PERIOD', 'UPGRADE');

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nextInterval" "BillingInterval",
ADD COLUMN     "nextPlan" "PlanCode";

-- AlterTable
ALTER TABLE "SubscriptionPayment" ADD COLUMN     "kind" "SubscriptionPaymentKind" NOT NULL DEFAULT 'PERIOD';

