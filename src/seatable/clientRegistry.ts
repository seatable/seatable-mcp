import type { BaseEntry } from '../config/env.js'
import { SeaTableClient, type SeaTableClientConfig } from './client.js'

export class ClientRegistry {
    private readonly clients = new Map<string, SeaTableClient>()
    private readonly defaultName?: string

    constructor(
        bases: BaseEntry[],
        baseConfig: Omit<SeaTableClientConfig, 'apiToken'>
    ) {
        for (const base of bases) {
            this.clients.set(base.name, new SeaTableClient({ ...baseConfig, apiToken: base.apiToken }))
        }
        if (bases.length === 1) {
            this.defaultName = bases[0].name
        }
    }

    get baseNames(): string[] {
        return Array.from(this.clients.keys())
    }

    get isMultiBase(): boolean {
        return this.clients.size > 1
    }

    resolve(baseName?: string): SeaTableClient {
        if (!baseName) {
            if (this.defaultName) {
                return this.clients.get(this.defaultName)!
            }
            throw new Error(
                `Multiple bases available (${this.baseNames.join(', ')}). Specify "base" parameter.`
            )
        }
        const client = this.clients.get(baseName)
        if (!client) {
            throw new Error(
                `Unknown base "${baseName}". Available: ${this.baseNames.join(', ')}`
            )
        }
        return client
    }
}
