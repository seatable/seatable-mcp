import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'

import { TokenManager } from '../src/seatable/tokenManager.js'

const serverUrl = 'http://localhost'
const apiToken = 'api-token'

beforeAll(() => {
  process.env.SEATABLE_SERVER_URL = serverUrl
  process.env.SEATABLE_API_TOKEN = apiToken
})

describe('TokenManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('exchanges and returns a base token (app-access-token)', async () => {
    const get = vi.fn().mockResolvedValue({ data: { access_token: 'base-token', expires_in: 3600 } })
    vi.spyOn(axios, 'create').mockReturnValue({ get } as any)

    const tm = new TokenManager({ serverUrl, apiToken })
    const token = await tm.getToken()
    expect(token).toBe('base-token')
    expect(get).toHaveBeenCalled()
  })

  it('reuses cached token until expiry', async () => {
    const get = vi.fn().mockResolvedValue({ data: { access_token: 'once', expires_in: 3600 } })
    vi.spyOn(axios, 'create').mockReturnValue({ get } as any)

    const tm = new TokenManager({ serverUrl, apiToken })
    const a = await tm.getToken()
    const b = await tm.getToken()
    expect(a).toBe('once')
    expect(b).toBe('once')
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('throws a shaped error on exchange failure', async () => {
    const get = vi.fn().mockRejectedValue({ response: { status: 500 } })
    vi.spyOn(axios, 'create').mockReturnValue({ get } as any)

    const tm = new TokenManager({ serverUrl, apiToken })
    await expect(tm.getToken()).rejects.toThrow('Failed to authenticate with SeaTable (HTTP 500)')
  })

  it('extracts dtable_uuid from token exchange response', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { access_token: 'base-token', expires_in: 3600, dtable_uuid: '650d8a0d-test' },
    })
    vi.spyOn(axios, 'create').mockReturnValue({ get } as any)

    const tm = new TokenManager({ serverUrl, apiToken })
    await tm.getToken()
    expect(tm.getDtableUuid()).toBe('650d8a0d-test')
  })

  it('getDtableUuid returns undefined before first token exchange', () => {
    vi.spyOn(axios, 'create').mockReturnValue({ get: vi.fn() } as any)
    const tm = new TokenManager({ serverUrl, apiToken })
    expect(tm.getDtableUuid()).toBeUndefined()
  })
})
