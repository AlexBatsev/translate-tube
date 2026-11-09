// The Claude bridge (OCP) refuses browser requests that come from another
// site, which includes extensions. This rule removes the Origin header from
// requests that this extension itself sends to the bridge on this computer,
// so it works without extra settings. Pages and other extensions are not
// affected (initiatorDomains is our own extension id).
const RULE_ID = 3456;

export async function allowBridgeRequests() {
  const dnr = globalThis.chrome?.declarativeNetRequest;
  if (!dnr) return;
  const existing = await dnr.getSessionRules();
  if (existing.some((r) => r.id === RULE_ID)) return;
  await dnr.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
        condition: {
          regexFilter: '^http://(127\\.0\\.0\\.1|localhost):3456/',
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ['xmlhttprequest']
        }
      }
    ]
  });
}
