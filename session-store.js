// session-store.js — pure transforms over the persistentSessions map.
function upsertEntry(store, handle, fields) {
  return { ...store, [handle]: { ...(store[handle] || {}), ...fields } };
}
function removeEntry(store, handle) {
  const next = { ...store };
  delete next[handle];
  return next;
}
function pruneDead(store, liveNames, sessionNameFn) {
  const live = new Set(liveNames);
  const next = {};
  for (const [h, e] of Object.entries(store)) {
    if (live.has(sessionNameFn(h))) next[h] = e;
  }
  return next;
}
function openEntries(store) {
  return Object.entries(store)
    .filter(([, e]) => e.wasOpen === true)
    .map(([handle, e]) => ({ handle, ...e }))
    .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
}
function backgroundEntries(store, openHandles) {
  return Object.entries(store)
    .filter(([h]) => !openHandles.has(h))
    .map(([handle, e]) => ({ handle, ...e }))
    .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
}
module.exports = { upsertEntry, removeEntry, pruneDead, openEntries, backgroundEntries };
