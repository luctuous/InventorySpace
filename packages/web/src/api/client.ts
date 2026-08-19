// Typed fetch wrapper for /api/v1. Auth is a session cookie, so requests are
// plain same-origin fetches (the Vite proxy forwards /api to :3001 in dev).

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

interface ErrorShape {
  error?: { code?: string; message?: string; details?: unknown };
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  let url = `/api/v1${path}`;
  if (options.query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as ErrorShape;
    throw new ApiRequestError(
      res.status,
      parsed.error?.code ?? 'unknown_error',
      parsed.error?.message ?? `Request failed (${res.status})`,
      parsed.error?.details,
    );
  }
  return res.json() as Promise<T>;
}
