#!/usr/bin/env tsx
/**
 * Sync .env variables to Cloudflare Wrangler Secrets.
 *
 * Usage:
 *   npm run cf:secrets:sync -- [--env <name>] [--file <path>] [--dry-run]
 *
 * Notes:
 * - Values are read from the provided .env file. Keys with empty values are skipped.
 * - Secrets are sent to Wrangler via stdin; values are never logged.
 * - Use --env to target a specific Wrangler environment (e.g., production).
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { config as dotenvConfig, parse as dotenvParse } from 'dotenv'

type Args = {
  env?: string
  file?: string
  dryRun?: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--env' && argv[i + 1]) {
      args.env = argv[++i]
    } else if ((a === '--file' || a === '-f') && argv[i + 1]) {
      args.file = argv[++i]
    } else if (a === '--dry-run' || a === '-n') {
      args.dryRun = true
    }
  }
  return args
}

async function ensureFile(filePath: string): Promise<string | undefined> {
  const abs = path.resolve(process.cwd(), filePath)
  if (fs.existsSync(abs)) return abs
  return undefined
}

function loadEnvFromFile(filePath: string): Record<string, string> {
  const raw = fs.readFileSync(filePath, 'utf8')
  const parsed = dotenvParse(raw)
  // Normalize to string-only entries
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v
  }
  return out
}

async function putSecret(key: string, value: string, env?: string, dryRun?: boolean): Promise<void> {
  if (dryRun) {
    console.log(`DRY RUN: wrangler secret put ${key}${env ? ` --env ${env}` : ''}`)
    return
  }

  return new Promise((resolve, reject) => {
    const args = ['secret', 'put', key]
    if (env) {
      args.push('--env', env)
    }
    // Prefer local wrangler via npx to match project version
    const child = spawn('npx', ['--yes', 'wrangler', ...args], {
      stdio: ['pipe', 'inherit', 'inherit'],
      env: process.env,
    })

    // Pipe the secret value to stdin, then close
    child.stdin.write(value)
    child.stdin.end()

    child.on('error', (err) => reject(err))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`wrangler exited with code ${code}`))
    })
  })
}

async function main() {
  const { env, file, dryRun } = parseArgs(process.argv.slice(2))

  // Load process.env so dotenv substitutions can work if desired
  dotenvConfig()

  const candidateFiles = [file, '.env.local', '.env'].filter(Boolean) as string[]
  let foundFile: string | undefined
  for (const f of candidateFiles) {
    const exists = await ensureFile(f)
    if (exists) {
      foundFile = exists
      break
    }
  }

  if (!foundFile) {
    console.error('No .env file found. Checked:', candidateFiles.join(', '))
    console.error('Provide one with --file <path> or create a .env')
    process.exit(1)
  }

  const values = loadEnvFromFile(foundFile)
  const keys = Object.keys(values)
  if (keys.length === 0) {
    console.log(`No non-empty vars found in ${foundFile}. Nothing to do.`)
    return
  }

  console.log(`Syncing ${keys.length} secret(s) from ${path.relative(process.cwd(), foundFile)}${env ? ` to environment '${env}'` : ''}...`)
  for (const key of keys) {
    const val = values[key]
    try {
      console.log(`• ${key}`)
      await putSecret(key, val, env, dryRun)
    } catch (err) {
      console.error(`Failed to put secret ${key}:`, (err as Error).message)
      process.exitCode = 1
    }
  }
}

main().catch((err) => {
  console.error('sync-wrangler-secrets failed:', err)
  process.exit(1)
})
