export const API_URL = (((import.meta as any).env?.VITE_API_URL as string | undefined) ?? (typeof process !== 'undefined' ? process.env?.VITE_API_URL : undefined) ?? 'http://localhost:8787').replace(/\/$/, '');

export class ApiFail extends Error {
  constructor(public status: number, public code: string, message: string, public retryable: boolean) {
    super(message);
  }
}

let token: string | null = null;
export const setApiToken = (t: string | null) => {
  token = t;
};

export const uuid = () => crypto.randomUUID();

export async function api<T = any>(method: string, path: string, body?: unknown, idemKey?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idemKey ? { 'idempotency-key': idemKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiFail(0, 'NETWORK', 'Network error — the request can be safely retried', true);
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) {
    const e = data?.error;
    throw new ApiFail(res.status, e?.code ?? 'HTTP_' + res.status, e?.message ?? res.statusText, !!e?.retryable || res.status >= 500);
  }
  return data as T;
}

export const imageUrl = (assetId: string) => `${API_URL}/assets/${assetId}/image`;
