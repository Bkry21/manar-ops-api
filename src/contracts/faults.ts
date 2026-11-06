import { z } from 'zod'

export const faultStatusSchema = z.enum([
  'reported',
  'arrival_pending',
  'under_repair',
  'repair_pending',
  'closed',
])
export type FaultStatus = z.infer<typeof faultStatusSchema>

export const faultTechnicianSchema = z.object({
  userId: z.string(),
  name: z.string(),
  arrivedAt: z.string(),
  arrivalConfirmedAt: z.string().nullable(),
  confirmedBy: z.string().nullable(),
  // ضغط "أنهيت" وينتظر التأكيد
  finishedAt: z.string().nullable(),
  // ساعات الصيانة المغلقة، والجارية تُحسب من workingSince
  maintenanceMs: z.number(),
  workingSince: z.string().nullable(),
})
export type FaultTechnician = z.infer<typeof faultTechnicianSchema>

export const faultSchema = z.object({
  id: z.string(),
  unitId: z.string(),
  unitName: z.string(),
  departmentId: z.string(),
  urgent: z.boolean(),
  description: z.string().nullable(),
  status: faultStatusSchema,
  reportedAt: z.string(),
  reportedByName: z.string(),
  closedAt: z.string().nullable(),
  // من الإبلاغ إلى أول وصول
  responseMs: z.number().nullable(),
  // من أول تأكيد وصول إلى الإغلاق
  repairMs: z.number().nullable(),
  technicians: z.array(faultTechnicianSchema),
  log: z.array(z.object({ at: z.string(), text: z.string() })),
  serverNow: z.string(),
})
export type Fault = z.infer<typeof faultSchema>

export const faultListSchema = z.array(faultSchema)

export const confirmArrivalRequestSchema = z.object({ technicianId: z.string() })
export type ConfirmArrivalRequest = z.infer<typeof confirmArrivalRequestSchema>
