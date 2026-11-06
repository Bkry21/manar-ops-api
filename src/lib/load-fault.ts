import { prisma } from '../db'
import { faultVisibleTo } from './fault-dto'
import type { Fault, Unit } from '../generated/prisma/client'

type Auth = { sub: string; role: string }

export type FaultContext = {
  unitIds: string[]
  departmentId: string | null
  fullName: string
  fault: Fault & { unit: Unit }
}

export type LoadResult =
  | { ok: true; ctx: FaultContext }
  | { ok: false; status: 404; code: string; message: string }

export async function loadVisibleFault(auth: Auth, faultId: string): Promise<LoadResult> {
  const dbUser = await prisma.user.findUnique({ where: { id: auth.sub }, include: { units: true } })
  const unitIds = dbUser?.units.map((unit) => unit.id) ?? []
  const departmentId = dbUser?.departmentId ?? null

  const fault = await prisma.fault.findUnique({ where: { id: faultId }, include: { unit: true } })
  if (!fault || !faultVisibleTo({ role: auth.role, unitIds, departmentId }, fault)) {
    return { ok: false, status: 404, code: 'fault_not_found', message: 'العطل غير موجود' }
  }

  return { ok: true, ctx: { unitIds, departmentId, fullName: dbUser?.fullName ?? '—', fault } }
}

// التأكيد لمشغل الوحدة أو لمشرف القسم فقط
export function canConfirmFault(
  role: string,
  unitIds: string[],
  departmentId: string | null,
  fault: { unitId: string; unit: Unit },
): boolean {
  if (role === 'operator') return unitIds.includes(fault.unitId)
  if (role === 'supervisor') return departmentId === fault.unit.departmentId
  return false
}