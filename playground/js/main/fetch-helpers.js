// Tiny wrappers around fetch() for the API patterns used across the
// playground: JSON body + same-origin credentials. Returns the raw
// Response so callers keep their own ok/status handling.

export function postJson(url, body, options = {}) {
  return fetch(url, {
    method: options.method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: options.credentials || 'include',
    body: JSON.stringify(body),
  });
}

export function putJson(url, body, options = {}) {
  return postJson(url, body, { ...options, method: 'PUT' });
}
