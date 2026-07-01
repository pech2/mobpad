// Session tokens for mobpad auth.
//
// A session is a compact, HMAC-signed token: `base64url(payload).signature`.
// This is a hand-rolled JWT-alike (HS256 semantics) so the server has ZERO new
// runtime deps — only node:crypto. The same functions are used by:
//   • the HTTP layer   (mint on /auth/callback, verify on /auth/me)
//   • the ws upgrade gate (verify the cookie before accepting a socket)
//   • the test suite   (mint valid cookies, unit-test round-trips)
//
// If a real JWT lib is ever wanted, `jose` is the smallest swap; the shape of
// mintSession/verifySession is deliberately JWT-like to make that painless.

import crypto from 'crypto'

const DEFAULT_TTL = 12 * 3600 // seconds

// Falls back to an obviously-insecure secret so local dev works out of the box.
// Production MUST set SESSION_SECRET (via `disco env:set`); we warn if it hasn't.
let warnedMissingSecret = false
const resolveSecret = (secret) => {
  if (secret) return secret
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET
  if (!warnedMissingSecret) {
    console.warn('[session] SESSION_SECRET is not set — using an insecure dev default. Set it in production.')
    warnedMissingSecret = true
  }
  return 'dev-insecure-secret-change-me'
}

const sign = (body, secret) =>
  crypto.createHmac('sha256', secret).update(body).digest('base64url')

/**
 * Mint a signed session token.
 * @param {{id: string|number, name: string, ttlSeconds?: number}} claims
 * @param {string} [secret]
 */
export const mintSession = ({ id, name, ttlSeconds = DEFAULT_TTL }, secret) => {
  secret = resolveSecret(secret)
  const now = Math.floor(Date.now() / 1000)
  const payload = { sub: String(id), name: String(name), iat: now, exp: now + ttlSeconds }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${sign(body, secret)}`
}

/**
 * Verify a token's signature + expiry. Returns the claims, or null if invalid.
 * @param {string|undefined} token
 * @param {string} [secret]
 */
export const verifySession = (token, secret) => {
  if (!token || typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot < 0) return null
  secret = resolveSecret(secret)
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = sign(body, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!payload || typeof payload.exp !== 'number') return null
  if (Math.floor(Date.now() / 1000) >= payload.exp) return null
  return payload
}

/** Parse a Cookie header into a { name: value } map. */
export const parseCookie = (header) => {
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (!k) continue
    out[k] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export const SESSION_COOKIE = 'mobpad_session'
