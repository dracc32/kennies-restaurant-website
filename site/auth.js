/*
 * Accounts client for the Kennies site.
 *
 * Talks to this app's own /api/auth endpoints (server/server.js) with a
 * same-origin session cookie, so no external identity provider is involved.
 * Exposes the same window.KAuth surface the page already uses.
 */

class AuthError extends Error {
  constructor(message, status = 500) {
    super(message || 'Something went wrong. Please try again.');
    this.name = 'AuthError';
    this.status = status;
  }
}

class MissingIdentityError extends AuthError {
  constructor(message) {
    super(message || 'Accounts are not available right now. Please try again later.', 503);
    this.name = 'MissingIdentityError';
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch {
    throw new MissingIdentityError();
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AuthError(data.error, res.status);
  return data;
}

let currentUser = null;
const listeners = new Set();

function notify(event) {
  for (const listener of listeners) {
    try {
      listener(event, currentUser);
    } catch (err) {
      console.warn(err);
    }
  }
}

function setUser(user, event) {
  currentUser = user || null;
  if (event) notify(event);
  return currentUser;
}

async function handleAuthCallback() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('recovery_token');
  if (!token) return null;

  url.searchParams.delete('recovery_token');
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);

  try {
    const { user } = await request('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    setUser(user, 'login');
    return { type: 'recovery', user };
  } catch (err) {
    return { type: 'recovery', error: err };
  }
}

window.KAuth = {
  AuthError,
  MissingIdentityError,

  async getUser() {
    try {
      const { user } = await request('/api/auth/me');
      currentUser = user;
      return user;
    } catch {
      return null;
    }
  },

  async login(email, password) {
    const { user } = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    return setUser(user, 'login');
  },

  async signup(email, password, data = {}) {
    const { user } = await request('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, full_name: data.full_name || '' }),
    });
    return setUser(user, 'login');
  },

  async logout() {
    try {
      await request('/api/auth/logout', { method: 'POST' });
    } finally {
      setUser(null, 'logout');
    }
  },

  async updateUser(data = {}) {
    const { user } = await request('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ password: data.password }),
    });
    return setUser(user, 'user');
  },

  async requestPasswordRecovery(email) {
    await request('/api/auth/forgot', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  },

  async acceptInvite() {
    throw new AuthError('Invitations are not available yet.', 404);
  },

  handleAuthCallback,

  onAuthChange(listener) {
    listeners.add(listener);
    if (currentUser) {
      try {
        listener('login', currentUser);
      } catch (err) {
        console.warn(err);
      }
    }
    return () => listeners.delete(listener);
  },
};

window.dispatchEvent(new Event('kauth:ready'));
