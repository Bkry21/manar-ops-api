import type { Unit } from '../generated/prisma/client'
import { prisma } from '../db'

const readerRoles = ['supervisor', 'production_manager', 'factory_manager']

type AuthorizeResult =
  | { ok: true; unit: Unit }
  | { ok: false; status: 403 | 404; code: string; message: string }

export async function authorizeUnit(
  auth: { sub: string; role: string },
  unitId: string,
  write: boolean,
): Promise<AuthorizeResult> {
  const unit = await prisma.unit.findUnique({ where: { id: unitId } })
  if (!unit) return { ok: false, status: 404, code: 'unit_not_found', message: 'الوحدة غير موجودة' }

  let ownsUnit = false
  if (auth.role === 'operator') {
    const link = await prisma.unit.findFirst({ where: { id: unitId, operators: { some: { id: auth.sub } } } })
    ownsUnit = Boolean(link)
  }
  const allowed = write ? ownsUnit : ownsUnit || readerRoles.includes(auth.role)
  if (!allowed) return { ok: false, status: 403, code: 'forbidden', message: 'لا تملك صلاحية على هذه الوحدة' }

  return { ok: true, unit }
}