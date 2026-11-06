import 'dotenv/config'
import { hash } from '@node-rs/argon2'
import { prisma } from '../src/db'

async function main() {
  const passwordHash = await hash('123456')

  await prisma.user.upsert({
    where: { username: 'manager' },
    update: {},
    create: {
      username: 'manager',
      passwordHash,
      fullName: 'مدير المصنع',
      role: 'factory_manager',
      mustChangePassword: true,
    },
  })

    const department = await prisma.department.upsert({
    where: { id: 'tahina' },
    update: {},
    create: { id: 'tahina', name: 'الطحنية', active: true },
  })

  const units = [
    { id: 'generator', name: 'المولد', photoHint: 'صوّر شاشة تشغيل المولد وهو يعمل' },
    { id: 'boiler', name: 'الغلاية', photoHint: 'صوّر لوحة تحكم الغلاية وهي تعمل' },
    { id: 'sesame-line', name: 'خط السمسم', photoHint: 'صوّر شاشة التحكم من طبلون الكهرباء' },
    { id: 'mills', name: 'الطواحين', photoHint: 'صوّر لوحة تشغيل الطواحين وهي تعمل' },
    { id: 'cooker', name: 'الطباخة', photoHint: 'صوّر شاشة تشغيل الطباخة وهي تعمل' },
    { id: 'prep-pot', name: 'حلة التحضير', photoHint: 'صوّر لوحة تشغيل حلة التحضير وهي تعمل' },
  ]

  for (const unit of units) {
    await prisma.unit.upsert({
      where: { id: unit.id },
      update: {},
      create: { ...unit, departmentId: department.id },
    })
  }

    await prisma.department.upsert({
    where: { id: 'halawa' },
    update: {},
    create: { id: 'halawa', name: 'الحلاوة', active: false },
  })
  await prisma.department.upsert({
    where: { id: 'biscuit' },
    update: {},
    create: { id: 'biscuit', name: 'البسكويت', active: false },
  })
  await prisma.department.upsert({
    where: { id: 'juice' },
    update: {},
    create: { id: 'juice', name: 'العصير', active: false },
  })

  console.log('تمت إضافة مستخدم المدير بنجاح')
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })