/** Generate a throwaway self-signed certificate for the optional TLS tests. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '.certs')
const keyPath = join(dir, 'key.pem')
const certPath = join(dir, 'cert.pem')

if (existsSync(keyPath) && existsSync(certPath)) {
  console.log('TLS test certificate already exists:', dir)
  process.exit(0)
}

const candidates = ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe', '/usr/bin/openssl', '/usr/local/bin/openssl']
let openssl
for (const candidate of candidates) {
  try {
    execFileSync(candidate, ['version'], { stdio: 'ignore' })
    openssl = candidate
    break
  } catch {
    // try the next candidate
  }
}
if (openssl === undefined) {
  console.error('openssl not found: TLS tests will be skipped')
  process.exit(0)
}

mkdirSync(dir, { recursive: true })
execFileSync(
  openssl,
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '2',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ],
  { stdio: 'inherit' },
)
console.log('wrote TLS test certificate:', dir)
