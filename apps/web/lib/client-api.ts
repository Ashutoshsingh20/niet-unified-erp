export class ErpApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function erpRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/erp/${path.replace(/^\//, '')}`, {
    ...init,
    headers: { accept: 'application/json', ...(init.body === undefined ? {} : {
      'content-type': 'application/json', 'x-requested-with': 'niet-erp-web',
    }), ...init.headers },
    cache: 'no-store',
  });
  if (response.status === 401) {
    window.location.assign(`/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
    throw new ErpApiError(401, 'Your session has expired');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw new ErpApiError(response.status, payload.message ?? 'The request could not be completed');
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

