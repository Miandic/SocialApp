// ─── API Client for Diffract backend ───

const BASE = "/api";

function getToken() {
  return localStorage.getItem("access_token");
}

function setTokens(access, refresh) {
  localStorage.setItem("access_token", access);
  localStorage.setItem("refresh_token", refresh);
}

function clearTokens() {
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
}

async function request(method, path, body = null) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE}${path}`, opts);

  if (res.status === 401) {
    // Try refresh
    const refreshed = await tryRefresh();
    if (refreshed) {
      headers["Authorization"] = `Bearer ${getToken()}`;
      const retry = await fetch(`${BASE}${path}`, { ...opts, headers });
      if (!retry.ok) throw await retry.json();
      return retry.json();
    }
    clearTokens();
    window.dispatchEvent(new Event("auth:logout"));
    throw { error: "unauthorized", message: "Session expired" };
  }

  if (!res.ok) throw await res.json();
  return res.json();
}

async function tryRefresh() {
  const refreshToken = localStorage.getItem("refresh_token");
  if (!refreshToken) return false;

  try {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    setTokens(data.access_token, data.refresh_token);
    return true;
  } catch {
    return false;
  }
}

// ─── Auth ───
export const auth = {
  register: (data) => request("POST", "/auth/register", data),
  login: (data) => request("POST", "/auth/login", data),
  logout: () => request("POST", "/auth/logout"),
  me: () => request("GET", "/auth/me"),
  setTokens,
  clearTokens,
  getToken,
  isLoggedIn: () => !!getToken(),
};

// ─── Users ───
export const users = {
  profile: (username) => request("GET", `/users/${username}`),
  updateProfile: (data) => request("PATCH", "/users/profile", data),
  follow: (username) => request("POST", `/users/${username}/follow`),
  unfollow: (username) => request("DELETE", `/users/${username}/follow`),
  followers: (username, params = "") => request("GET", `/users/${username}/followers?${params}`),
  following: (username, params = "") => request("GET", `/users/${username}/following?${params}`),
};

// ─── Posts ───
export const posts = {
  create: (data) => request("POST", "/posts", data),
  get: (id) => request("GET", `/posts/${id}`),
  delete: (id) => request("DELETE", `/posts/${id}`),
  like: (id) => request("POST", `/posts/${id}/like`),
  unlike: (id) => request("DELETE", `/posts/${id}/like`),
  feed: (params = "") => request("GET", `/posts/feed?${params}`),
};

// ─── Devices ───
export const devices = {
  register: (data) => request("POST", "/devices", data),
  list: () => request("GET", "/devices"),
  approve: (deviceId) => request("POST", `/devices/${deviceId}/approve`),
  revoke: (deviceId) => request("DELETE", `/devices/${deviceId}`),
  uploadPreKeys: (deviceId, data) => request("POST", `/devices/${deviceId}/pre-keys`, data),
  getUserBundles: (userId) => request("GET", `/devices/user-bundles/${userId}`),
  sendHistoryPackage: (data) => request("POST", "/devices/history-sync", data),
  getHistoryPackage: (deviceId) => request("GET", `/devices/${deviceId}/history-sync`),
  deleteHistoryPackage: (deviceId) => request("DELETE", `/devices/${deviceId}/history-sync`),
};

// ─── Messenger ───
export const messenger = {
  createChat: (data) => request("POST", "/messenger/chats", data),
  listChats: (deviceId) => {
    const qs = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
    return request("GET", `/messenger/chats${qs}`);
  },
  getMessages: (chatId, deviceId, params = "") => {
    const qs = new URLSearchParams(params);
    if (deviceId) qs.set("device_id", deviceId);
    return request("GET", `/messenger/chats/${chatId}/messages?${qs}`);
  },

  connectWs: (deviceId) => {
    const token = getToken();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${location.host}/api/messenger/ws` +
        `?token=${encodeURIComponent(token)}&device_id=${encodeURIComponent(deviceId)}`
    );
    return ws;
  },
};

// ─── Media ───
export const media = {
  upload: async (files) => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    const token = getToken();
    const headers = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const doFetch = () =>
      fetch(`${BASE}/media/upload`, { method: "POST", headers, body: form });

    let res = await doFetch();
    if (res.status === 401) {
      const refreshed = await tryRefresh();
      if (!refreshed) {
        clearTokens();
        window.dispatchEvent(new Event("auth:logout"));
        throw { error: "unauthorized", message: "Session expired" };
      }
      headers["Authorization"] = `Bearer ${getToken()}`;
      res = await doFetch();
    }
    if (!res.ok) throw await res.json();
    return res.json(); // [{url, key}]
  },
};

// ─── Notifications ───
export const notifications = {
  list: (params = "") => request("GET", `/notifications?${params}`),
  markRead: (id) => request("PATCH", `/notifications/${id}/read`),
  markAllRead: () => request("PATCH", "/notifications/read-all"),
  unreadCount: () => request("GET", "/notifications/unread-count"),
};
