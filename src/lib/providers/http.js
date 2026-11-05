export class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 60000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    throw new ProviderError(e.name === 'AbortError' ? 'The request timed out.' : `Could not reach ${new URL(url).host}: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || data?.error || data?.raw || res.statusText;
    throw new ProviderError(`${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, res.status);
  }
  return data;
}
