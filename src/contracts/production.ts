import { z } from 'zod'

export const quantitiesSchema = z.record(z.string(), z.number())
export type Quantities = z.infer<typeof quantitiesSchema>

const unitSchema = z.enum(['bucket', 'carton'])

export const productSizeSchema = z.object({
  id: z.string(),
  label: z.string(),
  unit: unitSchema,
})
export type ProductSize = z.infer<typeof productSizeSchema>

export const departmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  sizes: z.array(productSizeSchema),
})
export type Department = z.infer<typeof departmentSchema>

export const productionConfigSchema = z.object({ departments: z.array(departmentSchema) })

const savedQuantitiesSchema = z.record(z.string(), z.number().int().min(0).max(1_000_000))

export const productionEntrySchema = z.object({
  departmentId: z.string(),
  day: z.string(),
  quantities: quantitiesSchema,
  // الهدف الساري في ذلك اليوم
  target: quantitiesSchema,
  updatedAt: z.string().nullable(),
  updatedByName: z.string().nullable(),
  history: z.array(z.object({ at: z.string(), byName: z.string(), totalUnits: z.number() })),
})
export type ProductionEntry = z.infer<typeof productionEntrySchema>

export const saveEntryRequestSchema = z.object({ quantities: savedQuantitiesSchema })
export type SaveEntryRequest = z.infer<typeof saveEntryRequestSchema>

export const targetVersionSchema = z.object({
  effectiveFrom: z.string(),
  quantities: quantitiesSchema,
  setByName: z.string(),
  setAt: z.string(),
})

export const departmentTargetsSchema = z.object({
  departmentId: z.string(),
  today: z.string(),
  current: quantitiesSchema,
  versions: z.array(targetVersionSchema),
})
export type DepartmentTargets = z.infer<typeof departmentTargetsSchema>

export const saveTargetsRequestSchema = z.object({
  effectiveFrom: z.string(),
  quantities: savedQuantitiesSchema,
})
export type SaveTargetsRequest = z.infer<typeof saveTargetsRequestSchema>

export const bucketSchema = z.object({
  from: z.string(),
  to: z.string(),
  produced: z.number(),
  target: z.number(),
})
export type Bucket = z.infer<typeof bucketSchema>

export const sizePerformanceSchema = z.object({
  sizeId: z.string(),
  label: z.string(),
  unit: unitSchema,
  produced: z.number(),
  target: z.number(),
  ratePercent: z.number().nullable(),
})
export type SizePerformance = z.infer<typeof sizePerformanceSchema>

export const departmentPerformanceSchema = z.object({
  departmentId: z.string(),
  name: z.string(),
  active: z.boolean(),
  producedUnits: z.number(),
  targetUnits: z.number(),
  ratePercent: z.number().nullable(),
  sizes: z.array(sizePerformanceSchema),
  buckets: z.array(bucketSchema),
})
export type DepartmentPerformance = z.infer<typeof departmentPerformanceSchema>

export const performanceSchema = z.object({
  from: z.string(),
  to: z.string(),
  overall: z.object({
    producedUnits: z.number(),
    targetUnits: z.number(),
    ratePercent: z.number().nullable(),
    buckets: z.array(bucketSchema),
  }),
  departments: z.array(departmentPerformanceSchema),
})
export type Performance = z.infer<typeof performanceSchema>
