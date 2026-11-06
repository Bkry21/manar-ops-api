import { prisma } from '../db'
import type { Unit, User } from '../generated/prisma/client'

export const managementRoles = ['production_manager', 'factory_manager']
export const departmentRoles = ['operator', 'technician', 'supervisor']

// مدير الإنتاج يدير المشغلين والفنيين والمشرفين، ومدير المصنع يدير الجميع
export function canManageRole(actorRole: string, targetRole: string): boolean {
  return actorRole === 'factory_manager' || departmentRoles.includes(targetRole)
}

export function toAdminUser(user: User & { units: Unit[] }) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    departmentId: user.departmentId,
    unitIds: user.units.map((unit) => unit.id),
    active: user.active,
    mustChangePassword: user.mustChangePassword,
  }
}

export function toAdminUnit(unit: Unit, operator: User | null) {
  return {
    id: unit.id,
    name: unit.name,
    departmentId: unit.departmentId,
    photoHint: unit.photoHint,
    operatorId: operator?.id ?? null,
    operatorName: operator?.fullName ?? null,
  }
}

export type AssignmentResult =
  | { ok: true; departmentId: string | null; unitIds: string[] }
  | { ok: false; code: string; message: string }

// القسم والوحدات حسب الدور: المشغل له وحدة واحدة من قسمه
export async function normalizeAssignment(
  role: string,
  departmentId: string | null,
  unitIds: string[],
): Promise<AssignmentResult> {
  if (!departmentRoles.includes(role)) return { ok: true, departmentId: null, unitIds: [] }

  const department = departmentId
    ? await prisma.department.findFirst({ where: { id: departmentId, active: true } })
    : null
  if (!department) return { ok: false, code: 'invalid_department', message: 'اختر قسمًا مفعّلًا' }
  if (role !== 'operator') return { ok: true, departmentId: department.id, unitIds: [] }

  const unit = unitIds[0]
    ? await prisma.unit.findFirst({ where: { id: unitIds[0], departmentId: department.id } })
    : null
  if (!unit) return { ok: false, code: 'invalid_unit', message: 'اختر وحدة من نفس قسم المشغل' }
  return { ok: true, departmentId: department.id, unitIds: [unit.id] }
}

// الوحدة لا يكون لها إلا مشغل واحد: نفرّغها من أي مستخدم تاني قبل ما نربطها بالجديد
export async function applyUnitAssignment(userId: string, unitIds: string[]): Promise<void> {
  if (unitIds.length > 0) {
    await prisma.unit.update({ where: { id: unitIds[0] }, data: { operators: { set: [] } } })
  }
  await prisma.user.update({
    where: { id: userId },
    data: { units: { set: unitIds.map((id) => ({ id })) } },
  })
}
export type AssignResult = { ok: true } | { ok: false; code: string; message: string }

// يعيّن مشغلًا للوحدة (أو يفرّغها). ومشغل واحد = وحدة واحدة
export async function assignOperator(
  unitId: string,
  departmentId: string,
  operatorId: string | null,
): Promise<AssignResult> {
  await prisma.unit.update({ where: { id: unitId }, data: { operators: { set: [] } } })

  if (operatorId) {
    const operator = await prisma.user.findUnique({ where: { id: operatorId } })
    if (!operator || operator.role !== 'operator' || operator.departmentId !== departmentId) {
      return { ok: false, code: 'invalid_operator', message: 'اختر مشغلًا من نفس القسم' }
    }
    await prisma.user.update({ where: { id: operatorId }, data: { units: { set: [{ id: unitId }] } } })
  }
  return { ok: true }
}