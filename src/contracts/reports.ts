import { z } from 'zod'
import { faultStatusSchema } from './faults'

const quantitiesSchema = z.record(z.string(), z.number())

export const productionReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  generatedAt: z.string(),
  departments: z.array(
    z.object({
      departmentId: z.string(),
      name: z.string(),
      sizes: z.array(
        z.object({ id: z.string(), label: z.string(), unit: z.enum(['bucket', 'carton']) }),
      ),
      days: z.array(
        z.object({ day: z.string(), produced: quantitiesSchema, target: quantitiesSchema }),
      ),
    }),
  ),
})
export type ProductionReport = z.infer<typeof productionReportSchema>

export const operationsReportSchema = z.object({
  month: z.string(),
  from: z.string(),
  to: z.string(),
  generatedAt: z.string(),
  shiftStartHour: z.number(),
  shiftEndHour: z.number(),
  units: z.array(
    z.object({
      unitId: z.string(),
      unitName: z.string(),
      daysCounted: z.number(),
      daysStarted: z.number(),
      daysNotRegistered: z.number(),
      lateDays: z.number(),
      totalLateMs: z.number(),
      avgStartMinutes: z.number().nullable(),
      downtimeMs: z.number(),
      faultCount: z.number(),
    }),
  ),
  faults: z.array(
    z.object({
      id: z.string(),
      unitName: z.string(),
      urgent: z.boolean(),
      status: faultStatusSchema,
      reportedAt: z.string(),
      closedAt: z.string().nullable(),
      responseMs: z.number().nullable(),
      repairMs: z.number().nullable(),
      durationMs: z.number(),
      technicianNames: z.array(z.string()),
    }),
  ),
  technicians: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      faultCount: z.number(),
      maintenanceMs: z.number(),
    }),
  ),
})
export type OperationsReport = z.infer<typeof operationsReportSchema>
