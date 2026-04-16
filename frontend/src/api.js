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

// ─── Messenger ───
export const messenger = {
  createChat: (data) => request("POST", "/messenger/chats", data),
  listChats: () => request("GET", "/messenger/chats"),
  getMessages: (chatId, params = "") =>
    request("GET", `/messenger/chats/${chatId}/messages?${params}`),

  connectWs: () => {
    const token = getToken();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${location.host}/api/messenger/ws?token=${encodeURIComponent(token)}`
    );
    return ws;
  },
};

// ─── Notifications ───
export const notifications = {
  list: (params = "") => request("GET", `/notifications?${params}`),
  markRead: (id) => request("PATCH", `/notifications/${id}/read`),
  markAllRead: () => request("PATCH", "/notifications/read-all"),
  unreadCount: () => request("GET", "/notifications/unread-count"),
};
