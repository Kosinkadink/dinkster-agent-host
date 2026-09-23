import type { FetchLike } from './connection-contract.js'

export interface CollabCredentials {
  readonly token?: string | undefined
  readonly actorKind?: 'human' | 'agent' | undefined
}

/** Credentials belong to one server, never to a redirected origin. */
export function credentialFetch(credentials: CollabCredentials, fetchFn: FetchLike = fetch): FetchLike {
  return (url, init) => {
    const headers = new Headers(init?.headers)
    if (credentials.token !== undefined) headers.set('Authorization', `Bearer ${credentials.token}`)
    if (credentials.actorKind !== undefined) headers.set('X-Dinkster-Actor-Kind', credentials.actorKind)
    return fetchFn(url, { ...init, headers, redirect: 'error' })
  }
}

export interface Delegation {
  readonly id: string
  readonly displayName: string
  readonly scope: string
  readonly sessionId: string | null
  readonly expiresAt?: number
  readonly kind: 'agent'
}

export interface MintDelegation {
  readonly scope: string
  readonly displayName: string
  readonly sessionId?: string
  readonly expiresInSeconds?: number
}

export async function mintDelegation(baseUrl: string, options: MintDelegation, fetchFn: FetchLike = fetch): Promise<{ token: string; id: string; expiresAt?: number }> {
  const response = await fetchFn(`${baseUrl}/api/auth/delegations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options),
  })
  if (!response.ok) throw new Error(`Connect agent: HTTP ${response.status}`)
  return response.json()
}
