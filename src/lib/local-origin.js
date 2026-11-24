// Programs on this computer (such as Ollama) refuse browser requests that
// name another site as their origin, which includes extensions. This rule
// removes the Origin header from requests this extension itself sends to
// one local address, so the program needs no extra settings. Pages and other
// extensions are not affected (initiatorDomains is our own extension id).
const RULE_ID = 11434;
let allowed = '';

export async function allowLocalRequests(baseUrl) {
  const dnr = globalThis.chrome?.declarativeNetRequest;
  if (!dnr) return;
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return;
  }
  if (allowed === origin) return;
  await dnr.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
        condition: { urlFilter: `|${origin}/`, initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] }
      }
    ]
  });
  allowed = origin;
}
