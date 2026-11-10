import { prisma } from '../db'
import type { StoredTechnician } from './fault-dto'
import { currentSettings } from './settings-cache'
import { sendPush } from './push'

export type NotificationKind =
  | 'fault_new'
  | 'arrival_pending'
  | 'arrival_confirmed'
  | 'repair_pending'
  | 'repair_rejected'
  | 'escalation'
  | 'unit_started'
  | 'fault_watch'
  | 'repair_confirmed'
  | 'production_added'
  | 'target_updated'
  | 'app_update'

type CatalogEntry = {
  kind: NotificationKind
  label: string
  description: string
  mandatory: boolean
  roles: string[]
}

const everyone = ['operator', 'technician', 'supervisor', 'production_manager', 'factory_manager']

export const catalog: CatalogEntry[] = [
  { kind: 'fault_new', label: 'عطل جديد', description: 'عند رفع عطل في قسمك، عاجلًا كان أو عاديًا.', mandatory: true, roles: ['technician'] },
  { kind: 'arrival_pending', label: 'طلب تأكيد وصول فني', description: 'عندما يعلن فني وصوله ويحتاج تأكيدك.', mandatory: true, roles: ['operator', 'supervisor'] },
  { kind: 'arrival_confirmed', label: 'تأكيد وصولك', description: 'عندما يؤكد المشغل أو المشرف وصولك فتبدأ الصيانة.', mandatory: true, roles: ['technician'] },
  { kind: 'repair_pending', label: 'طلب تأكيد الإصلاح', description: 'عندما ينهي الفني الإصلاح ويحتاج تأكيدك.', mandatory: true, roles: ['operator', 'supervisor'] },
  { kind: 'repair_rejected', label: 'لم تُصلح: متابعة الصيانة', description: 'عندما يرى المشغل أو المشرف أن الوحدة لم تُصلح بعد.', mandatory: true, roles: ['technician'] },
  { kind: 'escalation', label: 'تصعيد عطل بلا فني', description: 'عندما يمضي وقت طويل على عطل لم يقبله أي فني.', mandatory: true, roles: ['supervisor', 'factory_manager'] },
  { kind: 'unit_started', label: 'بدء تشغيل الوحدات', description: 'عند بدء أي وحدة تشغيلها اليومي.', mandatory: false, roles: everyone },
  { kind: 'fault_watch', label: 'مراقبة الأعطال', description: 'تنبيه بكل عطل جديد للمراقبة فقط.', mandatory: false, roles: ['supervisor', 'production_manager', 'factory_manager'] },
  { kind: 'repair_confirmed', label: 'تأكيد الإصلاح', description: 'عند إغلاق عطل بعد تأكيد إصلاحه.', mandatory: false, roles: ['technician', 'operator'] },
  { kind: 'production_added', label: 'إدخال الإنتاج', description: 'عندما يدخل مشرف القسم إنتاج اليوم.', mandatory: false, roles: ['production_manager'] },
  { kind: 'target_updated', label: 'تحديث هدف اليوم', description: 'عندما يحدّث مدير الإنتاج هدف قسمك.', mandatory: false, roles: ['supervisor'] },
  { kind: 'app_update', label: 'تحديثات التطبيق', description: 'عند توفر نسخة جديدة من التطبيق.', mandatory: false, roles: everyone },
]

type Draft = { kind: NotificationKind; title: string; body: string; link: string }

async function isDeliverable(userId: string, kind: NotificationKind): Promise<boolean> {
  const entry = catalog.find((item) => item.kind === kind)
  if (!entry) return false
  if (entry.mandatory) return true
  const pref = await prisma.notificationPreference.findUnique({ where: { userId_kind: { userId, kind } } })
  return pref?.enabled ?? true
}

export async function notify(
  recipients: { id: string }[],
  draft: Draft,
  nowMs: number,
  excludeUserId?: string,
): Promise<void> {
  const seen = new Set<string>()
  const rows: { userId: string; kind: string; title: string; body: string; link: string; at: Date }[] = []

  for (const recipient of recipients) {
    if (recipient.id === excludeUserId || seen.has(recipient.id)) continue
    seen.add(recipient.id)
    if (!(await isDeliverable(recipient.id, draft.kind))) continue
    rows.push({
      userId: recipient.id,
      kind: draft.kind,
      title: draft.title,
      body: draft.body,
      link: draft.link,
      at: new Date(nowMs),
    })
  }

  if (rows.length === 0) return
  await prisma.notification.createMany({ data: rows })

  const devices = await prisma.user.findMany({
    where: { id: { in: rows.map((row) => row.userId) }, fcmToken: { not: null } },
    select: { id: true, fcmToken: true },
  })
  await Promise.all(
    devices.map((device) =>
      sendPush(device.fcmToken!, draft.title, draft.body, draft.link).catch((error) =>
        console.error('push failed for', device.id, error),
      ),
    ),
  )
}

export const techniciansOf = (departmentId: string) =>
  prisma.user.findMany({ where: { role: 'technician', departmentId, active: true } })
export const supervisorsOf = (departmentId: string) =>
  prisma.user.findMany({ where: { role: 'supervisor', departmentId, active: true } })
export const operatorsOf = (unitId: string) =>
  prisma.user.findMany({ where: { role: 'operator', active: true, units: { some: { id: unitId } } } })
export const factoryManagers = () => prisma.user.findMany({ where: { role: 'factory_manager', active: true } })
export const allManagers = () =>
  prisma.user.findMany({ where: { role: { in: ['production_manager', 'factory_manager'] }, active: true } })

export async function settingsFor(userId: string, role: string) {
  const prefs = await prisma.notificationPreference.findMany({ where: { userId } })
  const prefMap = new Map(prefs.map((item) => [item.kind, item.enabled]))
  return {
    categories: catalog
      .filter((entry) => entry.roles.includes(role))
      .map((entry) => ({
        kind: entry.kind,
        label: entry.label,
        description: entry.description,
        mandatory: entry.mandatory,
        enabled: entry.mandatory || (prefMap.get(entry.kind) ?? true),
      })),
  }
}
// عطل لم يقبله أي فني بعد مدة معيّنة: نصعّد للمشرف، وبعدين للمدير كمان
export async function runEscalations(nowMs: number): Promise<void> {
  const openFaults = await prisma.fault.findMany({ where: { closedAt: null }, include: { unit: true } })

  for (const fault of openFaults) {
    const technicians = (fault.technicians as unknown as StoredTechnician[]) ?? []
    if (technicians.length > 0) continue

    const { escalationUrgentMinutes, escalationNormalMinutes } = currentSettings()
const minutes = fault.urgent ? escalationUrgentMinutes : escalationNormalMinutes
    const intervalMs = minutes * 60_000
    const due = Math.floor((nowMs - fault.reportedAt.getTime()) / intervalMs)
    if (due <= fault.escalationCount) continue

    await prisma.fault.update({ where: { id: fault.id }, data: { escalationCount: due } })

    const recipients =
      due >= 2
        ? [...(await supervisorsOf(fault.unit.departmentId)), ...(await factoryManagers())]
        : await supervisorsOf(fault.unit.departmentId)

    await notify(
      recipients,
      {
        kind: 'escalation',
        title: `لم يقبل أي فني عطل ${fault.unit.name}`,
        body: `مضت ${Math.floor((nowMs - fault.reportedAt.getTime()) / 60_000)} دقيقة منذ الإبلاغ بلا وصول أي فني`,
        link: `/faults/${fault.id}`,
      },
      nowMs,
    )
  }
}