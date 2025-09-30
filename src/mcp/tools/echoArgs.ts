import { z } from 'zod'

import { ToolRegistrar } from './types.js'

// Accept absolutely anything; return it verbatim so we can inspect what the host sends.
const InputSchema = z.any()
const InputJsonSchema = { type: 'object', description: 'Echo back provided arguments', additionalProperties: true }

export const registerEchoArgs: ToolRegistrar = (server) => {
  server.registerTool(
    'echo_args',
    {
      title: 'Echo Args (DEBUG)',
      description: 'Debug tool that returns exactly what arguments the client sent',
      inputSchema: InputJsonSchema as any,
    },
    async (args: unknown) => {
      return { content: [{ type: 'text', text: JSON.stringify({ received: args }) }] }
    }
  )
}
