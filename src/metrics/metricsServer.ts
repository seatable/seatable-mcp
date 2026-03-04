import { createServer } from 'node:http'

import { logger } from '../logger.js'
import { register } from './index.js'

export async function startMetricsServer(): Promise<void> {
    const port = Number(process.env.METRICS_PORT ?? 9090)

    const server = createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/metrics') {
            try {
                const metrics = await register.metrics()
                res.writeHead(200, { 'content-type': register.contentType })
                res.end(metrics)
            } catch (err) {
                res.writeHead(500, { 'content-type': 'text/plain' }).end('Error collecting metrics')
                logger.error({ err }, 'Error collecting metrics')
            }
            return
        }

        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
    })

    await new Promise<void>((resolve, reject) => {
        server.once('listening', () => resolve())
        server.once('error', (error) => reject(error))
        server.listen(port, '0.0.0.0')
    })

    // Don't keep the process alive just for the metrics server
    server.unref()

    logger.info({ port, endpoint: '/metrics' }, 'Prometheus metrics server listening')
}
