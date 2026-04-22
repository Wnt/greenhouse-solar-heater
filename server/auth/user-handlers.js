// User + passkey CRUD HTTP handlers. Extracted from webauthn.js.
// Auth gates (requireUser / requireAdmin) + small response helpers
// are inlined here rather than imported from webauthn.js to avoid a
// circular require — both modules depend on credStore and session.

const credStore = require('./credentials');
const session = require('./session');

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function requireUser(req, res) {
  var sess = session.validateRequest(req);
  if (!sess) { jsonResponse(res, 401, { error: 'Not authenticated' }); return null; }
  var user = credStore.getUserById(sess.userId);
  if (!user) { jsonResponse(res, 401, { error: 'Not authenticated' }); return null; }
  return user;
}

function requireAdmin(req, res) {
  var user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin') { jsonResponse(res, 403, { error: 'Admin role required' }); return null; }
  return user;
}

function serializeCredential(cred, currentCredentialId) {
  return {
    id: cred.id,
    userId: cred.userId,
    label: cred.label || '',
    createdAt: cred.createdAt || null,
    lastUsedAt: cred.lastUsedAt || null,
    lastIp: cred.lastIp || null,
    browser: cred.device && cred.device.browser || null,
    os: cred.device && cred.device.os || null,
    deviceType: cred.device && cred.device.deviceType || null,
    deviceName: cred.device && cred.device.deviceName || null,
    deviceSummary: cred.device && cred.device.summary || 'Unknown device',
    isCurrent: cred.id === currentCredentialId,
  };
}

function handleListUsers(req, res) {
  var caller = requireUser(req, res);
  if (!caller) return;
  var sess = session.validateRequest(req);
  var currentCredentialId = sess && sess.credentialId || null;

  var users = credStore.getUsers().map(function (u) {
    var creds = credStore.getCredentialsForUser(u.id);
    return {
      id: u.id,
      name: u.name,
      role: u.role,
      createdAt: u.createdAt || null,
      credentialCount: creds.length,
      isCurrent: u.id === caller.id,
      passkeys: creds.map(function (cred) {
        return serializeCredential(cred, currentCredentialId);
      }),
    };
  });
  jsonResponse(res, 200, { users: users });
}

function handleCreateUser(req, res, body) {
  var caller = requireAdmin(req, res);
  if (!caller) return;

  var parsed = {};
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch (e) {
    jsonResponse(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  var name = typeof parsed.name === 'string' ? parsed.name : '';
  var role = typeof parsed.role === 'string' ? parsed.role : 'readonly';
  try {
    var user = credStore.createUser(name, role);
    jsonResponse(res, 200, {
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        createdAt: user.createdAt,
        credentialCount: 0,
        isCurrent: false,
        passkeys: [],
      },
    });
  } catch (err) {
    jsonResponse(res, 400, { error: err.message });
  }
}

function handleUpdateUser(req, res, urlPath, body) {
  var caller = requireAdmin(req, res);
  if (!caller) return;

  var userId = urlPath.substring('/auth/users/'.length);
  if (!userId) {
    jsonResponse(res, 400, { error: 'Missing user id' });
    return;
  }
  var target = credStore.getUserById(userId);
  if (!target) {
    jsonResponse(res, 404, { error: 'User not found' });
    return;
  }

  var parsed;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch (e) {
    jsonResponse(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  var updates = {};
  if (typeof parsed.name === 'string') updates.name = parsed.name;
  if (typeof parsed.role === 'string') updates.role = parsed.role;

  // Refuse self-demotion so an admin can't lock themselves out via the API.
  if (target.id === caller.id && updates.role && updates.role !== caller.role) {
    jsonResponse(res, 400, { error: 'Cannot change your own role' });
    return;
  }

  try {
    var updated = credStore.updateUser(userId, updates);
    jsonResponse(res, 200, {
      ok: true,
      user: { id: updated.id, name: updated.name, role: updated.role },
    });
  } catch (err) {
    var status = err.message === 'User not found' ? 404 : 400;
    jsonResponse(res, status, { error: err.message });
  }
}

function handleDeleteUser(req, res, urlPath) {
  var caller = requireAdmin(req, res);
  if (!caller) return;

  var userId = urlPath.substring('/auth/users/'.length);
  if (!userId) {
    jsonResponse(res, 400, { error: 'Missing user id' });
    return;
  }
  var target = credStore.getUserById(userId);
  if (!target) {
    jsonResponse(res, 404, { error: 'User not found' });
    return;
  }
  if (target.id === caller.id) {
    jsonResponse(res, 400, { error: 'Cannot delete yourself' });
    return;
  }
  try {
    credStore.deleteUser(userId);
    jsonResponse(res, 200, { ok: true });
  } catch (err) {
    jsonResponse(res, 400, { error: err.message });
  }
}

function handleUpdatePasskey(req, res, urlPath, body) {
  var caller = requireAdmin(req, res);
  if (!caller) return;

  var credentialId = urlPath.substring('/auth/passkeys/'.length);
  if (!credentialId) {
    jsonResponse(res, 400, { error: 'Missing passkey id' });
    return;
  }
  var cred = credStore.getCredentialById(credentialId);
  if (!cred) {
    jsonResponse(res, 404, { error: 'Passkey not found' });
    return;
  }

  var parsed = {};
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch (e) {
    jsonResponse(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  var updates = {};
  if (typeof parsed.label === 'string') updates.label = parsed.label;
  if (typeof parsed.userId === 'string') updates.userId = parsed.userId;

  try {
    var updated = credStore.updateCredential(credentialId, updates);
    jsonResponse(res, 200, { ok: true, passkey: serializeCredential(updated, null) });
  } catch (err) {
    var status = /not found/i.test(err.message) ? 404 : 400;
    jsonResponse(res, status, { error: err.message });
  }
}

function handleDeletePasskey(req, res, urlPath) {
  var caller = requireAdmin(req, res);
  if (!caller) return;

  var credentialId = urlPath.substring('/auth/passkeys/'.length);
  if (!credentialId) {
    jsonResponse(res, 400, { error: 'Missing passkey id' });
    return;
  }
  var cred = credStore.getCredentialById(credentialId);
  if (!cred) {
    jsonResponse(res, 404, { error: 'Passkey not found' });
    return;
  }
  credStore.deleteCredential(credentialId);
  jsonResponse(res, 200, { ok: true });
}

module.exports = {
  handleListUsers,
  handleCreateUser,
  handleUpdateUser,
  handleDeleteUser,
  handleUpdatePasskey,
  handleDeletePasskey,
};
