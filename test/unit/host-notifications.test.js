const { test } = require('node:test');
const assert = require('node:assert');

// Mock in-memory state for settings and servers
let mockSettings = new Map();
let mockServers = new Map();
let mockRules = new Map([
  ['container_die', { event_type: 'container_die', enabled: 1, cooldown_minutes: 5 }]
]);

// Mock db.js to avoid native sqlite dependency on host test runners
require.cache[require.resolve('../../server/db')] = {
  id: require.resolve('../../server/db'),
  filename: require.resolve('../../server/db'),
  loaded: true,
  exports: {
    stmts: {
      getSetting: { get: (k) => mockSettings.has(k) ? { value: mockSettings.get(k) } : null },
      setSetting: { run: (k, v) => { mockSettings.set(k, String(v)); } },
      getServer: { get: (id) => mockServers.get(id) || null },
      getServers: { all: () => [...mockServers.values()] },
      setServerNotifications: { run: (enabled, id) => { const s = mockServers.get(id); if (s) s.notifications_enabled = enabled; } },
      getRule: { get: (t) => mockRules.get(t) || null },
    }
  }
};

let emailsSent = [];
let telegrameMessagesSent = [];

// Mock mailer
require.cache[require.resolve('../../server/notifications/mailer')] = {
  id: require.resolve('../../server/notifications/mailer'),
  filename: require.resolve('../../server/notifications/mailer'),
  loaded: true,
  exports: {
    isConfigured: () => true,
    sendEmail: async (opts) => { emailsSent.push(opts); return { success: true }; }
  }
};

// Mock telegram
require.cache[require.resolve('../../server/notifications/telegram')] = {
  id: require.resolve('../../server/notifications/telegram'),
  filename: require.resolve('../../server/notifications/telegram'),
  loaded: true,
  exports: {
    isConfigured: () => true,
    sendMessage: async (opts) => { telegrameMessagesSent.push(opts); return { success: true }; }
  }
};

const EventMonitor = require('../../server/notifications/event-monitor');

test('EventMonitor.isNotificationEnabled: local daemon is enabled by default', () => {
  mockSettings.clear();
  const monitor = new EventMonitor('local', {});
  assert.strictEqual(monitor.isNotificationEnabled(), true);
});

test('EventMonitor.isNotificationEnabled: local daemon is muted when setting is 0', () => {
  mockSettings.set('local_notifications_enabled', '0');
  const monitor = new EventMonitor('local', {});
  assert.strictEqual(monitor.isNotificationEnabled(), false);

  mockSettings.set('local_notifications_enabled', '1');
  assert.strictEqual(monitor.isNotificationEnabled(), true);
});

test('EventMonitor.isNotificationEnabled: remote server follows notifications_enabled column', () => {
  mockServers.set('srv-prod', { id: 'srv-prod', name: 'Production', host: 'prod.example.com', notifications_enabled: 1 });
  mockServers.set('srv-test', { id: 'srv-test', name: 'Staging', host: 'test.example.com', notifications_enabled: 0 });

  const prodMonitor = new EventMonitor('srv-prod', {});
  const testMonitor = new EventMonitor('srv-test', {});

  assert.strictEqual(prodMonitor.isNotificationEnabled(), true);
  assert.strictEqual(testMonitor.isNotificationEnabled(), false);
});

test('EventMonitor._sendNotification: suppresses alerts when host is muted', async () => {
  emailsSent = [];
  telegrameMessagesSent = [];
  mockServers.set('srv-test', { id: 'srv-test', name: 'Staging', host: 'test.example.com', notifications_enabled: 0 });

  const testMonitor = new EventMonitor('srv-test', {});
  await testMonitor._sendNotification('container_die', 'cont-123', {
    subject: 'Container Died',
    html: '<p>died</p>',
    telegramText: 'Container Died'
  });

  assert.strictEqual(emailsSent.length, 0);
  assert.strictEqual(telegrameMessagesSent.length, 0);
});

test('EventMonitor._sendNotification: emits alerts when host is enabled', async () => {
  emailsSent = [];
  telegrameMessagesSent = [];
  mockServers.set('srv-prod', { id: 'srv-prod', name: 'Production', host: 'prod.example.com', notifications_enabled: 1 });

  const prodMonitor = new EventMonitor('srv-prod', {});
  await prodMonitor._sendNotification('container_die', 'cont-456', {
    subject: 'Container Died',
    html: '<p>died</p>',
    telegramText: 'Container Died'
  });

  assert.strictEqual(emailsSent.length, 1);
  assert.strictEqual(telegrameMessagesSent.length, 1);
  assert.strictEqual(emailsSent[0].subject, 'Container Died');
});
