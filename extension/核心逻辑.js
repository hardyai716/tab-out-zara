(function initializeTabOutCore(root, factory) {
  'use strict';

  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.TabOutCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTabOutCore() {
  'use strict';

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createLocalId() {
    if (
      typeof globalThis !== 'undefined' &&
      globalThis.crypto &&
      typeof globalThis.crypto.randomUUID === 'function'
    ) {
      return globalThis.crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function mergeOrderedIds(renderedIds, allIds) {
    const validIds = new Set(allIds);
    const seen = new Set();
    const merged = [];

    for (const id of [...renderedIds, ...allIds]) {
      if (!validIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }

    return merged;
  }

  function installRealtimeTabRefresh({
    tabsApi,
    renderDashboard,
    debounceMs = 250,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    onError = () => {},
  }) {
    if (
      !tabsApi ||
      !tabsApi.onCreated ||
      !tabsApi.onUpdated ||
      !tabsApi.onRemoved ||
      typeof renderDashboard !== 'function'
    ) {
      return () => {};
    }

    let refreshTimer = null;

    function scheduleRefresh(reason) {
      if (refreshTimer !== null) clearTimeoutFn(refreshTimer);

      refreshTimer = setTimeoutFn(() => {
        refreshTimer = null;
        Promise.resolve(renderDashboard(reason)).catch(onError);
      }, debounceMs);
    }

    function handleCreated() {
      scheduleRefresh('tab-created');
    }

    function handleRemoved() {
      scheduleRefresh('tab-removed');
    }

    function handleUpdated(tabId, changeInfo) {
      const shouldRefresh =
        Object.prototype.hasOwnProperty.call(changeInfo, 'url') ||
        Object.prototype.hasOwnProperty.call(changeInfo, 'title') ||
        Object.prototype.hasOwnProperty.call(changeInfo, 'status');

      if (shouldRefresh) scheduleRefresh('tab-updated');
    }

    tabsApi.onCreated.addListener(handleCreated);
    tabsApi.onRemoved.addListener(handleRemoved);
    tabsApi.onUpdated.addListener(handleUpdated);

    return () => {
      if (refreshTimer !== null) clearTimeoutFn(refreshTimer);
      if (tabsApi.onCreated.removeListener) tabsApi.onCreated.removeListener(handleCreated);
      if (tabsApi.onRemoved.removeListener) tabsApi.onRemoved.removeListener(handleRemoved);
      if (tabsApi.onUpdated.removeListener) tabsApi.onUpdated.removeListener(handleUpdated);
    };
  }

  return Object.freeze({
    createLocalId,
    escapeHtml,
    installRealtimeTabRefresh,
    mergeOrderedIds,
  });
});
