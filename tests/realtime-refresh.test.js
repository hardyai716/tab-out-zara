'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  escapeHtml,
  installRealtimeTabRefresh,
  mergeOrderedIds,
} = require('../extension/核心逻辑.js');

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

test('realtime tab refresh debounces created and updated events', () => {
  const chromeTabs = createFakeChromeTabs();
  const timer = createFakeTimer();
  const renderCalls = [];

  installRealtimeTabRefresh({
    tabsApi: chromeTabs,
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
    tabsApi: chromeTabs,
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

test('escapeHtml neutralizes markup and action attributes from tab titles', () => {
  const maliciousTitle = '</span><button data-action="close-all-open-tabs">关闭</button>';

  assert.equal(
    escapeHtml(maliciousTitle),
    '&lt;/span&gt;&lt;button data-action=&quot;close-all-open-tabs&quot;&gt;关闭&lt;/button&gt;'
  );
});

test('mergeOrderedIds keeps filtered-out items with unique sort positions', () => {
  const merged = mergeOrderedIds(['C', 'B'], ['A', 'B', 'C', 'D']);

  assert.deepEqual(merged, ['C', 'B', 'A', 'D']);
  assert.equal(new Set(merged).size, 4);
});
