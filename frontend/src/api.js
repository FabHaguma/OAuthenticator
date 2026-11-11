export async function api(path, { csrfToken, ...options } = {}) {
  const headers = { ...options.headers };
  if (options.method && options.method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-Gatekeeper-Request'] = '1';
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }

  let response;
  try {
    response = await fetch(`/api/v1${path}`, { ...options, credentials: 'same-origin', headers });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Gatekeeper is unavailable. Check your connection and try again.');
  }

  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || 'The request could not be completed. Please try again.');
    error.status = response.status;
    throw error;
  }
  if (!data) throw new Error('Gatekeeper returned an unexpected response. Please try again.');
  return data;
}
