const { test } = require('node:test');
const assert = require('node:assert');

// Mock db.js to avoid native sqlite addon on local dev host without headers
require.cache[require.resolve('../../server/db')] = {
  id: require.resolve('../../server/db'),
  filename: require.resolve('../../server/db'),
  loaded: true,
  exports: {
    stmts: {
      getServers: { all: () => [] },
      getServer: { get: () => null },
      getSSHKey: { get: () => null },
    }
  }
};

const { EventEmitter } = require('events');

let lastExecutedCmd = null;

// Mock ssh2 Client
class MockClient extends EventEmitter {
  connect(opts) {
    process.nextTick(() => this.emit('ready'));
    return this;
  }
  exec(cmd, cb) {
    lastExecutedCmd = cmd;
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    process.nextTick(() => {
      if (cmd.includes('command -v git')) {
        stream.emit('data', '/usr/bin/git\n');
      } else if (cmd.includes('rev-parse HEAD')) {
        stream.emit('data', 'abc1234\n');
      }
      stream.emit('close', 0);
    });
    cb(null, stream);
  }
  end() {}
}

require.cache[require.resolve('ssh2')] = {
  id: require.resolve('ssh2'),
  filename: require.resolve('ssh2'),
  loaded: true,
  exports: { Client: MockClient }
};

// Mock ssh-keys module
require.cache[require.resolve('../../server/ssh-keys')] = {
  id: require.resolve('../../server/ssh-keys'),
  filename: require.resolve('../../server/ssh-keys'),
  loaded: true,
  exports: {
    getDecryptedPrivateKey: (id) => ({ id, name: 'deploy-key', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----' })
  }
};

const remoteCompose = require('../../server/remote-compose');

test('remote-compose: shq escaping formats arguments correctly', () => {
  assert.equal(remoteCompose.shq('simple'), "'simple'");
  assert.equal(remoteCompose.shq("has'quote"), "'has'\\''quote'");
  assert.equal(remoteCompose.shq(''), "''");
});

test('remote-compose: checkGitAvailable checks git presence', async () => {
  const mockServer = { host: '1.2.3.4', username: 'root', port: 22, password: 'pw' };
  const hasGit = await remoteCompose.checkGitAvailable(mockServer);
  assert.equal(hasGit, true);
  assert.ok(lastExecutedCmd.includes('command -v git'));
});

test('remote-compose: ensureRemoteKey provisions key to remote ~/.dockgate/keys/', async () => {
  const mockServer = { host: '1.2.3.4', username: 'root', port: 22, password: 'pw' };
  const remoteKeyPath = await remoteCompose.ensureRemoteKey(mockServer, 'k123');
  assert.equal(remoteKeyPath, '$HOME/.dockgate/keys/dg_key_k123');
  assert.ok(lastExecutedCmd.includes('mkdir -p $HOME/.dockgate/keys'));
  assert.ok(lastExecutedCmd.includes('chmod 600 $HOME/.dockgate/keys/dg_key_k123'));
});

test('remote-compose: runGitOnRemote constructs correct GIT_SSH_COMMAND when keyId is present', async () => {
  const mockServer = { host: '1.2.3.4', username: 'root', port: 22, password: 'pw' };

  // 1. Without keyId
  await remoteCompose.runGitOnRemote(mockServer, null, '/root/app', ['status']);
  assert.ok(lastExecutedCmd.includes("cd '/root/app'"), `Expected cd '/root/app' in: ${lastExecutedCmd}`);
  assert.ok(lastExecutedCmd.includes('GIT_TERMINAL_PROMPT=0'));

  // 2. With keyId (dg_key_k123)
  await remoteCompose.runGitOnRemote(mockServer, 'k123', '/root/app', ['fetch', 'origin']);
  assert.ok(lastExecutedCmd.includes('dg_key_k123'));
  assert.ok(lastExecutedCmd.includes('GIT_SSH_COMMAND='));
  assert.ok(lastExecutedCmd.includes('StrictHostKeyChecking=accept-new'));
  assert.ok(lastExecutedCmd.includes("cd '/root/app'"));
  assert.ok(lastExecutedCmd.includes("git 'fetch' 'origin'"));

  // 3. Clone with null cwd
  await remoteCompose.runGitOnRemote(mockServer, 'k123', null, ['clone', 'git@github.com:foo/bar.git', '/root/app']);
  assert.ok(lastExecutedCmd.includes("git 'clone'"));
  assert.ok(!lastExecutedCmd.includes('cd '));
});

test('remote-compose: removeRemoteKey executes rm -f on remote server', async () => {
  const mockServer = { host: '1.2.3.4', username: 'root', port: 22, password: 'pw' };
  await remoteCompose.removeRemoteKey(mockServer, 'k123');
  assert.ok(lastExecutedCmd.includes('rm -f "$HOME/.dockgate/keys/dg_key_k123"'));
});

