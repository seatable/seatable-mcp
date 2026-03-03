import { z } from 'zod'

export const GenericColumnType = z.enum([
    'text',
    'long_text',
    'number',
    'checkbox',
    'date',
    'datetime',
    'single_select',
    'multi_select',
    'link',
    'attachment',
    'formula',
    'url',
    'email',
    'phone',
    'rate',
    'duration',
    'geolocation',
    'collaborator',
    'auto_number',
    'creator',
    'ctime',
    'mtime',
    'last_modifier',
    'button',
    'digital_sign',
    'link_formula',
])
export type GenericColumnType = z.infer<typeof GenericColumnType>

export const GenericColumnSchema = z.object({
    id: z.string(),
    name: z.string(),
    type: GenericColumnType,
    options: z.record(z.unknown()).optional(),
})
export type GenericColumn = z.infer<typeof GenericColumnSchema>

export const GenericTableSchema = z.object({
    id: z.string(),
    name: z.string(),
    columns: z.array(GenericColumnSchema),
})
export type GenericTable = z.infer<typeof GenericTableSchema>

export const GenericSchemaSchema = z.object({
    base_id: z.string(),
    tables: z.array(GenericTableSchema),
})
export type GenericSchema = z.infer<typeof GenericSchemaSchema>
