import { prisma } from '../db'
import { sizesForDepartment } from '../domain/product-sizes'
import { effectiveTarget } from './production-targets'

export type Quantities = Record<string, number>
type HistoryItem = { at: number; byName: string; totalUnits: number }

function normalize(departmentId: string, quantities: Quantities): Quantities {
  return Object.fromEntries(
    sizesForDepartment(departmentId).map((size) => [size.id, quantities[size.id] ?? 0]),
  )
}

function sum(quantities: Quantities): number {
  return Object.values(quantities).reduce((total, value) => total + value, 0)
}

export async function entryDto(departmentId: string, day: string) {
  const entry = await prisma.productionEntry.findUnique({
    where: { departmentId_day: { departmentId, day } },
  })
  const history = (entry?.history as unknown as HistoryItem[]) ?? []

  return {
    departmentId,
    day,
    quantities: normalize(departmentId, (entry?.quantities as Quantities | undefined) ?? {}),
    target: await effectiveTarget(departmentId, day),
    updatedAt: entry ? entry.updatedAt.toISOString() : null,
    updatedByName: entry?.updatedByName ?? null,
    history: history
      .map((item) => ({ at: new Date(item.at).toISOString(), byName: item.byName, totalUnits: item.totalUnits }))
      .reverse(),
  }
}

export async function saveEntry(
  departmentId: string,
  day: string,
  quantities: Quantities,
  actorFullName: string,
  nowMs: number,
) {
  const normalized = normalize(departmentId, quantities)
  const existing = await prisma.productionEntry.findUnique({
    where: { departmentId_day: { departmentId, day } },
  })
  const history = (existing?.history as unknown as HistoryItem[]) ?? []
  const updatedHistory: HistoryItem[] = [
    ...history,
    { at: nowMs, byName: actorFullName, totalUnits: sum(normalized) },
  ]

  await prisma.productionEntry.upsert({
    where: { departmentId_day: { departmentId, day } },
    update: { quantities: normalized, updatedByName: actorFullName, history: updatedHistory },
    create: { departmentId, day, quantities: normalized, updatedByName: actorFullName, history: updatedHistory },
  })

  return entryDto(departmentId, day)
}