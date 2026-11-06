import { prisma } from '../db'

type ActivityKind = 'login' | 'login_failed' | 'user' | 'unit' | 'settings' | 'targets'

async function add(kind: ActivityKind, actorName: string, text: string, nowMs: number) {
  await prisma.activityEntry.create({ data: { kind, actorName, text, at: new Date(nowMs) } })
}

type ActivityInput = {
  routeKey: string
  auth: { sub: string; role: string } | null
  result: unknown
  nowMs: number
}

// تُستدعى بعد كل طلب ناجح، وتسجّل ما يستحق التوثيق
export async function recordActivity({ routeKey, auth, result, nowMs }: ActivityInput): Promise<void> {
  if (routeKey === 'POST /auth/login') {
    const fullName = (result as { user?: { fullName?: string } })?.user?.fullName ?? '—'
    await add('login', fullName, 'سجّل الدخول', nowMs)
    return
  }

  if (!auth) return
  const actor = await prisma.user.findUnique({ where: { id: auth.sub } })
  if (!actor) return

  switch (routeKey) {
    case 'POST /auth/change-password':
      await add('login', actor.fullName, 'غيّر كلمة السر', nowMs)
      return
    case 'POST /admin/users':
      await add('user', actor.fullName, `أضاف المستخدم ${(result as { fullName?: string })?.fullName ?? '—'}`, nowMs)
      return
    case 'PUT /admin/users/:userId': {
      const user = result as { fullName?: string; active?: boolean }
      const suffix = user.active ? '' : ' (الحساب معطّل)'
      await add('user', actor.fullName, `عدّل المستخدم ${user.fullName ?? '—'}${suffix}`, nowMs)
      return
    }
    case 'POST /admin/users/:userId/reset-password':
      await add('user', actor.fullName, `أعاد ضبط كلمة سر ${(result as { fullName?: string })?.fullName ?? '—'}`, nowMs)
      return
    case 'POST /admin/units':
      await add('unit', actor.fullName, `أضاف الوحدة ${(result as { name?: string })?.name ?? '—'}`, nowMs)
      return
    case 'PUT /admin/units/:unitId':
      await add('unit', actor.fullName, `عدّل الوحدة ${(result as { name?: string })?.name ?? '—'}`, nowMs)
      return
    case 'PUT /admin/settings':
      await add('settings', actor.fullName, 'عدّل إعدادات النظام', nowMs)
      return
    case 'PUT /production/targets/:departmentId':
      await add('targets', actor.fullName, 'حدّث أهداف الإنتاج', nowMs)
      return
  }
}

export async function recordLoginFailure(username: string, code: string, nowMs: number): Promise<void> {
  let text = 'محاولة دخول فاشلة'
  if (code === 'account_locked') text = 'الحساب مقفل: محاولة دخول مرفوضة'
  if (code === 'account_disabled') text = 'حاول الدخول بحساب معطّل'
  await add('login_failed', username || 'مستخدم غير معروف', text, nowMs)
}

export async function listActivity() {
  const entries = await prisma.activityEntry.findMany({ orderBy: { at: 'desc' }, take: 200 })
  return entries.map((entry) => ({
    id: entry.id,
    at: entry.at.toISOString(),
    kind: entry.kind,
    actorName: entry.actorName,
    text: entry.text,
  }))
}