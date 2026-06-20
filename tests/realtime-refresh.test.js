'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const DEBOUNCE_MS = 250;

function createFakeChromeTabs() {
  function createEvent() {
    const listeners = [];
    return {
      addListener(listener) {
        listeners.push(listener);
      },
      dispatch(...args) {
        for (const listener of listeners) listener(...args);
      },
      get listenerCount() {
        return listeners.length;
      },
    };
  }

  return {
    onCreated: createEvent(),
    onUpdated: createEvent(),
    onRemoved: createEvent(),
  };
}

function createFakeTimer() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  return {
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, dueAt: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= now)
        .sort((a, b) => a[1].dueAt - b[1].dueAt);

      for (const [id, timer] of due) {
        if (!timers.has(id)) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    get pendingCount() {
      return timers.size;
    },
  };
}

function installRealtimeTabRefresh({
  chromeTabs,
  renderDashboard,
  debounceMs = DEBOUNCE_MS,
  setTimeoutFn,
  clearTimeoutFn,
}) {
  let refreshTimer = null;

  function scheduleRefresh(reason) {
    if (refreshTimer !== null) clearTimeoutFn(refreshTimer);

    refreshTimer = setTimeoutFn(() => {
      refreshTimer = null;
      renderDashboard(reason);
    }, debounceMs);
  }

  chromeTabs.onCreated.addListener(() => {
    scheduleRefresh('tab-created');
  });

  chromeTabs.onRemoved.addListener(() => {
    scheduleRefresh('tab-removed');
  });

  chromeTabs.onUpdated.addListener((tabId, changeInfo) => {
    const shouldRefresh =
      Object.prototype.hasOwnProperty.call(changeInfo, 'url') ||
      Object.prototype.hasOwnProperty.call(changeInfo, 'title') ||
      Object.prototype.hasOwnProperty.call(changeInfo, 'status');

    if (shouldRefresh) scheduleRefresh('tab-updated');
  });
}

test('realtime tab refresh debounces created and updated events', () => {
  const chromeTabs = createFakeChromeTabs();
  const timer = createFakeTimer();
  const renderCalls = [];

  installRealtimeTabRefresh({
    chromeTabs,
    renderDashboard(reason) {
      renderCalls.push(reason);
    },
    setTimeoutFn: timer.setTimeout,
    clearTimeoutFn: timer.clearTimeout,
  });

  assert.equal(chromeTabs.onCreated.listenerCount, 1);
  assert.equal(chromeTabs.onUpdated.listenerCount, 1);
  assert.equal(chromeTabs.onRemoved.listenerCount, 1);

  chromeTabs.onCreated.dispatch({
    id: 101,
    url: 'chrome://newtab/',
    title: 'New Tab',
  });
  chromeTabs.onUpdated.dispatch(101, { status: 'loading' }, {
    id: 101,
    url: 'https://github.com/',
  });
  chromeTabs.onUpdated.dispatch(101, { url: 'https://github.com/zarazhangrui/tab-out' }, {
    id: 101,
    url: 'https://github.com/zarazhangrui/tab-out',
  });

  assert.equal(renderCalls.length, 0);
  assert.equal(timer.pendingCount, 1);

  timer.advance(DEBOUNCE_MS - 1);
  assert.equal(renderCalls.length, 0);

  timer.advance(1);
  assert.deepEqual(renderCalls, ['tab-updated']);
});

test('realtime tab refresh ignores irrelevant updates and renders on remove', () => {
  const chromeTabs = createFakeChromeTabs();
  const timer = createFakeTimer();
  const renderCalls = [];

  installRealtimeTabRefresh({
    chromeTabs,
    renderDashboard(reason) {
      renderCalls.push(reason);
    },
    setTimeoutFn: timer.setTimeout,
    clearTimeoutFn: timer.clearTimeout,
  });

  chromeTabs.onUpdated.dispatch(101, { audible: true }, {
    id: 101,
    url: 'https://github.com/zarazhangrui/tab-out',
  });
  timer.advance(DEBOUNCE_MS);
  assert.equal(renderCalls.length, 0);

  chromeTabs.onRemoved.dispatch(101, { windowId: 1, isWindowClosing: false });
  timer.advance(DEBOUNCE_MS);
  assert.deepEqual(renderCalls, ['tab-removed']);
});
