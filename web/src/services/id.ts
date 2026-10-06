// randomUUID is restricted to secure browser contexts; local HTTP installations
// still provide getRandomValues for collision-resistant client request IDs.
export function requestId() {
  return crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}
