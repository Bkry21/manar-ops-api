export type ProductUnit = 'bucket' | 'carton'
export type ProductSize = { id: string; label: string; unit: ProductUnit }

const SIZES_BY_DEPARTMENT: Record<string, ProductSize[]> = {
  tahina: [
    { id: 'bucket-15', label: 'جردل 15 كجم', unit: 'bucket' },
    { id: 'bucket-10', label: 'جردل 10 كجم', unit: 'bucket' },
    { id: 'bucket-5', label: 'جردل 5 كجم', unit: 'bucket' },
    { id: 'bucket-3', label: 'جردل 3 كجم', unit: 'bucket' },
    { id: 'bucket-2', label: 'جردل 2 كجم', unit: 'bucket' },
    { id: 'carton-1', label: 'كرتونة 1 كجم', unit: 'carton' },
    { id: 'carton-half', label: 'كرتونة نصف كيلو', unit: 'carton' },
    { id: 'carton-quarter', label: 'كرتونة ربع كيلو', unit: 'carton' },
  ],
}

export function sizesForDepartment(departmentId: string): ProductSize[] {
  return SIZES_BY_DEPARTMENT[departmentId] ?? []
}