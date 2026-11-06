-- CreateEnum
CREATE TYPE "FaultStatus" AS ENUM ('reported', 'arrival_pending', 'under_repair', 'repair_pending', 'closed');

-- AlterTable
ALTER TABLE "UnitEvent" ADD COLUMN     "faultId" TEXT;

-- CreateTable
CREATE TABLE "Fault" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "urgent" BOOLEAN NOT NULL,
    "description" TEXT,
    "status" "FaultStatus" NOT NULL DEFAULT 'reported',
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reportedByName" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "technicians" JSONB NOT NULL DEFAULT '[]',
    "log" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fault_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Fault" ADD CONSTRAINT "Fault_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
