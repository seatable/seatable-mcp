import { z } from 'zod'

// Basic JSON Schema to Zod conversion
// Note: This is a simplified converter and does not handle all JSON schema features.
export function jsonSchemaToZod(schema: any): z.ZodTypeAny {
    const type = schema.type
    if (type === 'string') {
        let s = z.string()
        if (schema.enum) return z.enum(schema.enum)
        if (schema.format === 'uri') s = s.url()
        return s
    }
    if (type === 'number' || type === 'integer') {
        let n = z.number()
        if (type === 'integer') n = n.int()
        if (schema.minimum !== undefined) n = n.min(schema.minimum)
        if (schema.maximum !== undefined) n = n.max(schema.maximum)
        return n
    }
    if (type === 'boolean') {
        return z.boolean()
    }
    if (type === 'object') {
        const shape: Record<string, z.ZodTypeAny> = {}
        if (schema.properties) {
            for (const key in schema.properties) {
                shape[key] = jsonSchemaToZod(schema.properties[key])
            }
        }
        let obj = z.object(shape)
        if (schema.additionalProperties) {
            return obj.passthrough()
        }
        return obj
    }
    if (type === 'array') {
        if (!schema.items) {
            return z.array(z.any())
        }
        let arr = z.array(jsonSchemaToZod(schema.items))
        if (schema.minItems !== undefined) arr = arr.min(schema.minItems)
        if (schema.maxItems !== undefined) arr = arr.max(schema.maxItems)
        return arr
    }

    return z.any()
}
