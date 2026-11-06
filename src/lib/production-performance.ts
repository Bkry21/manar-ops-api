import { prisma } from '../db'
import { eachDay } from '../domain/sudan-time'
import { sizesForDepartment } from '../domain/product-sizes'

export type Quantities = Record<string, number>
type DayTotals = { day: string; produced: number; target: number }
type Bucket = { from: string; to: string; produced: number; target: number }

function normalize(departmentId: string, quantities: Quantities): Quantities {
  return Object.fromEntries(
    sizesForDepartment(departmentId).map((size) => [size.id, quantities[size.id] ?? 0]),
  )
}

function sum(quantities: Quantities): number {
  return Object.values(quantities).reduce((total, value) => total + value, 0)
}

function rateOf(produced: number, target: number): number | null {
  return target > 0 ? Math.round((produced / target) * 1000) / 10 : null
}

// يومي حتى 31 يومًا، ثم أسبوعي حتى 120، ثم كل 30 يومًا
function bucketize(perDay: DayTotals[]): Bucket[] {
  const step = perDay.length <= 31 ? 1 : perDay.length <= 120 ? 7 : 30
  const buckets: Bucket[] = []
  for (let index = 0; index < perDay.length; index += step) {
    const chunk = perDay.slice(index, index + step)
    buckets.push({
      from: chunk[0]?.day ?? '',
      to: chunk.at(-1)?.day ?? '',
      produced: chunk.reduce((total, item) => total + item.produced, 0),
      target: chunk.reduce((total, item) => total + item.target, 0),
    })
  }
  return buckets
}

export function canReadDepartment(role: string, userDepartmentId: string | null, departmentId: string): boolean {
  if (role === 'production_manager' || role === 'factory_manager') return true
  return role === 'supervisor' && userDepartmentId === departmentId
}

export async function computePerformance(
  auth: { role: string; departmentId: string | null },
  from: string,
  to: string,
) {
  const days = eachDay(from, to)
  const departments = await prisma.department.findMany({ orderBy: { createdAt: 'asc' } })
  const visible = departments.filter((d) => canReadDepartment(auth.role, auth.departmentId, d.id))

  const entries = await prisma.productionEntry.findMany({
    where: { departmentId: { in: visible.map((d) => d.id) }, day: { in: days } },
  })
  const targets = await prisma.productionTarget.findMany({
    where: { departmentId: { in: visible.map((d) => d.id) }, effectiveFrom: { lte: to } },
  })

  function effectiveTarget(departmentId: string, day: string): Quantities {
    const latest = targets
      .filter((item) => item.departmentId === departmentId && item.effectiveFrom <= day)
      .sort(
        (a, b) =>
          a.effectiveFrom.localeCompare(b.effectiveFrom) || a.setAt.getTime() - b.setAt.getTime(),
      )
      .at(-1)
    return normalize(departmentId, (latest?.quantities as Quantities | undefined) ?? {})
  }

  const results = visible.map((department) => {
    const entryByDay = new Map(
      entries.filter((item) => item.departmentId === department.id).map((item) => [item.day, item]),
    )

    const perDay: DayTotals[] = days.map((day) => ({
      day,
      produced: sum(
        normalize(department.id, (entryByDay.get(day)?.quantities as Quantities | undefined) ?? {}),
      ),
      target: sum(effectiveTarget(department.id, day)),
    }))

    const sizes = sizesForDepartment(department.id).map((size) => {
      const produced = days.reduce((total, day) => {
        const q = (entryByDay.get(day)?.quantities as Quantities | undefined) ?? {}
        return total + (q[size.id] ?? 0)
      }, 0)
      const target = days.reduce(
        (total, day) => total + (effectiveTarget(department.id, day)[size.id] ?? 0),
        0,
      )
      return {
        sizeId: size.id,
        label: size.label,
        unit: size.unit,
        produced,
        target,
        ratePercent: rateOf(produced, target),
      }
    })

    const producedUnits = perDay.reduce((total, item) => total + item.produced, 0)
    const targetUnits = perDay.reduce((total, item) => total + item.target, 0)

    return {
      perDay,
      report: {
        departmentId: department.id,
        name: department.name,
        active: department.active,
        producedUnits,
        targetUnits,
        ratePercent: rateOf(producedUnits, targetUnits),
        sizes,
        buckets: bucketize(perDay),
      },
    }
  })

  const active = results.filter((item) => item.report.active)
  const overallPerDay: DayTotals[] = days.map((day, index) => ({
    day,
    produced: active.reduce((total, item) => total + (item.perDay[index]?.produced ?? 0), 0),
    target: active.reduce((total, item) => total + (item.perDay[index]?.target ?? 0), 0),
  }))
  const producedUnits = overallPerDay.reduce((total, item) => total + item.produced, 0)
  const targetUnits = overallPerDay.reduce((total, item) => total + item.target, 0)

  return {
    overall: {
      producedUnits,
      targetUnits,
      ratePercent: rateOf(producedUnits, targetUnits),
      buckets: bucketize(overallPerDay),
    },
    departments: results.map((item) => item.report),
    visibleCount: visible.length,
  }
}