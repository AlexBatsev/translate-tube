export class ProviderError extends Error {
  constructor(message, status, { timeout = false } = {}) {
    super(message);
    this.status = status;
    this.timeout = timeout;
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
    if (e.name === 'AbortError') {
      throw new ProviderError(`No answer after ${Math.round(timeoutMs / 1000)} seconds.`, 0, { timeout: true });
    }
    throw new ProviderError(`Could not reach ${new URL(url).host}: ${e.message}`);
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
