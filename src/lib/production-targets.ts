import { prisma } from '../db'
import { sizesForDepartment } from '../domain/product-sizes'
import { sudanDayKey } from '../domain/sudan-time'

export type Quantities = Record<string, number>

function normalize(departmentId: string, quantities: Quantities): Quantities {
  return Object.fromEntries(
    sizesForDepartment(departmentId).map((size) => [size.id, quantities[size.id] ?? 0]),
  )
}

export async function effectiveTarget(departmentId: string, day: string): Promise<Quantities> {
  const latest = await prisma.productionTarget.findFirst({
    where: { departmentId, effectiveFrom: { lte: day } },
    orderBy: [{ effectiveFrom: 'desc' }, { setAt: 'desc' }],
  })
  return normalize(departmentId, (latest?.quantities as Quantities | undefined) ?? {})
}

export async function targetsDto(departmentId: string, nowMs: number) {
  const today = sudanDayKey(nowMs)
  const versions = await prisma.productionTarget.findMany({
    where: { departmentId },
    orderBy: [{ effectiveFrom: 'desc' }, { setAt: 'desc' }],
    take: 20,
  })

  return {
    departmentId,
    today,
    current: await effectiveTarget(departmentId, today),
    versions: versions.map((item) => ({
      effectiveFrom: item.effectiveFrom,
      quantities: normalize(departmentId, item.quantities as Quantities),
      setByName: item.setByName,
      setAt: item.setAt.toISOString(),
    })),
  }
}