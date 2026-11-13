/** Грешка от API: кодът се превежда в интерфейса (err.<код>). */
export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: unknown) { super(code); }
}

async function call<T>(method: string, url: string, body?: unknown, raw?: { data: Blob | ArrayBuffer; type: string }): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (raw) { headers['content-type'] = raw.type; payload = raw.data; }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || 'internal', data);
  return data as T;
}

export const api = {
  get: <T>(url: string) => call<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => call<T>('POST', url, body),
  put: <T>(url: string, body: unknown) => call<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => call<T>('PATCH', url, body),
  del: <T>(url: string) => call<T>('DELETE', url),
  upload: <T>(url: string, file: File) =>
    call<T>('POST', url, undefined, { data: file, type: file.name.endsWith('.xlsx')
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv' }),
};
