import { z } from 'zod'

export const unitStatusSchema = z.enum(['not_started', 'running', 'stopped', 'fault'])
export type UnitStatus = z.infer<typeof unitStatusSchema>

export const unitEventSchema = z.object({
  type: z.enum(['start', 'stop', 'resume', 'fault_reported', 'fault_resolved']),
  at: z.string(),
  urgent: z.boolean(),
})
export type UnitEvent = z.infer<typeof unitEventSchema>

export const openFaultSchema = z.object({
  id: z.string(),
  urgent: z.boolean(),
  description: z.string().nullable(),
  reportedAt: z.string(),
})

export const unitDayStateSchema = z.object({
  unitId: z.string(),
  unitName: z.string(),
  photoHint: z.string(),
  status: unitStatusSchema,
  serverNow: z.string(),
  shiftStart: z.string(),
  shiftEnd: z.string(),
  firstStartAt: z.string().nullable(),
  lateMs: z.number().nullable(),
  startPhotoUrl: z.string().nullable(),
  // ساعات التوقف المغلقة حتى الآن
  downtimeMs: z.number(),
  // بداية فترة التوقف الجارية (إن وجدت)، والعدّاد يكمل منها
  downtimeSince: z.string().nullable(),
  openFault: openFaultSchema.nullable(),
  events: z.array(unitEventSchema),
})
export type UnitDayState = z.infer<typeof unitDayStateSchema>

export const startUnitRequestSchema = z.object({
  photoDataUrl: z.string().min(1).optional(),
})
export type StartUnitRequest = z.infer<typeof startUnitRequestSchema>

export const reportFaultRequestSchema = z.object({
  urgent: z.boolean(),
  description: z.string().optional(),
})
export type ReportFaultRequest = z.infer<typeof reportFaultRequestSchema>

export const timelineSegmentSchema = z.object({
  status: unitStatusSchema,
  from: z.string(),
  to: z.string(),
})
export type TimelineSegment = z.infer<typeof timelineSegmentSchema>

export const unitOverviewSchema = unitDayStateSchema.extend({
  departmentId: z.string(),
  segments: z.array(timelineSegmentSchema),
})
export type UnitOverview = z.infer<typeof unitOverviewSchema>
export const unitOverviewListSchema = z.array(unitOverviewSchema)

export const galleryPhotoSchema = z.object({
  id: z.string(),
  unitId: z.string(),
  unitName: z.string(),
  departmentId: z.string(),
  day: z.string(),
  takenAt: z.string(),
  operatorName: z.string(),
  url: z.string(),
})
export type GalleryPhoto = z.infer<typeof galleryPhotoSchema>
export const galleryPhotoListSchema = z.array(galleryPhotoSchema)
