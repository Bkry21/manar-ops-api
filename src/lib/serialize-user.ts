import { prisma } from '../db'

export async function serializeUser(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { units: true } })
  if (!user) return null
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    departmentId: user.departmentId,
    unitIds: user.units.map((unit) => unit.id),
    mustChangePassword: user.mustChangePassword,
  }
}