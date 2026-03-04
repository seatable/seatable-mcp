#!/usr/bin/env node
/**
 * Syncs the version from package.json into server.json
 * so the version only needs to be maintained in one place.
 */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const serverJsonPath = path.join(root, 'server.json')
const server = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'))

server.version = pkg.version
for (const p of server.packages) {
  p.version = pkg.version
}

fs.writeFileSync(serverJsonPath, JSON.stringify(server, null, 2) + '\n')
console.log(`server.json synced to version ${pkg.version}`)
