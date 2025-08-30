import { z } from 'zod'
import { ToolRegistrar } from './types.js'

const InputSchema = z.object({})

export const registerPingSeatable: ToolRegistrar = (server, { client, getInputSchema }) => {
    server.registerTool(
        'ping_seatable',
        {
            title: 'Ping SeaTable',
            description: 'Health check that verifies connectivity and auth to SeaTable',
            inputSchema: getInputSchema(InputSchema),
        },
        async () => {
            const started = Date.now()
            try {
                // Prefer metadata endpoint for compatibility
                await client.getMetadata()
                const latencyMs = Date.now() - started
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ ok: true, latency_ms: latencyMs })
                        },
                    ],
                }
            } catch (err) {
                const latencyMs = Date.now() - started
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ ok: false, latency_ms: latencyMs, error: (err as Error).message })
                        },
                    ],
                }
            }
        }
    )
}
