import { auth, posts, users, messenger, notifications, media } from "./api.js";

// ─── Global state ───────────────────────────────────────────────────────────

let currentUser = null;        // Cached /me response; null when logged out
let ws = null;                 // Active WebSocket connection (or null)
let currentChatId = null;      // ID of the currently open chat, null on other pages
let lastReadByChat = {};        // { chatId: { userId: messageId } } — read receipts
let notifPollTimer = null;     // setInterval handle for notification badge polling
let pendingAttachments = [];   // Queued attachments before send: [{kind, file, thumb, objectUrl}]

// ─── SPA router ─────────────────────────────────────────────────────────────
// navigate(page, params) swaps the page by calling the matching render function.
// Params are passed via window.__params so render functions can read them.

const routes = {
  login: renderLogin,
  register: renderRegister,
  feed: renderFeed,
  profile: renderProfile,
  profileEdit: renderProfileEdit,
  post: renderPost,
  chats: renderChats,
  notifications: renderNotifications,
  followers: (c) => renderFollowList(c, "followers"),
  following: (c) => renderFollowList(c, "following"),
};

function navigate(page, params = {}) {
  currentChatId = null;
  window.__params = params;
  const main = document.getElementById("main");
  main.innerHTML = "";
  renderHeader();
  if (routes[page]) {
    routes[page](main);
  } else {
    navigate(auth.isLoggedIn() ? "feed" : "login");
  }
}

function renderHeader() {
  const header = document.getElementById("header");
  if (auth.isLoggedIn()) {
    header.innerHTML = `
      <div class="logo" data-page="feed" style="cursor:pointer">Diffract</div>
      <nav class="nav-links">
        <a data-page="feed">Feed</a>
        <a data-page="chats">Chats</a>
        <a data-page="notifications">Notifications<span id="notif-badge" class="notif-badge" style="display:none"></span></a>
        <a data-page="profile">Profile</a>
        <a id="logout-btn">Logout</a>
      </nav>
    `;
    header.querySelector("#logout-btn").onclick = async () => {
      stopNotifPolling();
      disconnectWs();
      try { await auth.logout(); } catch {}
      auth.clearTokens();
      currentUser = null;
      navigate("login");
    };
    header.querySelectorAll("[data-page]").forEach((a) => {
      a.onclick = () => navigate(a.dataset.page);
    });
    refreshNotifBadge();
  } else {
    header.innerHTML = `<div class="logo">Diffract</div>`;
  }
}

// ─── Notification polling ───

async function refreshNotifBadge() {
  const badge = document.getElementById("notif-badge");
  if (!badge) return;
  try {
    const { count } = await notifications.unreadCount();
    if (count > 0) {
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.style.display = "inline-block";
    } else {
      badge.style.display = "none";
    }
  } catch {}
}

function startNotifPolling() {
  stopNotifPolling();
  refreshNotifBadge();
  notifPollTimer = setInterval(refreshNotifBadge, 30000);
}

function stopNotifPolling() {
  if (notifPollTimer) {
    clearInterval(notifPollTimer);
    notifPollTimer = null;
  }
}

// ─── WebSocket management ───

function connectWs() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = messenger.connectWs();

  ws.onopen = () => {
    console.log("[WS] Connected");
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    } catch (e) {
      console.error("[WS] Failed to parse:", e);
    }
  };

  ws.onclose = () => {
    console.log("[WS] Disconnected");
    if (auth.isLoggedIn()) {
      setTimeout(connectWs, 3000);
    }
  };

  ws.onerror = (e) => {
    console.error("[WS] Error:", e);
  };
}

function disconnectWs() {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
}

function sendWs(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case "new_message":
      handleNewMessage(msg);
      break;
    case "typing":
      handleTyping(msg);
      break;
    case "messages_read":
      handleMessagesRead(msg);
      break;
    case "message_deleted":
      handleMessageDeleted(msg);
      break;
    case "error":
      console.warn("[WS] Error:", msg.message);
      toast(msg.message || "Server error");
      break;
    case "key_bundle":
      // Reserved for E2E — ignore for now
      break;
    default:
      console.warn("[WS] Unhandled message type:", msg.type, msg);
  }
}

function handleNewMessage(msg) {
  if (currentChatId === msg.chat_id) {
    appendMessage(msg);
    scrollMessagesDown();
    updateReadReceipts();
    // Auto-mark read if chat is open and message isn't mine
    if (currentUser && msg.sender_id !== currentUser.id) {
      sendWs({ type: "mark_read", chat_id: msg.chat_id, message_id: msg.id });
    }
  }

  const chatItem = document.querySelector(`[data-chat-id="${msg.chat_id}"]`);
  if (chatItem) {
    const preview = chatItem.querySelector(".chat-preview");
    if (preview) {
      preview.textContent = `${msg.sender_username}: ${extractPlainText(msg.encrypted_content)}`;
    }
    if (currentUser && msg.sender_id !== currentUser.id && msg.chat_id !== currentChatId) {
      const badge = chatItem.querySelector(".unread-badge");
      if (badge) {
        const current = parseInt(badge.textContent) || 0;
        const next = current + 1;
        badge.textContent = next > 99 ? "99+" : next;
        badge.classList.add("visible");
      }
    }
  }
}

function handleTyping(msg) {
  if (currentChatId === msg.chat_id) {
    const indicator = document.getElementById("typing-indicator");
    if (indicator) {
      indicator.textContent = `${msg.username} is typing...`;
      clearTimeout(indicator._timeout);
      indicator._timeout = setTimeout(() => {
        indicator.textContent = "";
      }, 2000);
    }
  }
}

function handleMessageDeleted(msg) {
  const el = document.querySelector(`[data-message-id="${msg.message_id}"]`);
  if (el) {
    el.classList.add("message-deleting");
    setTimeout(() => { el.remove(); updateReadReceipts(); }, 280);
  }
}

function handleMessagesRead(msg) {
  const map = lastReadByChat[msg.chat_id] || (lastReadByChat[msg.chat_id] = {});
  map[msg.user_id] = msg.last_read_message_id;
  if (currentChatId === msg.chat_id) {
    updateReadReceipts();
  }
}

function updateReadReceipts() {
  const messagesEl = document.getElementById("chat-messages");
  if (!messagesEl || !currentUser) return;

  // Hide all dots first
  messagesEl.querySelectorAll(".msg-status").forEach((el) => {
    el.classList.remove("visible", "read");
  });

  const allMsgs = Array.from(messagesEl.querySelectorAll("[data-message-id]"));
  const mineMsgs = allMsgs.filter((el) => el.classList.contains("message-mine"));
  if (mineMsgs.length === 0) return;

  // Find maxReadIndex across all other readers
  const readers = lastReadByChat[currentChatId] || {};
  const otherReaderIds = Object.keys(readers).filter((uid) => uid !== currentUser.id);
  let maxReadIndex = -1;
  for (const uid of otherReaderIds) {
    const lastReadId = readers[uid];
    if (!lastReadId) continue;
    const idx = allMsgs.findIndex((el) => el.dataset.messageId === lastReadId);
    if (idx === -1) { maxReadIndex = allMsgs.length - 1; break; }
    if (idx > maxReadIndex) maxReadIndex = idx;
  }

  const lastMine = mineMsgs[mineMsgs.length - 1];

  // Find last mine message whose position is <= maxReadIndex
  let lastReadMine = null;
  if (maxReadIndex >= 0) {
    for (let i = mineMsgs.length - 1; i >= 0; i--) {
      if (allMsgs.indexOf(mineMsgs[i]) <= maxReadIndex) {
        lastReadMine = mineMsgs[i];
        break;
      }
    }
  }

  if (lastReadMine === lastMine) {
    // Last sent was read — green dot only
    const dot = lastMine.querySelector(".msg-status");
    if (dot) dot.classList.add("visible", "read");
  } else {
    // Grey dot on last sent
    const greyDot = lastMine.querySelector(".msg-status");
    if (greyDot) greyDot.classList.add("visible");
    // Green dot on last read (if any)
    if (lastReadMine) {
      const greenDot = lastReadMine.querySelector(".msg-status");
      if (greenDot) greenDot.classList.add("visible", "read");
    }
  }
}

// ─── Unread badge sync ───────────────────────────────────────────────────────
// Reconciles sidebar unread badges against the latest chat list from the server.
// The currently open chat always shows 0 (messages are considered read immediately).
function syncBadges(chats) {
  for (const chat of chats) {
    const item = document.querySelector(`[data-chat-id="${chat.id}"]`);
    if (!item) continue;
    const badge = item.querySelector(".unread-badge");
    if (!badge) continue;
    const unread = chat.id === currentChatId ? 0 : (chat.unread_count || 0);
    badge.textContent = unread > 99 ? "99+" : unread;
    badge.classList.toggle("visible", unread > 0);
  }
}

// ─── Auth pages ───

function renderLogin(container) {
  container.innerHTML = `
    <div class="auth-container">
      <h2>Login</h2>
      <form id="login-form">
        <div class="form-group">
          <label>Username or Email</label>
          <input name="login" required />
        </div>
        <div class="form-group">
          <label>Password</label>
          <input name="password" type="password" required />
        </div>
        <div class="error-msg" id="login-error"></div>
        <button class="btn" type="submit" style="width:100%;margin-top:8px">Login</button>
      </form>
      <div class="auth-switch">
        No account? <a id="go-register">Register</a>
      </div>
    </div>
  `;

  document.getElementById("go-register").onclick = () => navigate("register");
  document.getElementById("login-form").onsubmit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      const data = await auth.login({
        login: form.get("login"),
        password: form.get("password"),
      });
      auth.setTokens(data.access_token, data.refresh_token);
      currentUser = data.user;
      connectWs();
      startNotifPolling();
      navigate("feed");
    } catch (err) {
      document.getElementById("login-error").textContent =
        err.message || "Login failed";
    }
  };
}

function renderRegister(container) {
  container.innerHTML = `
    <div class="auth-container">
      <h2>Register</h2>
      <form id="register-form">
        <div class="form-group">
          <label>Username</label>
          <input name="username" required minlength="3" maxlength="30" />
        </div>
        <div class="form-group">
          <label>Email</label>
          <input name="email" type="email" required />
        </div>
        <div class="form-group">
          <label>Password</label>
          <input name="password" type="password" required minlength="8" />
        </div>
        <div class="form-group">
          <label>Display Name (optional)</label>
          <input name="display_name" />
        </div>
        <div class="error-msg" id="register-error"></div>
        <button class="btn" type="submit" style="width:100%;margin-top:8px">Register</button>
      </form>
      <div class="auth-switch">
        Have an account? <a id="go-login">Login</a>
      </div>
    </div>
  `;

  document.getElementById("go-login").onclick = () => navigate("login");
  document.getElementById("register-form").onsubmit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      const data = await auth.register({
        username: form.get("username"),
        email: form.get("email"),
        password: form.get("password"),
        display_name: form.get("display_name") || null,
      });
      auth.setTokens(data.access_token, data.refresh_token);
      currentUser = data.user;
      connectWs();
      startNotifPolling();
      navigate("feed");
    } catch (err) {
      document.getElementById("register-error").textContent =
        err.message || "Registration failed";
    }
  };
}

// ─── Feed ───

function renderFeed(container) {
  container.innerHTML = `
    <div>
      <form id="post-form" class="card">
        <textarea name="content" rows="3" placeholder="What's on your mind?" style="margin-bottom:10px"></textarea>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <label class="btn-outline btn btn-sm" style="cursor:pointer;margin:0">
            📎 Attach
            <input type="file" name="files" multiple accept="image/*,video/*" style="display:none" id="post-files" />
          </label>
          <span id="post-files-info" style="color:var(--text-muted);font-size:13px;flex:1"></span>
          <button class="btn btn-sm" type="submit">Post</button>
        </div>
      </form>
      <div id="feed-list"></div>
    </div>
  `;

  const fileInput = document.getElementById("post-files");
  const fileInfo = document.getElementById("post-files-info");
  fileInput.onchange = () => {
    const n = fileInput.files.length;
    fileInfo.textContent = n ? `${n} file${n > 1 ? "s" : ""} selected` : "";
  };

  document.getElementById("post-form").onsubmit = async (e) => {
    e.preventDefault();
    const content = new FormData(e.target).get("content");
    if (!content.trim()) return;

    const submitBtn = e.target.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      let media_urls = [];
      if (fileInput.files.length > 0) {
        submitBtn.textContent = "Uploading...";
        const uploaded = await media.upload(fileInput.files);
        media_urls = uploaded.map((u) => u.url);
      }
      submitBtn.textContent = "Posting...";
      await posts.create({ content, media_urls });
      e.target.reset();
      fileInfo.textContent = "";
      loadFeed();
    } catch (err) {
      toast(err.message || "Failed to post");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Post";
    }
  };

  loadFeed();
}

async function loadFeed() {
  const list = document.getElementById("feed-list");
  if (!list) return;
  try {
    const feed = await posts.feed();
    if (feed.length === 0) {
      list.innerHTML = `<div class="card" style="text-align:center;color:var(--text-muted)">No posts yet. Follow someone or write your first post!</div>`;
      return;
    }
    list.innerHTML = feed.map(renderPostCard).join("");
    attachPostActions(list);
  } catch (err) {
    list.innerHTML = `<div class="error-msg">${err.message || "Failed to load feed"}</div>`;
  }
}

function renderPostCard(post) {
  const time = new Date(post.created_at).toLocaleString();
  const avatar = post.author.avatar_url
    ? `<img class="avatar-sm" src="${escapeAttr(post.author.avatar_url)}" alt="" />`
    : `<div class="avatar-sm avatar-placeholder">${(post.author.username[0] || "?").toUpperCase()}</div>`;
  const mediaHtml = (post.media_urls || []).length
    ? `<div class="media-grid">${post.media_urls
        .map((u) => renderMediaItem(u))
        .join("")}</div>`
    : "";
  const mine = currentUser && post.author.id === currentUser.id;
  const deleteBtn = mine
    ? `<button data-action="delete" data-id="${post.id}" class="btn-link-danger">Delete</button>`
    : "";
  return `
    <div class="card post-card" data-post-id="${post.id}">
      <div class="post-author">
        ${avatar}
        <div style="flex:1">
          <strong data-user="${escapeAttr(post.author.username)}" class="user-link">${escapeHtml(post.author.display_name || post.author.username)}</strong>
          <span>@${escapeHtml(post.author.username)} · ${time}</span>
        </div>
      </div>
      <div class="post-content post-body" data-id="${post.id}">${escapeHtml(post.content)}</div>
      ${mediaHtml}
      <div class="post-actions">
        <button data-action="like" data-id="${post.id}">
          ${post.is_liked ? "♥ Unlike" : "♡ Like"} (${post.like_count})
        </button>
        <button data-action="open" data-id="${post.id}">💬 View</button>
        ${deleteBtn}
      </div>
    </div>
  `;
}

function renderMediaItem(url) {
  const lower = url.toLowerCase();
  if (lower.match(/\.(mp4|webm)(\?|$)/)) {
    return `<video src="${escapeAttr(url)}" controls class="media-item"></video>`;
  }
  return `<img src="${escapeAttr(url)}" class="media-item" alt="" />`;
}

function attachPostActions(container) {
  container.querySelectorAll("[data-action='like']").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const isLiked = btn.textContent.trim().includes("Unlike");
      try {
        if (isLiked) await posts.unlike(id);
        else await posts.like(id);
        loadFeed();
      } catch {}
    };
  });
  container.querySelectorAll("[data-action='delete']").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this post?")) return;
      try {
        await posts.delete(btn.dataset.id);
        loadFeed();
      } catch (err) {
        toast(err.message || "Delete failed");
      }
    };
  });
  container.querySelectorAll("[data-action='open'], .post-body").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      navigate("post", { id: el.dataset.id });
    };
  });
  container.querySelectorAll(".user-link").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      navigate("profile", { username: el.dataset.user });
    };
  });
}

// ─── Single post ───

async function renderPost(container) {
  const id = window.__params.id;
  if (!id) return navigate("feed");

  container.innerHTML = `
    <div>
      <a class="back-link" id="back-link">← Back</a>
      <div id="post-view"></div>
    </div>
  `;
  document.getElementById("back-link").onclick = () => navigate("feed");

  try {
    const post = await posts.get(id);
    const view = document.getElementById("post-view");
    view.innerHTML = renderPostCard(post);
    attachPostActions(view);
  } catch (err) {
    document.getElementById("post-view").innerHTML = `<div class="error-msg">${err.message || "Post not found"}</div>`;
  }
}

// ─── Profile ───

async function renderProfile(container) {
  try {
    if (!currentUser) currentUser = await auth.me();
    const username = (window.__params && window.__params.username) || currentUser.username;
    const profile = await users.profile(username);
    const isMe = profile.id === currentUser.id;

    const avatar = profile.avatar_url
      ? `<img class="avatar" src="${escapeAttr(profile.avatar_url)}" alt="" />`
      : `<div class="avatar avatar-placeholder">${(profile.username[0] || "?").toUpperCase()}</div>`;

    const actionBtn = isMe
      ? `<button class="btn btn-sm" id="edit-profile-btn">Edit profile</button>`
      : `<button class="btn btn-sm ${profile.is_following ? "follow-btn-following" : ""}" id="follow-btn">${profile.is_following ? "Unfollow" : "Follow"}</button>`;

    container.innerHTML = `
      <div class="card profile-card">
        <div class="profile-top">
          ${avatar}
          <div style="flex:1">
            <h2>${escapeHtml(profile.display_name || profile.username)}</h2>
            <p style="color:var(--text-muted)">@${escapeHtml(profile.username)}</p>
          </div>
          ${actionBtn}
        </div>
        ${profile.bio ? `<p style="margin-top:12px">${escapeHtml(profile.bio)}</p>` : ""}
        <div style="display:flex;gap:20px;margin-top:12px;color:var(--text-muted);font-size:14px">
          <a class="follow-count" id="followers-link"><strong>${profile.followers_count}</strong> followers</a>
          <a class="follow-count" id="following-link"><strong>${profile.following_count}</strong> following</a>
        </div>
      </div>
    `;

    document.getElementById("followers-link").onclick = () =>
      navigate("followers", { username: profile.username });
    document.getElementById("following-link").onclick = () =>
      navigate("following", { username: profile.username });

    if (isMe) {
      document.getElementById("edit-profile-btn").onclick = () => navigate("profileEdit");
    } else {
      document.getElementById("follow-btn").onclick = async () => {
        try {
          if (profile.is_following) await users.unfollow(profile.username);
          else await users.follow(profile.username);
          renderProfile(container);
        } catch (err) {
          toast(err.message || "Action failed");
        }
      };
    }
  } catch (err) {
    container.innerHTML = `<div class="error-msg">${err.message || "Failed to load profile"}</div>`;
  }
}

async function renderProfileEdit(container) {
  if (!currentUser) {
    try { currentUser = await auth.me(); } catch { return navigate("login"); }
  }
  const profile = await users.profile(currentUser.username).catch(() => null);
  if (!profile) {
    container.innerHTML = `<div class="error-msg">Failed to load profile</div>`;
    return;
  }

  let avatarUrl = profile.avatar_url || "";

  container.innerHTML = `
    <div class="card" style="max-width:500px">
      <h2 style="margin-bottom:16px">Edit profile</h2>
      <form id="edit-form">
        <div class="form-group">
          <label>Avatar</label>
          <div style="display:flex;gap:12px;align-items:center">
            <div id="avatar-preview">
              ${avatarUrl
                ? `<img class="avatar" src="${escapeAttr(avatarUrl)}" alt="" />`
                : `<div class="avatar avatar-placeholder">${(profile.username[0] || "?").toUpperCase()}</div>`}
            </div>
            <label class="btn btn-outline btn-sm" style="cursor:pointer;margin:0">
              Upload
              <input type="file" id="avatar-input" accept="image/*" style="display:none" />
            </label>
          </div>
        </div>
        <div class="form-group">
          <label>Display name</label>
          <input name="display_name" maxlength="100" value="${escapeAttr(profile.display_name || "")}" />
        </div>
        <div class="form-group">
          <label>Bio</label>
          <textarea name="bio" rows="4" maxlength="500">${escapeHtml(profile.bio || "")}</textarea>
        </div>
        <div class="error-msg" id="edit-error"></div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn" type="submit">Save</button>
          <button class="btn btn-outline" type="button" id="cancel-edit">Cancel</button>
        </div>
      </form>
    </div>
  `;

  document.getElementById("cancel-edit").onclick = () => navigate("profile");

  document.getElementById("avatar-input").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const [uploaded] = await media.upload([file]);
      avatarUrl = uploaded.url;
      document.getElementById("avatar-preview").innerHTML =
        `<img class="avatar" src="${escapeAttr(avatarUrl)}" alt="" />`;
    } catch (err) {
      toast(err.message || "Upload failed");
    }
  };

  document.getElementById("edit-form").onsubmit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      await users.updateProfile({
        display_name: form.get("display_name") || null,
        bio: form.get("bio") || null,
        avatar_url: avatarUrl || null,
      });
      toast("Profile updated");
      navigate("profile");
    } catch (err) {
      document.getElementById("edit-error").textContent = err.message || "Save failed";
    }
  };
}

// ─── Followers / Following ───

async function renderFollowList(container, kind) {
  const username = (window.__params && window.__params.username) ||
    (currentUser && currentUser.username);
  if (!username) return navigate("feed");

  container.innerHTML = `
    <div>
      <a class="back-link" id="back-link">← Back to @${escapeHtml(username)}</a>
      <h2 style="margin:12px 0">${kind === "followers" ? "Followers" : "Following"}</h2>
      <div id="users-list" class="card">Loading...</div>
    </div>
  `;
  document.getElementById("back-link").onclick = () =>
    navigate("profile", { username });

  try {
    const list = kind === "followers"
      ? await users.followers(username)
      : await users.following(username);

    const listEl = document.getElementById("users-list");
    if (list.length === 0) {
      listEl.innerHTML = `<div style="color:var(--text-muted)">Nobody here yet.</div>`;
      return;
    }
    listEl.innerHTML = list.map((u) => {
      const avatar = u.avatar_url
        ? `<img class="avatar-sm" src="${escapeAttr(u.avatar_url)}" alt="" />`
        : `<div class="avatar-sm avatar-placeholder">${(u.username[0] || "?").toUpperCase()}</div>`;
      return `
        <div class="user-row" data-user="${escapeAttr(u.username)}">
          ${avatar}
          <div>
            <strong>${escapeHtml(u.display_name || u.username)}</strong>
            <div style="color:var(--text-muted);font-size:13px">@${escapeHtml(u.username)}</div>
          </div>
        </div>
      `;
    }).join("");
    listEl.querySelectorAll(".user-row").forEach((row) => {
      row.onclick = () => navigate("profile", { username: row.dataset.user });
    });
  } catch (err) {
    document.getElementById("users-list").innerHTML =
      `<div class="error-msg">${err.message || "Failed to load"}</div>`;
  }
}

// ─── Notifications page ───

async function renderNotifications(container) {
  container.innerHTML = `
    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <h2>Notifications</h2>
        <button class="btn btn-sm btn-outline" id="mark-all-btn">Mark all read</button>
      </div>
      <div id="notif-list" class="card">Loading...</div>
    </div>
  `;

  document.getElementById("mark-all-btn").onclick = async () => {
    try {
      await notifications.markAllRead();
      refreshNotifBadge();
      renderNotifications(container);
    } catch (err) {
      toast(err.message || "Failed");
    }
  };

  try {
    const list = await notifications.list();
    const listEl = document.getElementById("notif-list");
    if (list.length === 0) {
      listEl.innerHTML = `<div style="color:var(--text-muted);text-align:center">No notifications</div>`;
      return;
    }
    listEl.innerHTML = list.map((n) => {
      const time = new Date(n.created_at).toLocaleString();
      return `
        <div class="notification-item ${n.is_read ? "" : "notification-unread"}" data-id="${n.id}" data-type="${n.notification_type}" data-json='${escapeAttr(JSON.stringify(n.data))}'>
          <div class="notif-text">${renderNotifText(n)}</div>
          <div style="color:var(--text-muted);font-size:12px;margin-top:4px">${time}</div>
        </div>
      `;
    }).join("");

    listEl.querySelectorAll(".notification-item").forEach((el) => {
      el.onclick = async () => {
        const id = el.dataset.id;
        const type = el.dataset.type;
        let data = {};
        try { data = JSON.parse(el.dataset.json); } catch {}
        try { await notifications.markRead(id); } catch {}
        refreshNotifBadge();

        if ((type === "like" || type === "repost" || type === "mention") && data.post_id) {
          navigate("post", { id: data.post_id });
        } else if (type === "follow" && data.username) {
          navigate("profile", { username: data.username });
        } else if (type === "message" && data.chat_id) {
          navigate("chats");
        }
      };
    });
  } catch (err) {
    document.getElementById("notif-list").innerHTML =
      `<div class="error-msg">${err.message || "Failed to load"}</div>`;
  }
}

function renderNotifText(n) {
  const d = n.data || {};
  const who = d.username ? `@${escapeHtml(d.username)}` : "Someone";
  switch (n.notification_type) {
    case "follow": return `${who} started following you`;
    case "like": return `${who} liked your post`;
    case "repost": return `${who} reposted your post`;
    case "mention": return `${who} mentioned you`;
    case "message": return `New message from ${who}`;
    default: return `${n.notification_type}`;
  }
}

// ─── Chats ───────────────────────────────────────────────────────────────────
//
// Page structure:
//   renderChats()      — builds the two-column layout (sidebar + main area)
//   loadChatList()     — fetches /chats and populates the sidebar list
//   openChat(id)       — loads a specific chat: header, message history, input
//   renderMessage()    — produces the HTML string for a single message bubble
//   appendMessage()    — appends a new message to the open chat (called on WS event)

async function renderChats(container) {
  if (!currentUser) {
    try {
      currentUser = await auth.me();
    } catch {
      navigate("login");
      return;
    }
  }

  currentChatId = null;

  container.innerHTML = `
    <div class="chat-layout">
      <div class="chat-sidebar">
        <div class="chat-sidebar-header">
          <h3>Chats</h3>
          <button class="btn btn-sm" id="new-chat-btn">+ New</button>
        </div>
        <div id="chat-list" class="chat-list">
          <div style="padding:16px;color:var(--text-muted);text-align:center">Loading...</div>
        </div>
      </div>
      <div class="chat-main" id="chat-main">
        <div class="chat-empty">
          <p>Select a chat or start a new conversation</p>
        </div>
      </div>
    </div>
  `;

  document.getElementById("new-chat-btn").onclick = showNewChatDialog;

  connectWs();
  await loadChatList();
}

async function loadChatList() {
  const listEl = document.getElementById("chat-list");
  if (!listEl) return;

  try {
    const chats = await messenger.listChats();

    if (chats.length === 0) {
      listEl.innerHTML = `
        <div style="padding:16px;color:var(--text-muted);text-align:center;font-size:14px">
          No chats yet.<br>Click "+ New" to start a conversation.
        </div>
      `;
      return;
    }

    listEl.innerHTML = chats.map((chat) => {
      const name = getChatDisplayName(chat);
      const preview = chat.last_message
        ? `${chat.last_message.sender_username}: ${extractPlainText(chat.last_message.encrypted_content)}`
        : "No messages yet";
      const active = currentChatId === chat.id ? " chat-item-active" : "";
      const unread = chat.unread_count || 0;
      const badgeHtml = `<span class="unread-badge${unread > 0 ? " visible" : ""}">${unread > 99 ? "99+" : unread}</span>`;
      return `
        <div class="chat-item${active}" data-chat-id="${chat.id}">
          <div class="chat-item-row">
            <div class="chat-name">${escapeHtml(name)}</div>
            ${badgeHtml}
          </div>
          <div class="chat-preview">${escapeHtml(preview)}</div>
        </div>
      `;
    }).join("");

    listEl.querySelectorAll(".chat-item").forEach((el) => {
      el.onclick = () => openChat(el.dataset.chatId);
    });
  } catch (err) {
    listEl.innerHTML = `<div class="error-msg" style="padding:16px">${err.message || "Failed to load chats"}</div>`;
  }
}

function getChatDisplayName(chat) {
  if (chat.is_group) return chat.name || "Group Chat";
  const other = chat.members.find((m) => m.user_id !== currentUser.id);
  if (other) return other.display_name || other.username;
  return "Chat";
}

// Opens a chat by ID: resets the main area, loads chat metadata + message history,
// and wires up all event handlers (submit, paste, keydown, attach, emoji, lightbox).
// Re-entrant safe: each call overwrites the previous DOM and event handlers via innerHTML.
async function openChat(chatId) {
  currentChatId = chatId;

  document.querySelectorAll(".chat-item").forEach((el) => {
    el.classList.toggle("chat-item-active", el.dataset.chatId === chatId);
  });

  // Clear pending attachments from previous chat
  clearPendingAttachments();

  const mainEl = document.getElementById("chat-main");
  mainEl.innerHTML = `
    <div class="chat-header" id="chat-header">Loading...</div>
    <div class="chat-messages" id="chat-messages">
      <div style="padding:20px;text-align:center;color:var(--text-muted)">Loading messages...</div>
    </div>
    <div id="typing-indicator" class="typing-indicator"></div>
    <div id="pending-tray" class="pending-tray" style="display:none"></div>
    <form class="chat-input" id="chat-input-form">
      <button class="attach-btn" type="button" id="attach-btn" title="Attach">📎</button>
      <div id="chat-input" class="chat-input-field" contenteditable="true" data-placeholder="Type a message..."></div>
      <button class="attach-btn emoji-btn" type="button" id="emoji-btn" title="Emoji"><img src="/emoji/apple/64/1f601.png" width="20" height="20" draggable="false" alt="😁"></button>
      <button class="btn" type="submit">Send</button>
    </form>
    <div class="attach-menu" id="attach-menu" style="display:none">
      <button class="attach-item" id="attach-media-btn">📷 Photo / Video / GIF</button>
      <button class="attach-item" id="attach-file-btn">📄 File</button>
    </div>
    <input type="file" id="media-file-input" accept="image/*,video/*" multiple style="display:none" />
    <input type="file" id="raw-file-input" multiple style="display:none" />
  `;

  try {
    const chats = await messenger.listChats();
    syncBadges(chats);
    const chat = chats.find((c) => c.id === chatId);

    if (chat) {
      const name = getChatDisplayName(chat);
      const memberCount = chat.is_group ? ` (${chat.members.length} members)` : "";
      const other = !chat.is_group
        ? chat.members.find((m) => m.user_id !== currentUser?.id)
        : null;
      const chatHeaderEl = document.getElementById("chat-header");
      chatHeaderEl.innerHTML = `
        ${other
          ? `<strong class="chat-header-link" data-username="${escapeAttr(other.username)}">${escapeHtml(name)}</strong>`
          : `<strong>${escapeHtml(name)}</strong>`}
        <span style="color:var(--text-muted);font-size:13px">${memberCount}</span>
      `;
      if (other) {
        document.querySelector(".chat-header-link")?.addEventListener("click", () => {
          navigate("profile", { username: other.username });
        });
      }
    }

    const messages = await messenger.getMessages(chatId);
    const messagesEl = document.getElementById("chat-messages");

    if (messages.length === 0) {
      messagesEl.innerHTML = `
        <div style="padding:20px;text-align:center;color:var(--text-muted)">
          No messages yet. Say hello!
        </div>
      `;
    } else {
      const ordered = messages.slice().reverse();
      messagesEl.innerHTML = ordered.map((m, i) => renderMessage(m, i > 0 ? ordered[i - 1] : null)).join("");
      scrollMessagesDown();

      // Mark the last message as read (if it's not mine)
      const last = ordered[ordered.length - 1];
      if (last && currentUser && last.sender_id !== currentUser.id) {
        sendWs({ type: "mark_read", chat_id: chatId, message_id: last.id });
      }
      updateReadReceipts();
    }
  } catch (err) {
    document.getElementById("chat-messages").innerHTML = `
      <div class="error-msg" style="padding:20px">${err.message || "Failed to load messages"}</div>
    `;
  }

  // Media lightbox + sender profile navigation
  const msgsEl = document.getElementById("chat-messages");
  msgsEl?.addEventListener("click", (e) => {
    const tile = e.target.closest(".gallery-tile[data-url]");
    if (tile) { openGalleryLightbox(tile); return; }
    const wrap = e.target.closest(".msg-media-wrap");
    if (wrap) { openLightbox(wrap); return; }
    const sender = e.target.closest(".message-sender.user-link");
    if (sender) navigate("profile", { username: sender.dataset.user });
  });
  // Cached images fire onload before DOM insertion — mark already-complete ones
  msgsEl?.querySelectorAll?.(".msg-media-img")?.forEach((img) => {
    if (img.complete && img.naturalWidth) img.closest(".msg-media-wrap")?.classList.add("media-loaded");
  });

  // Right-click context menu on messages
  document.getElementById("chat-messages")?.addEventListener("contextmenu", (e) => {
    const msgEl = e.target.closest(".message");
    if (!msgEl) return;
    e.preventDefault();
    showMsgCtxMenu(e.clientX, e.clientY, msgEl.dataset.messageId, msgEl.classList.contains("message-mine"));
  });

  const inputEl = document.getElementById("chat-input");

  // ── Attach menu ──
  const attachBtn  = document.getElementById("attach-btn");
  const attachMenu = document.getElementById("attach-menu");
  const mediaInput = document.getElementById("media-file-input");
  const fileInput  = document.getElementById("raw-file-input");

  attachBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = attachMenu.style.display !== "none";
    attachMenu.style.display = open ? "none" : "block";
    if (!open) {
      // Position above the attach button
      const r = attachBtn.getBoundingClientRect();
      const mh = attachMenu.offsetHeight || 90;
      attachMenu.style.left = `${r.left}px`;
      attachMenu.style.top  = `${r.top - mh - 6 + window.scrollY}px`;
    }
  });

  document.addEventListener("click", () => { attachMenu.style.display = "none"; }, { once: false, capture: false });

  document.getElementById("attach-media-btn").onclick = () => { attachMenu.style.display = "none"; mediaInput.click(); };
  document.getElementById("attach-file-btn").onclick  = () => { attachMenu.style.display = "none"; fileInput.click(); };

  // ── Emoji picker ──
  setupEmojiBtn();

  mediaInput.addEventListener("change", async () => {
    for (const f of Array.from(mediaInput.files)) await addMediaAttachment(f);
    mediaInput.value = "";
  });

  fileInput.addEventListener("change", async () => {
    for (const f of Array.from(fileInput.files)) addFileAttachment(f);
    fileInput.value = "";
  });

  // Strip formatting on paste — insert plain text only
  inputEl.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
  });

  document.getElementById("chat-input-form").onsubmit = async (e) => {
    e.preventDefault();
    // textContent misses <img alt> — also check for emoji images
    const hasText = !!inputEl.textContent.trim() || !!inputEl.querySelector("img.emoji");
    const hasAttachments = pendingAttachments.length > 0;
    if (!hasText && !hasAttachments) return;

    const btn = e.target.querySelector("[type=submit]");
    const mediaAtts = pendingAttachments.filter(a => a.kind === "media");
    const fileAtts  = pendingAttachments.filter(a => a.kind === "file");
    const richText  = hasText ? serializeRichText(inputEl) : null;

    clearPendingAttachments();
    if (hasText) { inputEl.innerHTML = ""; inputEl.style.height = ""; }

    if (hasAttachments && btn) { btn.disabled = true; btn.textContent = "Uploading…"; }

    try {
      // File attachments always sent individually
      for (const att of fileAtts) await uploadAndSendAttachment(att, chatId);

      if (mediaAtts.length === 1 && !richText) {
        // Single media, no caption → single-media message (existing behavior)
        await uploadAndSendAttachment(mediaAtts[0], chatId);
      } else if (mediaAtts.length > 0) {
        // Multiple media, or media + caption → gallery message
        await uploadAndSendGallery(mediaAtts, richText, chatId);
      } else if (richText) {
        // Text only
        sendWs({ type: "send_message", chat_id: chatId, encrypted_content: richText, nonce: "text-" + Date.now(), message_type: "text" });
      }
    } finally {
      if (hasAttachments && btn) { btn.disabled = false; btn.textContent = "Send"; }
    }

    inputEl.focus();
  };

  inputEl.addEventListener("keydown", (e) => {
    // Backspace: undo emoji shortcode conversion if just converted
    if (e.key === "Backspace" && _emojiLastConversion) {
      if (undoEmojiConversion()) { e.preventDefault(); return; }
    }
    // Clear conversion state on any other key
    if (e.key !== "Backspace") _emojiLastConversion = null;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("chat-input-form").requestSubmit();
    }
  });

  let typingTimeout = null;
  inputEl.oninput = () => {
    if (!_emojiConverting) {
      _emojiLastConversion = null;           // clear on any manual input
      tryEmojiShortcode(inputEl);            // try :shortcode: → 😀 conversion
      _applyEmojiToInputSafe(inputEl);       // convert any typed/pasted Unicode emoji → Apple <img>
    }
    if (!typingTimeout) {
      sendWs({ type: "typing", chat_id: chatId });
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      typingTimeout = null;
    }, 2000);
  };
}

function renderMessage(msg, prevMsg = null) {
  const isMe = currentUser && msg.sender_id === currentUser.id;
  const isGrouped = prevMsg
    && prevMsg.sender_id === msg.sender_id
    && (new Date(msg.created_at) - new Date(prevMsg.created_at)) < 3 * 60 * 1000;
  const time = new Date(msg.created_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const statusHtml = isMe ? `<span class="msg-status"></span>` : "";
  return `
    <div class="message ${isMe ? "message-mine" : "message-theirs"}${isGrouped ? " message-grouped" : ""}"
         data-message-id="${msg.id}"
         data-sender-id="${escapeAttr(msg.sender_id)}"
         data-created-at="${escapeAttr(msg.created_at)}">
      ${!isGrouped && !isMe ? `<div class="message-sender user-link" data-user="${escapeAttr(msg.sender_username)}">${escapeHtml(msg.sender_username)}</div>` : ""}
      <div class="message-bubble ${isMe ? "bubble-mine" : "bubble-theirs"}">
        <div class="message-text">${renderRichText(msg.encrypted_content)}</div>
        <div class="message-meta">
          <span class="message-time">${time}</span>
          ${statusHtml}
        </div>
      </div>
    </div>
  `;
}

function appendMessage(msg) {
  const messagesEl = document.getElementById("chat-messages");
  if (!messagesEl) return;

  const placeholder = messagesEl.querySelector("[style*='text-align:center']");
  if (placeholder) placeholder.remove();

  const allMsgEls = messagesEl.querySelectorAll("[data-message-id]");
  const lastEl = allMsgEls[allMsgEls.length - 1];
  const prevMsg = lastEl ? { sender_id: lastEl.dataset.senderId, created_at: lastEl.dataset.createdAt } : null;

  messagesEl.insertAdjacentHTML("beforeend", renderMessage(msg, prevMsg));
}

function scrollMessagesDown() {
  const el = document.getElementById("chat-messages");
  if (el) {
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }
}

// ─── New Chat Dialog ───

function showNewChatDialog() {
  const existing = document.getElementById("new-chat-dialog");
  if (existing) {
    existing.remove();
    return;
  }

  const dialog = document.createElement("div");
  dialog.id = "new-chat-dialog";
  dialog.className = "new-chat-dialog";
  dialog.innerHTML = `
    <div class="new-chat-overlay" id="dialog-overlay"></div>
    <div class="new-chat-content">
      <h3>New Chat</h3>
      <div class="tab-row">
        <button class="tab-btn tab-active" data-tab="dm">Direct</button>
        <button class="tab-btn" data-tab="group">Group</button>
      </div>

      <div id="dm-panel">
        <div class="form-group">
          <label>Username</label>
          <input id="new-chat-username" placeholder="Enter username to chat with" />
        </div>
      </div>

      <div id="group-panel" style="display:none">
        <div class="form-group">
          <label>Group name</label>
          <input id="group-name" placeholder="e.g. Weekend crew" />
        </div>
        <div class="form-group">
          <label>Add member</label>
          <div style="display:flex;gap:6px">
            <input id="group-member-input" placeholder="username" />
            <button class="btn btn-sm" type="button" id="add-member-btn">Add</button>
          </div>
          <div id="group-members" class="chip-row" style="margin-top:10px"></div>
        </div>
      </div>

      <div class="error-msg" id="new-chat-error"></div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn" id="start-chat-btn">Start</button>
        <button class="btn btn-outline" id="cancel-chat-btn">Cancel</button>
      </div>
    </div>
  `;

  document.body.appendChild(dialog);

  const groupMembers = []; // {id, username, display_name}
  let mode = "dm";

  dialog.querySelectorAll(".tab-btn").forEach((b) => {
    b.onclick = () => {
      mode = b.dataset.tab;
      dialog.querySelectorAll(".tab-btn").forEach((x) =>
        x.classList.toggle("tab-active", x === b)
      );
      document.getElementById("dm-panel").style.display = mode === "dm" ? "" : "none";
      document.getElementById("group-panel").style.display = mode === "group" ? "" : "none";
    };
  });

  const renderChips = () => {
    const el = document.getElementById("group-members");
    el.innerHTML = groupMembers
      .map((m, i) =>
        `<span class="user-chip">@${escapeHtml(m.username)}<span class="chip-x" data-idx="${i}">×</span></span>`
      )
      .join("");
    el.querySelectorAll(".chip-x").forEach((x) => {
      x.onclick = () => {
        groupMembers.splice(Number(x.dataset.idx), 1);
        renderChips();
      };
    });
  };

  document.getElementById("add-member-btn").onclick = async () => {
    const input = document.getElementById("group-member-input");
    const username = input.value.trim();
    const errorEl = document.getElementById("new-chat-error");
    errorEl.textContent = "";
    if (!username) return;
    if (currentUser && username === currentUser.username) {
      errorEl.textContent = "You're already in the group";
      return;
    }
    if (groupMembers.some((m) => m.username === username)) {
      errorEl.textContent = "Already added";
      return;
    }
    try {
      const p = await users.profile(username);
      groupMembers.push({ id: p.id, username: p.username, display_name: p.display_name });
      input.value = "";
      renderChips();
    } catch (err) {
      errorEl.textContent = err.message || "User not found";
    }
  };

  document.getElementById("dialog-overlay").onclick = () => dialog.remove();
  document.getElementById("cancel-chat-btn").onclick = () => dialog.remove();

  document.getElementById("start-chat-btn").onclick = async () => {
    const errorEl = document.getElementById("new-chat-error");
    errorEl.textContent = "";

    try {
      if (mode === "dm") {
        const username = document.getElementById("new-chat-username").value.trim();
        if (!username) { errorEl.textContent = "Enter a username"; return; }
        if (currentUser && username === currentUser.username) {
          errorEl.textContent = "You can't chat with yourself";
          return;
        }
        const profile = await users.profile(username);
        const chat = await messenger.createChat({
          member_ids: [profile.id],
          is_group: false,
        });
        dialog.remove();
        await loadChatList();
        openChat(chat.id);
      } else {
        const name = document.getElementById("group-name").value.trim();
        if (!name) { errorEl.textContent = "Group name required"; return; }
        if (groupMembers.length === 0) {
          errorEl.textContent = "Add at least one member";
          return;
        }
        const chat = await messenger.createChat({
          name,
          is_group: true,
          member_ids: groupMembers.map((m) => m.id),
        });
        dialog.remove();
        await loadChatList();
        openChat(chat.id);
      }
    } catch (err) {
      errorEl.textContent = err.message || "Failed";
    }
  };

  document.getElementById("new-chat-username").onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("start-chat-btn").click();
    }
  };
  document.getElementById("group-member-input").onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("add-member-btn").click();
    }
  };

  document.getElementById("new-chat-username").focus();
}

// ─── Rich text: serialization / rendering ───────────────────────────────────
//
// Messages are stored as JSON on the server and sent over WebSocket as the
// `encrypted_content` field (name is a legacy placeholder — no encryption yet).
//
// Format: JSON array of span objects: [{t: "text", s: style | [styles] | null}]
//   t  — text content (emoji stored as Unicode chars, e.g. "😀")
//   s  — null (plain), string (single style), or array (multiple styles)
//
// Supported styles: "bold", "italic", "rainbow", "wave", "type", "font:Name"
//
// serializeRichText(el)  — DOM → JSON string (called on submit)
// renderRichText(json)   — JSON string → HTML string (called when rendering messages)
// extractPlainText(json) — JSON string → plain text preview (used in sidebar)

function serializeRichText(el) {
  const spans = [];

  function nodeStyle(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    if (node.dataset && node.dataset.style) return node.dataset.style;
    if (node.nodeName === "STRONG" || node.nodeName === "B") return "bold";
    return null;
  }

  function walk(node, inherited) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) {
        const s = inherited.length === 0 ? null
                : inherited.length === 1 ? inherited[0]
                : [...inherited];
        spans.push({ t: node.textContent, s });
      }
    } else if (node.nodeName === "BR") {
      spans.push({ t: "\n", s: null });
    } else if (node.nodeName === "IMG" && node.classList.contains("emoji") && node.alt) {
      // Apple emoji image → serialize as the original Unicode character stored in alt
      const s = inherited.length === 0 ? null
              : inherited.length === 1 ? inherited[0]
              : [...inherited];
      spans.push({ t: node.alt, s });
    } else {
      const s = nodeStyle(node);
      const next = s ? [...inherited, s] : [...inherited];
      node.childNodes.forEach((c) => walk(c, next));
    }
  }

  el.childNodes.forEach((c) => walk(c, []));

  // Merge consecutive unstyled runs
  const merged = [];
  for (const sp of spans) {
    const prev = merged[merged.length - 1];
    if (prev && prev.s === null && sp.s === null) prev.t += sp.t;
    else merged.push({ ...sp });
  }
  return JSON.stringify(merged);
}

function extractPlainText(content) {
  try {
    const parsed = JSON.parse(content);
    if (parsed && !Array.isArray(parsed)) {
      if (parsed._type === "media") return parsed.mime?.startsWith("video/") ? "🎥 Video" : "🖼️ Photo";
      if (parsed._type === "file")  return `📎 ${parsed.name || "File"}`;
      if (parsed._type === "gallery") {
        const count = (parsed.items || []).length;
        const label = `${count} photo${count !== 1 ? "s" : ""}`;
        if (parsed.caption) return `${extractPlainText(parsed.caption)} [${label}]`;
        return label;
      }
    }
    if (Array.isArray(parsed)) return parsed.map((s) => s.t).join("");
  } catch {}
  return content;
}

function renderRichText(content) {
  try {
    const parsed = JSON.parse(content);
    if (parsed && !Array.isArray(parsed)) {
      if (parsed._type === "media")   return renderMediaMessage(parsed);
      if (parsed._type === "gallery") return renderGalleryMessage(parsed);
      if (parsed._type === "file")    return renderFileMessage(parsed);
      return escapeHtml(content);
    }
    if (!Array.isArray(parsed)) return escapeHtml(content);

    // When multiple spans share the 'type' effect, compute a single global
    // ms-per-char so delays continue seamlessly across style boundaries
    // (e.g. a rainbow+type word in the middle of a type-only sentence).
    const typeItems = parsed.filter(({ s }) => {
      const arr = s ? (Array.isArray(s) ? s : [s]) : [];
      return arr.includes("type");
    });
    let globalMsPerChar = null;
    if (typeItems.length > 1) {
      const total = typeItems.reduce((n, { t }) => n + [...t].length, 0);
      globalMsPerChar = Math.min(60, 1800 / Math.max(total, 1));
    }

    let typeOffset = 0;
    return parsed.map(({ t, s }) => {
      if (!s) return escapeHtml(t).replace(/\n/g, "<br>");
      const styles = Array.isArray(s) ? s : [s];
      const hasType = styles.includes("type");
      const html = applyStylesToHtml(t, styles, hasType ? typeOffset : 0, hasType ? globalMsPerChar : null);
      if (hasType) typeOffset += [...t].length;
      return html;
    }).join("");
  } catch {
    return escapeHtml(content);
  }
}

function renderMediaMessage(data) {
  const u    = escapeAttr(data.url);
  const mime = escapeAttr(data.mime || "image/");
  const th   = data.thumb ? escapeAttr(data.thumb) : "";
  const ar   = (data.w && data.h) ? `aspect-ratio:${data.w}/${data.h};` : "";
  const bg   = th ? `background-image:url('${th}');` : "";

  if (data.mime?.startsWith("video/")) {
    if (data.gif_like) {
      return `<div class="msg-media-wrap msg-video-wrap msg-gif-wrap" data-url="${u}" data-mime="${mime}" data-thumb="${th}" style="${ar}">
        <video class="msg-gif-video" src="${escapeAttr(data.url)}" autoplay loop muted playsinline></video>
      </div>`;
    }
    return `<div class="msg-media-wrap msg-video-wrap" data-url="${u}" data-mime="${mime}" data-thumb="${th}" style="${ar}${bg}">
      <div class="msg-video-play">▶</div>
    </div>`;
  }
  // Image / GIF — background thumbnail fades out once real img loads
  return `<div class="msg-media-wrap" data-url="${u}" data-mime="${mime}" data-thumb="${th}" style="${ar}${bg}">
    <img class="msg-media-img" src="${escapeAttr(data.url)}" alt="${escapeAttr(data.name || "")}" loading="lazy"
      onload="this.closest('.msg-media-wrap').classList.add('media-loaded')" />
  </div>`;
}

function renderFileMessage(data) {
  const ext  = (data.name || "file").split(".").pop().toUpperCase().slice(0, 6);
  const size = formatFileSize(data.size);
  return `<a class="msg-file" href="${escapeAttr(data.url)}" download="${escapeAttr(data.name || "file")}" target="_blank">
    <div class="msg-file-icon">${escapeHtml(ext)}</div>
    <div class="msg-file-info">
      <div class="msg-file-name">${escapeHtml(data.name || "file")}</div>
      <div class="msg-file-size">${size}</div>
    </div>
    <div class="msg-file-dl">↓</div>
  </a>`;
}

// DP layout: group items into rows so each row height stays near TARGET_H.
// Returns [{height, items, ars}] — one entry per row.
function computeGalleryLayout(items, totalWidth) {
  const GAP     = 3;
  const TARGET  = 170;
  const MIN_H   = 60;
  const MAX_H   = 280;
  const MAX_ROW = 4;
  const n = items.length;

  const ars = items.map(it => (it.w > 0 && it.h > 0) ? it.w / it.h : 1);

  const INF  = 1e18;
  const dp   = new Float64Array(n + 1).fill(INF);
  const from = new Int32Array(n + 1);
  dp[0] = 0;

  for (let i = 0; i < n; i++) {
    if (dp[i] >= INF) continue;
    let sumAr = 0;
    for (let k = 1; k <= MAX_ROW && i + k <= n; k++) {
      sumAr += ars[i + k - 1];
      const avail  = totalWidth - (k - 1) * GAP;
      const idealH = avail / sumAr;
      if (idealH < MIN_H) break;               // too many items → too short
      const h     = Math.min(MAX_H, idealH);
      const cost  = dp[i] + (h !== idealH ? 1e6 : 0) + Math.abs(h - TARGET);
      if (cost < dp[i + k]) { dp[i + k] = cost; from[i + k] = i; }
    }
  }

  // Reconstruct row boundaries
  const breaks = [];
  for (let j = n; j > 0; j = from[j]) breaks.unshift(from[j]);
  breaks.push(n);

  return breaks.slice(0, -1).map((start, ri) => {
    const end    = breaks[ri + 1];
    const slice  = items.slice(start, end);
    const arSlice = ars.slice(start, end);
    const sumAr  = arSlice.reduce((s, a) => s + a, 0);
    const avail  = totalWidth - (slice.length - 1) * GAP;
    const h      = Math.min(MAX_H, Math.max(MIN_H, avail / sumAr));
    return { height: Math.round(h), items: slice, ars: arSlice };
  });
}

function renderGalleryMessage(data) {
  const items = data.items || [];
  if (!items.length) return "";

  const captionHtml = data.caption
    ? `<div class="msg-gallery-caption">${renderRichText(data.caption)}</div>`
    : "";

  if (items.length === 1) return renderMediaMessage(items[0]) + captionHtml;

  const TOTAL_W = 334;
  const layout  = computeGalleryLayout(items, TOTAL_W);

  const rowsHtml = layout.map(({ height, items: row, ars }) =>
    `<div class="gallery-row" style="height:${height}px">${
      row.map((item, i) => {
        const u    = escapeAttr(item.url);
        const mime = escapeAttr(item.mime || "image/");
        const th   = item.thumb ? escapeAttr(item.thumb) : "";
        const bg   = th ? `background-image:url('${th}');` : "";
        const ar   = ars[i].toFixed(4);

        if (item.mime?.startsWith("video/")) {
          if (item.gif_like) {
            return `<div class="gallery-tile" data-url="${u}" data-mime="${mime}" data-thumb="${th}" style="flex:${ar};${bg}">
              <video class="gallery-tile-img" src="${u}" autoplay loop muted playsinline
                onloadeddata="this.closest('.gallery-tile').classList.add('media-loaded')"></video>
            </div>`;
          }
          return `<div class="gallery-tile gallery-tile-video" data-url="${u}" data-mime="${mime}" data-thumb="${th}" style="flex:${ar};${bg}">
            <div class="msg-video-play">▶</div>
          </div>`;
        }
        return `<div class="gallery-tile" data-url="${u}" data-mime="${mime}" data-thumb="${th}" style="flex:${ar};${bg}">
          <img class="gallery-tile-img" src="${u}" alt="${escapeAttr(item.name || "")}" loading="lazy"
            onload="this.closest('.gallery-tile').classList.add('media-loaded')" />
        </div>`;
      }).join("")
    }</div>`
  ).join("");

  return `<div class="msg-gallery">${rowsHtml}</div>${captionHtml}`;
}

function formatFileSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024)             return `${bytes} B`;
  if (bytes < 1024 * 1024)      return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function applyStylesToHtml(text, styles, typeOffset = 0, msPerChar = null) {
  const hasWave    = styles.includes("wave");
  const hasRainbow = styles.includes("rainbow");
  const hasType    = styles.includes("type");

  // Collect text-decoration for injection into inline-block chars
  const decs = [];
  if (styles.includes("underline")) decs.push("underline");
  if (styles.includes("strike"))    decs.push("line-through");
  const decStyle = decs.length ? `text-decoration:${decs.join(" ")};` : "";

  // Build per-char animated content
  let html;
  if (hasWave && hasRainbow && hasType) {
    html = `<span class="text-wave-rainbow-type">${renderWaveRainbowTypeChars(text, decStyle, typeOffset, msPerChar)}</span>`;
  } else if (hasWave && hasRainbow) {
    html = `<span class="text-wave-rainbow">${renderWaveRainbowChars(text, decStyle)}</span>`;
  } else if (hasWave && hasType) {
    html = `<span class="text-wave-type">${renderWaveTypeChars(text, decStyle, typeOffset, msPerChar)}</span>`;
  } else if (hasRainbow && hasType) {
    html = `<span class="text-rainbow-type">${renderRainbowTypeChars(text, decStyle, typeOffset, msPerChar)}</span>`;
  } else if (hasWave) {
    html = `<span class="text-wave">${renderWaveChars(text, decStyle)}</span>`;
  } else if (hasRainbow) {
    html = `<span class="text-rainbow">${renderRainbowChars(text, decStyle)}</span>`;
  } else if (hasType) {
    html = renderTypeChars(text, decStyle, typeOffset, msPerChar);
  } else {
    html = escapeHtml(text).replace(/\n/g, "<br>");
  }

  // For non-animated text, wrap underline/strike normally
  if (!hasWave && !hasRainbow && !hasType) {
    if (styles.includes("underline")) html = `<span style="text-decoration:underline">${html}</span>`;
    if (styles.includes("strike"))    html = `<s>${html}</s>`;
  }

  // Wrap remaining styles — deduplicate by category
  const seenCats = new Set();
  for (const s of styles) {
    if (s === "wave" || s === "rainbow" || s === "type") continue;
    if (s === "underline" || s === "strike") continue; // handled above
    if (s === "bold") { html = `<strong>${html}</strong>`; continue; }
    if (s === "mono") { html = `<code class="text-mono">${html}</code>`; continue; }
    if (s.startsWith("color:")) {
      if (seenCats.has("color")) continue;
      seenCats.add("color");
      html = `<span style="color:${escapeAttr(s.slice(6))}">${html}</span>`; continue;
    }
    if (s.startsWith("font:")) {
      if (seenCats.has("font")) continue;
      seenCats.add("font");
      const font = s.slice(5);
      loadGoogleFont(font);
      html = `<span style="font-family:'${escapeAttr(font)}',sans-serif">${html}</span>`; continue;
    }
    if (s.startsWith("size:")) {
      if (seenCats.has("size")) continue;
      seenCats.add("size");
      const sz = { sm: "0.8em", lg: "1.3em", xl: "1.85em", xxl: "2.5em" }[s.slice(5)];
      if (sz) html = `<span style="font-size:${sz};line-height:1.2">${html}</span>`;
    }
  }
  return html;
}

function renderWaveChars(text, extraStyle = "") {
  return [...text]
    .map((ch, i) =>
      ch === " " ? " "
        : `<span style="--i:${i};${extraStyle}">${escapeHtml(ch)}</span>`
    ).join("");
}

function renderRainbowChars(text, extraStyle = "") {
  return [...text]
    .map((ch, i) =>
      ch === " " ? " "
        : `<span style="--i:${i};${extraStyle}">${escapeHtml(ch)}</span>`
    ).join("");
}

function renderTypeChars(text, extraStyle = "", startIdx = 0, msPerChar = null) {
  const chars = [...text];
  const delay = msPerChar ?? Math.min(60, 1800 / Math.max(chars.length, 1));
  return chars
    .map((ch, i) =>
      `<span class="type-char" style="animation-delay:${Math.round((startIdx + i) * delay)}ms;${extraStyle}">${escapeHtml(ch)}</span>`
    ).join("");
}

function renderWaveRainbowChars(text, extraStyle = "") {
  return [...text]
    .map((ch, i) =>
      ch === " " ? " "
        : `<span style="--i:${i};${extraStyle}">${escapeHtml(ch)}</span>`
    ).join("");
}

function renderWaveTypeChars(text, extraStyle = "", startIdx = 0, msPerChar = null) {
  const chars = [...text];
  const delay = msPerChar ?? Math.min(60, 1800 / Math.max(chars.length, 1));
  return chars
    .map((ch, i) =>
      ch === " " ? " "
        : `<span style="--i:${i};--type-delay:${Math.round((startIdx + i) * delay)}ms;${extraStyle}">${escapeHtml(ch)}</span>`
    ).join("");
}

function renderRainbowTypeChars(text, extraStyle = "", startIdx = 0, msPerChar = null) {
  const chars = [...text];
  const delay = msPerChar ?? Math.min(60, 1800 / Math.max(chars.length, 1));
  return chars
    .map((ch, i) =>
      ch === " " ? " "
        : `<span style="--i:${i};--type-delay:${Math.round((startIdx + i) * delay)}ms;${extraStyle}">${escapeHtml(ch)}</span>`
    ).join("");
}

function renderWaveRainbowTypeChars(text, extraStyle = "", startIdx = 0, msPerChar = null) {
  const chars = [...text];
  const delay = msPerChar ?? Math.min(60, 1800 / Math.max(chars.length, 1));
  return chars
    .map((ch, i) =>
      ch === " " ? " "
        : `<span style="--i:${i};--type-delay:${Math.round((startIdx + i) * delay)}ms;${extraStyle}">${escapeHtml(ch)}</span>`
    ).join("");
}

// ─── Google Fonts list ───

const GOOGLE_FONTS = [
  "Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Nunito", "Poppins",
  "Raleway", "Source Sans Pro", "Work Sans", "Oswald", "Exo 2", "Fira Sans",
  "Josefin Sans", "Quicksand", "Varela Round",
  "Merriweather", "Playfair Display", "Libre Baskerville", "EB Garamond",
  "Cormorant Garamond", "Lora", "Crimson Text",
  "Pacifico", "Lobster", "Dancing Script", "Sacramento", "Caveat",
  "Satisfy", "Indie Flower", "Permanent Marker", "Shadows Into Light",
  "Architects Daughter", "Amatic SC", "Comfortaa",
  "Bebas Neue", "Righteous", "Russo One", "Staatliches", "Teko",
  "Cinzel", "Uncial Antiqua", "MedievalSharp", "Pirata One",
  "Source Code Pro", "Fira Code", "Inconsolata", "Space Mono",
  "VT323", "Press Start 2P", "Bungee", "Orbitron",
];

function loadGoogleFont(name) {
  const id = `gf-${name.replace(/\s+/g, "-")}`;
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}&display=swap`;
  document.head.appendChild(link);
}

// ─── Format menu ───

const COLOR_PALETTE = [
  "#ef4444","#f97316","#f59e0b","#eab308","#84cc16",
  "#22c55e","#10b981","#06b6d4","#3b82f6","#6366f1",
  "#8b5cf6","#ec4899","#ffffff","#d1d5db","#9ca3af",
  "#6b7280","#374151","#1f2937","#000000","custom",
];

let _pendingColorRange = null;

function initFormatMenu() {
  if (document.getElementById("fmt-menu")) return;

  // ── Main bar ──
  const menu = document.createElement("div");
  menu.id = "fmt-menu";
  menu.className = "fmt-menu";
  menu.style.display = "none";
  menu.innerHTML = `
    <button class="fmt-btn" data-fmt="bold"      title="Bold"><b>B</b></button>
    <button class="fmt-btn" data-fmt="underline"  title="Underline"><u>U</u></button>
    <button class="fmt-btn" data-fmt="strike"     title="Strikethrough"><s>S</s></button>
    <button class="fmt-btn" data-fmt="mono"       title="Monospace">{ }</button>
    <span class="fmt-sep"></span>
    <button class="fmt-btn" data-fmt="rainbow"    title="Rainbow">🌈</button>
    <button class="fmt-btn" data-fmt="wave"       title="Wave">〰</button>
    <button class="fmt-btn" data-fmt="type"       title="Typewriter">⌨</button>
    <span class="fmt-sep"></span>
    <button class="fmt-btn fmt-toggle" data-panel="color" title="Color">●</button>
    <button class="fmt-btn fmt-toggle" data-panel="font"  title="Font & Size">Aa</button>
    <span class="fmt-sep"></span>
    <button class="fmt-btn" data-fmt="clear"      title="Clear styles">✕</button>
  `;
  document.body.appendChild(menu);

  // ── Sub-panel ──
  const panel = document.createElement("div");
  panel.id = "fmt-subpanel";
  panel.className = "fmt-subpanel";
  panel.style.display = "none";
  document.body.appendChild(panel);

  // ── Hidden native color input ──
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.id = "custom-color-input";
  colorInput.style.cssText = "position:fixed;opacity:0;width:0;height:0;pointer-events:none";
  document.body.appendChild(colorInput);

  colorInput.addEventListener("change", () => {
    if (_pendingColorRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(_pendingColorRange);
      _pendingColorRange = null;
    }
    applyFormat("color:" + colorInput.value);
  });

  // Prevent ALL clicks on menu/panel from stealing selection
  [menu, panel].forEach((el) =>
    el.addEventListener("mousedown", (e) => e.preventDefault())
  );

  menu.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-fmt],[data-panel]");
    if (!btn) return;

    if (btn.dataset.panel) {
      const alreadyOpen = panel.dataset.activePanel === btn.dataset.panel
        && panel.style.display !== "none";
      hideSubPanel();
      if (!alreadyOpen) openSubPanel(btn.dataset.panel);
      return;
    }
    hideSubPanel();
    applyFormat(btn.dataset.fmt);
  });

  panel.addEventListener("click", (e) => {
    // Color swatch
    const swatch = e.target.closest("[data-color]");
    if (swatch) {
      const color = swatch.dataset.color;
      if (color === "custom") {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) _pendingColorRange = sel.getRangeAt(0).cloneRange();
        hideSubPanel();
        colorInput.click();
      } else {
        applyFormat("color:" + color);
        hideSubPanel();
      }
      return;
    }
    // Font pick
    const fontItem = e.target.closest("[data-font]");
    if (fontItem) {
      applyFormat("font:" + fontItem.dataset.font);
      hideSubPanel();
      return;
    }
    // Size
    const sizeBtn = e.target.closest("[data-size]");
    if (sizeBtn) {
      applyFormat("size:" + sizeBtn.dataset.size);
      hideSubPanel();
    }
  });

  // Font search filter
  panel.addEventListener("input", (e) => {
    if (e.target.id !== "font-search") return;
    const q = e.target.value.toLowerCase();
    panel.querySelectorAll("[data-font]").forEach((el) => {
      el.style.display = el.dataset.font.toLowerCase().includes(q) ? "" : "none";
    });
  });

  // Position menu on selection change
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    const inputEl = document.getElementById("chat-input");
    if (!inputEl || !sel || sel.isCollapsed || !sel.rangeCount) {
      hideFmtMenu();
      return;
    }
    try {
      const range = sel.getRangeAt(0);
      if (!inputEl.contains(range.commonAncestorContainer)) { hideFmtMenu(); return; }
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) { hideFmtMenu(); return; }
      positionMenu(menu, rect);
      menu.style.display = "flex";
    } catch {
      hideFmtMenu();
    }
  });
}

function positionMenu(menu, anchorRect) {
  const mw = menu.offsetWidth || 320;
  const left = Math.max(8, Math.min(
    anchorRect.left + anchorRect.width / 2 - mw / 2,
    window.innerWidth - mw - 8
  ));
  menu.style.left = `${left}px`;
  menu.style.top  = `${anchorRect.top - 52 + window.scrollY}px`;
}

function openSubPanel(type) {
  const menu = document.getElementById("fmt-menu");
  const panel = document.getElementById("fmt-subpanel");
  if (!panel || !menu) return;

  if (type === "color") {
    panel.innerHTML = `
      <div class="subpanel-title">Color</div>
      <div class="color-grid">
        ${COLOR_PALETTE.map((c) =>
          c === "custom"
            ? `<button class="color-swatch color-custom" data-color="custom" title="Custom">🎨</button>`
            : `<button class="color-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`
        ).join("")}
      </div>
    `;
  } else if (type === "font") {
    panel.innerHTML = `
      <div class="subpanel-title">Size</div>
      <div class="size-row">
        <button class="fmt-btn size-btn" data-size="sm"  title="Small · 0.8em">S</button>
        <button class="fmt-btn size-btn" data-size="lg"  title="Large · 1.3em">L</button>
        <button class="fmt-btn size-btn" data-size="xl"  title="X-Large · 1.85em">XL</button>
        <button class="fmt-btn size-btn" data-size="xxl" title="Huge · 2.5em">XXL</button>
      </div>
      <div class="subpanel-title" style="margin-top:10px">Font</div>
      <input id="font-search" class="font-search" placeholder="Search fonts..." />
      <div class="font-list" id="font-list-scroller">
        ${GOOGLE_FONTS.map((f) =>
          `<div class="font-item" data-font="${escapeAttr(f)}" style="font-family:'${escapeAttr(f)}',sans-serif">${escapeHtml(f)}</div>`
        ).join("")}
      </div>
    `;
  }

  panel.dataset.activePanel = type;
  panel.style.display = "block";

  // Lazy-load Google Fonts when items scroll into view
  if (type === "font") {
    const scroller = panel.querySelector("#font-list-scroller");
    if (scroller && "IntersectionObserver" in window) {
      const obs = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            loadGoogleFont(e.target.dataset.font);
            obs.unobserve(e.target);
          }
        });
      }, { root: scroller, rootMargin: "80px" });
      scroller.querySelectorAll("[data-font]").forEach((el) => obs.observe(el));
    }
  }

  // Position above the format bar
  const mr = menu.getBoundingClientRect();
  const ph = panel.offsetHeight;
  const pw = panel.offsetWidth || 240;
  const left = Math.max(8, Math.min(mr.left, window.innerWidth - pw - 8));
  panel.style.left = `${left}px`;
  panel.style.top  = `${mr.top - ph - 6 + window.scrollY}px`;
}

function hideSubPanel() {
  const panel = document.getElementById("fmt-subpanel");
  if (panel) { panel.style.display = "none"; panel.dataset.activePanel = ""; }
}

function hideFmtMenu() {
  hideSubPanel();
  const menu = document.getElementById("fmt-menu");
  if (menu) menu.style.display = "none";
}

// Splits `parent` around `child` so that `child` ends up at `parent`'s level.
// Siblings before child are kept in a cloned parent inserted before child;
// siblings after child are kept in a cloned parent inserted after child.
function splitParentAroundChild(parent, child) {
  const gp = parent.parentNode;
  const before = [];
  const after  = [];
  let cur = parent.firstChild;
  while (cur && cur !== child) { before.push(cur); cur = cur.nextSibling; }
  cur = child.nextSibling;
  while (cur) { after.push(cur); cur = cur.nextSibling; }
  if (before.length) {
    const bClone = parent.cloneNode(false);
    before.forEach(c => bClone.appendChild(c));
    gp.insertBefore(bClone, parent);
  }
  gp.insertBefore(child, parent);
  if (after.length) {
    const aClone = parent.cloneNode(false);
    after.forEach(c => aClone.appendChild(c));
    gp.insertBefore(aClone, parent);
  }
  gp.removeChild(parent);
}

function applyFormat(fmt) {
  const inputEl = document.getElementById("chat-input");

  if (fmt === "clear") {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString();
    if (!text) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    // Lift the bare text node out of ALL ancestor formatting spans
    let par = textNode.parentNode;
    while (par && par !== inputEl) {
      splitParentAroundChild(par, textNode);
      par = textNode.parentNode;
    }
    inputEl?.querySelectorAll("span:empty,strong:empty,b:empty,s:empty,code:empty")
      .forEach(n => n.remove());
    const newRange = document.createRange();
    newRange.setStartAfter(textNode);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
    hideFmtMenu();
    inputEl?.focus();
    return;
  }

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const selectedText = sel.toString();
  if (!selectedText) return;
  const range = sel.getRangeAt(0);

  let node;
  if (fmt === "bold") {
    node = document.createElement("strong");
    node.dataset.style = "bold";
    node.style.fontWeight = "bold";
  } else {
    node = document.createElement("span");
    node.dataset.style = fmt;
  }
  // Composer preview
  if (fmt === "underline") node.style.textDecoration = "underline";
  else if (fmt === "strike") node.style.textDecoration = "line-through";
  else if (fmt === "mono") { node.style.fontFamily = "monospace"; node.style.fontSize = "0.9em"; }
  else if (fmt === "rainbow") {
    node.classList.add("text-rainbow");
    node.style.backgroundImage = "linear-gradient(90deg,#ff4444,#ff9900,#44cc44,#22aaff,#8844ff,#ff44bb)";
    node.style.webkitBackgroundClip = "text";
    node.style.backgroundClip = "text";
    node.style.webkitTextFillColor = "transparent";
  }
  else if (fmt === "wave") { node.style.color = "var(--accent)"; node.style.borderBottom = "2px dotted var(--accent)"; }
  else if (fmt === "type") node.style.borderBottom = "1px dashed var(--text-muted)";
  else if (fmt.startsWith("color:")) node.style.color = fmt.slice(6);
  else if (fmt.startsWith("font:")) {
    const font = fmt.slice(5);
    loadGoogleFont(font);
    node.style.fontFamily = `'${font}', sans-serif`;
  }
  else if (fmt.startsWith("size:")) {
    const sizes = { sm: "0.8em", lg: "1.3em", xl: "1.85em", xxl: "2.5em" };
    node.style.fontSize = sizes[fmt.slice(5)] || "1em";
  }

  // extractContents preserves inner HTML (nested colors, bold, etc.)
  const fragment = range.extractContents();
  node.appendChild(fragment);
  range.insertNode(node);

  // For size: lift the new node out of any ancestor size spans to prevent nesting.
  // insertNode places the node inside whatever span the cursor was already in.
  if (fmt.startsWith("size:")) {
    let par = node.parentNode;
    while (par && par !== inputEl) {
      if (par.dataset?.style?.startsWith("size:")) {
        splitParentAroundChild(par, node);
        par = node.parentNode;
      } else {
        par = par.parentNode;
      }
    }
    inputEl?.querySelectorAll('[data-style^="size:"]:empty').forEach(s => s.remove());
  }

  range.setStartAfter(node);
  range.setEndAfter(node);
  sel.removeAllRanges();
  sel.addRange(range);

  hideFmtMenu();
  inputEl?.focus();
}

// ─── Lightbox / media gallery ───

let lbItems = [];
let lbIndex = 0;

function initLightbox() {
  if (document.getElementById("lightbox")) return;
  const lb = document.createElement("div");
  lb.id = "lightbox";
  lb.className = "lightbox";
  lb.innerHTML = `
    <div class="lb-backdrop"></div>
    <button class="lb-close" title="Close">×</button>
    <button class="lb-nav lb-prev" title="Previous">‹</button>
    <div class="lb-stage" id="lb-stage"></div>
    <button class="lb-nav lb-next" title="Next">›</button>
    <div class="lb-counter" id="lb-counter"></div>
  `;
  document.body.appendChild(lb);

  lb.querySelector(".lb-backdrop").onclick = closeLightbox;
  lb.querySelector(".lb-close").onclick    = closeLightbox;
  lb.querySelector(".lb-prev").onclick = () => navigateLightbox(-1);
  lb.querySelector(".lb-next").onclick = () => navigateLightbox(+1);

  document.addEventListener("keydown", (e) => {
    if (!document.getElementById("lightbox")?.classList.contains("lb-open")) return;
    if (e.key === "Escape")      closeLightbox();
    if (e.key === "ArrowLeft")   navigateLightbox(-1);
    if (e.key === "ArrowRight")  navigateLightbox(+1);
  });
}

function openLightbox(wrapEl) {
  const all = Array.from(document.querySelectorAll("#chat-messages .msg-media-wrap[data-url]"));
  lbItems = all.map((el) => ({ url: el.dataset.url, mime: el.dataset.mime || "image/", thumb: el.dataset.thumb || "" }));
  lbIndex = Math.max(0, all.indexOf(wrapEl));
  const lb = document.getElementById("lightbox");
  lb.classList.add("lb-open");
  document.body.style.overflow = "hidden";
  renderLbItem();
}

function openGalleryLightbox(tileEl) {
  const galleryEl = tileEl.closest(".msg-gallery");
  const all = Array.from(galleryEl.querySelectorAll(".gallery-tile[data-url]"));
  lbItems = all.map(el => ({ url: el.dataset.url, mime: el.dataset.mime || "image/", thumb: el.dataset.thumb || "" }));
  lbIndex = Math.max(0, all.indexOf(tileEl));
  const lb = document.getElementById("lightbox");
  lb.classList.add("lb-open");
  document.body.style.overflow = "hidden";
  renderLbItem();
}

function closeLightbox() {
  const lb = document.getElementById("lightbox");
  lb?.classList.remove("lb-open");
  lb?.querySelector("video")?.pause();
  document.body.style.overflow = "";
}

function navigateLightbox(dir) {
  if (!lbItems.length) return;
  document.getElementById("lightbox")?.querySelector("video")?.pause();
  lbIndex = (lbIndex + dir + lbItems.length) % lbItems.length;
  renderLbItem();
}

function renderLbItem() {
  const stage   = document.getElementById("lb-stage");
  const counter = document.getElementById("lb-counter");
  if (!stage || !lbItems.length) return;

  const item = lbItems[lbIndex];
  const lb   = document.getElementById("lightbox");

  if (item.mime.startsWith("video/")) {
    stage.innerHTML = `<video class="lb-video" src="${escapeAttr(item.url)}" controls autoplay playsinline></video>`;
  } else {
    stage.innerHTML = `
      ${item.thumb ? `<img class="lb-img-placeholder" src="${escapeAttr(item.thumb)}" alt="" />` : ""}
      <img class="lb-img" src="${escapeAttr(item.url)}" alt=""
        onload="this.previousElementSibling && this.previousElementSibling.remove()" />`;
  }

  counter.textContent = lbItems.length > 1 ? `${lbIndex + 1} / ${lbItems.length}` : "";
  const multi = lbItems.length > 1;
  lb.querySelector(".lb-prev").style.display = multi ? "" : "none";
  lb.querySelector(".lb-next").style.display = multi ? "" : "none";
}

// ─── Message context menu ───

function initMessageContextMenu() {
  if (document.getElementById("msg-ctx-menu")) return;
  const menu = document.createElement("div");
  menu.id = "msg-ctx-menu";
  menu.className = "msg-ctx-menu";
  menu.style.display = "none";
  document.body.appendChild(menu);

  document.addEventListener("click", () => { menu.style.display = "none"; });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") menu.style.display = "none";
  });
  menu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-action]");
    if (!item) return;
    menu.style.display = "none";
    const { action, msgId } = item.dataset;
    if (action === "delete") {
      sendWs({ type: "delete_message", chat_id: currentChatId, message_id: msgId });
    } else if (action === "copy") {
      const textEl = document.querySelector(`[data-message-id="${msgId}"] .message-text`);
      if (textEl) navigator.clipboard.writeText(textEl.textContent).catch(() => {});
    }
  });
}

function showMsgCtxMenu(x, y, msgId, isMe) {
  const menu = document.getElementById("msg-ctx-menu");
  if (!menu) return;
  menu.innerHTML = `
    <div class="ctx-item" data-action="copy" data-msg-id="${escapeAttr(msgId)}">Copy text</div>
    ${isMe ? `<div class="ctx-item ctx-danger" data-action="delete" data-msg-id="${escapeAttr(msgId)}">Delete for everyone</div>` : ""}
  `;
  menu.style.display = "block";
  const mw = menu.offsetWidth || 180;
  const mh = menu.offsetHeight || 70;
  menu.style.left = `${Math.min(x, window.innerWidth  - mw - 8)}px`;
  menu.style.top  = `${Math.min(y + window.scrollY, window.scrollY + window.innerHeight - mh - 8)}px`;
}

// ─── Media attachment helpers ───

function clearPendingAttachments() {
  pendingAttachments.forEach((a) => { if (a.objectUrl) URL.revokeObjectURL(a.objectUrl); });
  pendingAttachments = [];
  const tray = document.getElementById("pending-tray");
  if (tray) { tray.style.display = "none"; tray.innerHTML = ""; }
}

async function addMediaAttachment(file) {
  const objectUrl = URL.createObjectURL(file);
  let thumb = null, w = 0, h = 0;
  let gifLike = false;
  if (file.type.startsWith("video/")) {
    const r = await generateVideoThumbnail(file);
    thumb = r.thumb; w = r.w; h = r.h;
    if (file.size < 5 * 1024 * 1024) gifLike = await isVideoSilent(file);
  } else if (file.type.startsWith("image/")) {
    thumb = await generateThumbnail(file, 80);
    const d = await getImageDimensions(file);
    w = d.w; h = d.h;
  }
  pendingAttachments.push({ kind: "media", file, thumb, objectUrl, w, h, gifLike });
  renderPendingTray();
}

function addFileAttachment(file) {
  pendingAttachments.push({ kind: "file", file, thumb: null, objectUrl: null });
  renderPendingTray();
}

function renderPendingTray() {
  const tray = document.getElementById("pending-tray");
  if (!tray) return;
  if (pendingAttachments.length === 0) { tray.style.display = "none"; tray.innerHTML = ""; return; }
  tray.style.display = "flex";
  tray.innerHTML = pendingAttachments.map((att, i) => {
    if (att.kind === "media") {
      const preview = att.thumb
        ? `<img class="pending-thumb-img" src="${att.thumb}" alt="" />`
        : `<div class="pending-thumb-icon">${att.file.type.startsWith("video/") ? "🎥" : "🖼️"}</div>`;
      return `<div class="pending-att" data-idx="${i}">${preview}<button class="pending-remove" data-idx="${i}">×</button></div>`;
    }
    return `<div class="pending-att pending-att-file" data-idx="${i}">
      <div class="pending-att-name">${escapeHtml(att.file.name)}</div>
      <div class="pending-att-size">${formatFileSize(att.file.size)}</div>
      <button class="pending-remove" data-idx="${i}">×</button>
    </div>`;
  }).join("");
  tray.querySelectorAll(".pending-remove").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.idx);
      if (pendingAttachments[idx]?.objectUrl) URL.revokeObjectURL(pendingAttachments[idx].objectUrl);
      pendingAttachments.splice(idx, 1);
      renderPendingTray();
    };
  });
}

async function uploadAndSendAttachment(att, chatId) {
  try {
    let uploadFile = att.file;
    if (att.kind === "media" && att.file.type.startsWith("image/")) {
      uploadFile = await compressImage(att.file);
    }
    const results = await media.upload([uploadFile]);
    if (!results?.[0]) throw new Error("Upload failed");
    const { url } = results[0];

    const payload = att.kind === "media"
      ? JSON.stringify({ _type: "media", url, thumb: att.thumb, mime: att.file.type, name: att.file.name, size: uploadFile.size, w: att.w || 0, h: att.h || 0, gif_like: att.gifLike || false })
      : JSON.stringify({ _type: "file",  url, name: att.file.name, size: att.file.size, mime: att.file.type });

    sendWs({ type: "send_message", chat_id: chatId, encrypted_content: payload, nonce: "media-nonce", message_type: att.kind });
  } catch (err) {
    toast(`Upload failed: ${err.message || "unknown error"}`);
  }
}

async function uploadAndSendGallery(mediaAtts, captionJson, chatId) {
  try {
    // Upload all media in parallel
    const items = await Promise.all(mediaAtts.map(async (att) => {
      let uploadFile = att.file;
      if (att.file.type.startsWith("image/")) uploadFile = await compressImage(att.file);
      const results = await media.upload([uploadFile]);
      if (!results?.[0]) throw new Error("Upload failed");
      return {
        url:      results[0].url,
        thumb:    att.thumb,
        mime:     att.file.type,
        name:     att.file.name,
        size:     uploadFile.size,
        w:        att.w      || 0,
        h:        att.h      || 0,
        gif_like: att.gifLike || false,
      };
    }));
    const payload = JSON.stringify({ _type: "gallery", items, caption: captionJson ?? null });
    sendWs({ type: "send_message", chat_id: chatId, encrypted_content: payload, nonce: "gallery-" + Date.now(), message_type: "media" });
  } catch (err) {
    toast(`Upload failed: ${err.message || "unknown error"}`);
  }
}

async function compressImage(file, maxDim = 1920, quality = 0.92) {
  if (file.type === "image/gif" || file.size <= 5 * 1024 * 1024) return file;
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(maxDim / img.naturalWidth, maxDim / img.naturalHeight, 1);
      const w = Math.round(img.naturalWidth  * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => resolve(blob || file), "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

async function generateThumbnail(file, size = 80) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
      const w = Math.round(img.naturalWidth  * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.5));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

async function isVideoSilent(file) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try {
      decoded = await audioCtx.decodeAudioData(arrayBuffer);
    } catch {
      audioCtx.close();
      return true; // нет аудиодорожки или не декодируется → тихое
    }
    audioCtx.close();
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < data.length; i += 256) {
        if (Math.abs(data[i]) > 0.001) return false; // есть реальный звук
      }
    }
    return true;
  } catch {
    return true;
  }
}

async function generateVideoThumbnail(file) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);

    const capture = () => {
      const vw = video.videoWidth  || 160;
      const vh = video.videoHeight || 90;
      const scale = Math.min(320 / vw, 320 / vh, 1);
      const tw = Math.round(vw * scale);
      const th = Math.round(vh * scale);
      const canvas = document.createElement("canvas");
      canvas.width = tw; canvas.height = th;
      canvas.getContext("2d").drawImage(video, 0, 0, tw, th);
      URL.revokeObjectURL(url);
      resolve({ thumb: canvas.toDataURL("image/jpeg", 0.7), w: vw, h: vh });
    };

    video.addEventListener("seeked", capture, { once: true });
    video.onerror = () => { URL.revokeObjectURL(url); resolve({ thumb: null, w: 0, h: 0 }); };
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = url;
    video.addEventListener("loadedmetadata", () => { video.currentTime = 0.1; }, { once: true });
  });
}

async function getImageDimensions(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ w: 0, h: 0 }); };
    img.src = url;
  });
}

// ─── DOM / string helpers ─────────────────────────────────────────────────────

function escapeHtml(str) {
  if (str == null) return "";
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

function escapeAttr(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toast(msg) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("toast-fade"), 2000);
  setTimeout(() => el.remove(), 2800);
}

// ─── Emoji system ───────────────────────────────────────────────────────────
//
// ARCHITECTURE OVERVIEW
// ─────────────────────
// DATA LAYER (static, populated at module load)
//   _EMOJI_RAW           Master list: [emoji, name, category_idx, shortcode?]
//                        category_idx: 0=Smileys 1=People 2=Animals 3=Food
//                                      4=Travel 5=Activities 6=Objects 7=Symbols
//   EMOJI_CATEGORIES     Built from _EMOJI_RAW: [{name, icon, emojis[]}]
//   EMOJI_SHORTCODE_MAP  { "smile": "😊", ... } for :shortcode: → emoji lookup
//   _EMOJI_SEARCH        Flat [{e, n}] array used by the search input
//
// RENDERING HELPERS (pure functions, no side effects)
//   _initEmojiRegex()          Lazy-builds codepoint cache + regex from _EMOJI_RAW
//   _makeEmojiImg(emoji)   →   <img> DOM element ready for insertion
//   _emojiImgHtml(emoji)   →   HTML string version (for innerHTML generation)
//   _applyEmojiDirect(el)      Walks text nodes, replaces emoji chars with <img>
//   applyAppleEmoji(el)        Twemoji.parse wrapper — used only for the input
//                              field where it runs alongside cursor preservation
//
// CHAT INPUT FIELD
//   _emojiInsert(emoji)            Insert Apple <img> at the current cursor position
//   tryEmojiShortcode(el)          On each keystroke: detect ":name:" → emoji
//   undoEmojiConversion()          Backspace immediately after shortcode conversion
//   _saveCursorOffset(root)        Save cursor position as a logical char offset
//   _restoreCursorOffset(root, n)  Restore cursor after DOM has been rewritten
//   _applyEmojiToInputSafe(el)     applyAppleEmoji with cursor preservation
//
// PICKER UI (created once, reused)
//   initEmojiPicker()            Build hover popup + docked panel; bind events
//   setupEmojiBtn()              Wire the emoji button for the current chat view
//   _setupGlobalEmojiObserver()  MutationObserver — auto-replaces emoji in any
//                                new DOM content site-wide (messages, previews, etc.)
// ────────────────────────────────────────────────────────────────────────────

// [emoji, name, category_idx, shortcode?]
const _EMOJI_RAW = [
  // ── Smileys & Emotion ──
  ["😀","grinning face",0,"grinning"],["😃","grinning face with big eyes",0,"smiley"],
  ["😄","grinning face with smiling eyes",0,"smile"],["😁","beaming face with smiling eyes",0,"grin"],
  ["😆","grinning squinting face",0,"laughing"],["😅","grinning face with sweat",0,"sweat_smile"],
  ["🤣","rolling on the floor laughing",0,"rofl"],["😂","face with tears of joy",0,"joy"],
  ["🙂","slightly smiling face",0,"slightly_smiling_face"],["🙃","upside-down face",0,"upside_down_face"],
  ["😉","winking face",0,"wink"],["😊","smiling face with smiling eyes",0,"blush"],
  ["😇","smiling face with halo",0,"innocent"],["🥰","smiling face with hearts",0,"smiling_face_with_three_hearts"],
  ["😍","smiling face with heart-eyes",0,"heart_eyes"],["🤩","star-struck",0,"star_struck"],
  ["😘","face blowing a kiss",0,"kissing_heart"],["😗","kissing face",0,"kissing"],
  ["😚","kissing face with closed eyes",0,"kissing_closed_eyes"],["😙","kissing face with smiling eyes",0,"kissing_smiling_eyes"],
  ["🥲","smiling face with tear",0,"smiling_face_with_tear"],["😋","face savoring food",0,"yum"],
  ["😛","face with tongue",0,"stuck_out_tongue"],["😜","winking face with tongue",0,"stuck_out_tongue_winking_eye"],
  ["🤪","zany face",0,"zany_face"],["😝","squinting face with tongue",0,"stuck_out_tongue_closed_eyes"],
  ["🤑","money-mouth face",0,"money_mouth_face"],["🤗","smiling face with open hands",0,"hugs"],
  ["🤭","face with hand over mouth",0,"hand_over_mouth"],["🫢","face with open eyes and hand over mouth",0],
  ["🫣","face with peeking eye",0],["🤫","shushing face",0,"shushing_face"],
  ["🤔","thinking face",0,"thinking"],["🫡","saluting face",0,"saluting_face"],
  ["🤐","zipper-mouth face",0,"zipper_mouth_face"],["🤨","face with raised eyebrow",0,"raised_eyebrow"],
  ["😐","neutral face",0,"neutral_face"],["😑","expressionless face",0,"expressionless"],
  ["😶","face without mouth",0,"no_mouth"],["🫥","dotted line face",0],
  ["😏","smirking face",0,"smirk"],["😒","unamused face",0,"unamused"],
  ["🙄","face with rolling eyes",0,"roll_eyes"],["😬","grimacing face",0,"grimacing"],
  ["🤥","lying face",0,"lying_face"],["🫨","shaking face",0],
  ["😌","relieved face",0,"relieved"],["😔","pensive face",0,"pensive"],
  ["😪","sleepy face",0,"sleepy"],["🤤","drooling face",0,"drooling_face"],
  ["😴","sleeping face",0,"sleeping"],["🥱","yawning face",0,"yawning_face"],
  ["😷","face with medical mask",0,"mask"],["🤒","face with thermometer",0,"face_with_thermometer"],
  ["🤕","face with head-bandage",0,"face_with_head_bandage"],["🤢","nauseated face",0,"nauseated_face"],
  ["🤮","face vomiting",0,"face_vomiting"],["🤧","sneezing face",0,"sneezing_face"],
  ["🥵","hot face",0,"hot_face"],["🥶","cold face",0,"cold_face"],
  ["🥴","woozy face",0,"woozy_face"],["😵","face with crossed-out eyes",0,"dizzy_face"],
  ["🤯","exploding head",0,"exploding_head"],["🤠","cowboy hat face",0,"cowboy_hat_face"],
  ["🥳","partying face",0,"partying_face"],["🥸","disguised face",0,"disguised_face"],
  ["😎","smiling face with sunglasses",0,"sunglasses"],["🤓","nerd face",0,"nerd_face"],
  ["🧐","face with monocle",0,"monocle_face"],["😕","confused face",0,"confused"],
  ["🫤","face with diagonal mouth",0],["😟","worried face",0,"worried"],
  ["🙁","slightly frowning face",0,"slightly_frowning_face"],["☹️","frowning face",0,"frowning_face"],
  ["😮","face with open mouth",0,"open_mouth"],["😯","hushed face",0,"hushed"],
  ["😲","astonished face",0,"astonished"],["😳","flushed face",0,"flushed"],
  ["🥺","pleading face",0,"pleading_face"],["🥹","face holding back tears",0],
  ["😦","frowning face with open mouth",0,"frowning"],["😧","anguished face",0,"anguished"],
  ["😨","fearful face",0,"fearful"],["😰","anxious face with sweat",0,"cold_sweat"],
  ["😥","sad but relieved face",0,"disappointed_relieved"],["😢","crying face",0,"cry"],
  ["😭","loudly crying face",0,"sob"],["😱","face screaming in fear",0,"scream"],
  ["😖","confounded face",0,"confounded"],["😣","persevering face",0,"persevere"],
  ["😞","disappointed face",0,"disappointed"],["😓","downcast face with sweat",0,"sweat"],
  ["😩","weary face",0,"weary"],["😫","tired face",0,"tired_face"],
  ["😤","face with steam from nose",0,"triumph"],["😡","enraged face",0,"rage"],
  ["😠","angry face",0,"angry"],["🤬","face with symbols on mouth",0,"cursing_face"],
  ["😈","smiling face with horns",0,"smiling_imp"],["👿","angry face with horns",0,"imp"],
  ["💀","skull",0,"skull"],["☠️","skull and crossbones",0,"skull_crossbones"],
  ["💩","pile of poo",0,"poop"],["🤡","clown face",0,"clown_face"],
  ["👹","ogre",0,"japanese_ogre"],["👺","goblin",0,"japanese_goblin"],
  ["👻","ghost",0,"ghost"],["👽","alien",0,"alien"],
  ["👾","alien monster",0,"space_invader"],["🤖","robot",0,"robot"],
  ["😺","grinning cat",0,"smiley_cat"],["😸","grinning cat with smiling eyes",0,"smile_cat"],
  ["😹","cat with tears of joy",0,"joy_cat"],["😻","smiling cat with heart-eyes",0,"heart_eyes_cat"],
  ["😼","cat with wry smile",0,"smirk_cat"],["😽","kissing cat",0,"kissing_cat"],
  ["🙀","weary cat",0,"scream_cat"],["😿","crying cat",0,"crying_cat_face"],
  ["😾","pouting cat",0,"pouting_cat"],
  // Hearts & emotion symbols
  ["❤️","red heart",0,"heart"],["🧡","orange heart",0,"orange_heart"],
  ["💛","yellow heart",0,"yellow_heart"],["💚","green heart",0,"green_heart"],
  ["💙","blue heart",0,"blue_heart"],["💜","purple heart",0,"purple_heart"],
  ["🖤","black heart",0,"black_heart"],["🤍","white heart",0,"white_heart"],
  ["🤎","brown heart",0,"brown_heart"],["💔","broken heart",0,"broken_heart"],
  ["❤️‍🔥","heart on fire",0,"heart_on_fire"],["❤️‍🩹","mending heart",0,"mending_heart"],
  ["❣️","heart exclamation",0,"heavy_heart_exclamation"],["💕","two hearts",0,"two_hearts"],
  ["💞","revolving hearts",0,"revolving_hearts"],["💓","beating heart",0,"heartbeat"],
  ["💗","growing heart",0,"heartpulse"],["💖","sparkling heart",0,"sparkling_heart"],
  ["💘","heart with arrow",0,"cupid"],["💝","heart with ribbon",0,"gift_heart"],
  ["💟","heart decoration",0,"heart_decoration"],["💋","kiss mark",0,"kiss"],
  ["💌","love letter",0,"love_letter"],["💯","hundred points",0,"100"],
  ["💢","anger symbol",0,"anger"],["💥","collision",0,"boom"],
  ["💫","dizzy",0,"dizzy"],["💦","sweat droplets",0,"sweat_drops"],
  ["💨","dashing away",0,"dash"],["💬","speech balloon",0,"speech_balloon"],
  ["💭","thought balloon",0,"thought_balloon"],["🗯️","anger bubble",0,"anger_right"],
  ["✨","sparkles",0,"sparkles"],["🔥","fire",0,"fire"],
  ["🌟","glowing star",0,"star2"],["⭐","star",0,"star"],
  // ── People & Body ──
  ["👋","waving hand",1,"wave"],["🤚","raised back of hand",1,"raised_back_of_hand"],
  ["🖐️","hand with fingers splayed",1,"raised_hand_with_fingers_splayed"],["✋","raised hand",1,"hand"],
  ["🖖","vulcan salute",1,"vulcan_salute"],["🫱","rightwards hand",1],
  ["🫲","leftwards hand",1],["🫳","palm down hand",1],["🫴","palm up hand",1],
  ["👌","ok hand",1,"ok_hand"],["🤌","pinched fingers",1,"pinched_fingers"],
  ["🤏","pinching hand",1,"pinching_hand"],["✌️","victory hand",1,"v"],
  ["🤞","crossed fingers",1,"crossed_fingers"],["🫰","hand with index finger and thumb crossed",1],
  ["🤟","love-you gesture",1,"love_you_gesture"],["🤘","sign of the horns",1,"metal"],
  ["🤙","call me hand",1,"call_me_hand"],["🫵","index pointing at the viewer",1],
  ["👈","backhand index pointing left",1,"point_left"],["👉","backhand index pointing right",1,"point_right"],
  ["👆","backhand index pointing up",1,"point_up_2"],["🖕","middle finger",1,"middle_finger"],
  ["👇","backhand index pointing down",1,"point_down"],["☝️","index pointing up",1,"point_up"],
  ["👍","thumbs up",1,"thumbsup"],["👎","thumbs down",1,"thumbsdown"],
  ["✊","raised fist",1,"fist_raised"],["👊","oncoming fist",1,"facepunch"],
  ["🤛","left-facing fist",1,"fist_left"],["🤜","right-facing fist",1,"fist_right"],
  ["👏","clapping hands",1,"clap"],["🙌","raising hands",1,"raised_hands"],
  ["🫶","heart hands",1,"heart_hands"],["👐","open hands",1,"open_hands"],
  ["🤲","palms up together",1,"palms_up_together"],["🤝","handshake",1,"handshake"],
  ["🙏","folded hands",1,"pray"],["✍️","writing hand",1,"writing_hand"],
  ["💅","nail polish",1,"nail_care"],["🤳","selfie",1,"selfie"],
  ["💪","flexed biceps",1,"muscle"],["🦾","mechanical arm",1,"mechanical_arm"],
  ["🦿","mechanical leg",1,"mechanical_leg"],["🦵","leg",1,"leg"],["🦶","foot",1,"foot"],
  ["👂","ear",1,"ear"],["🦻","ear with hearing aid",1],["👃","nose",1,"nose"],
  ["🫀","anatomical heart",1,"anatomical_heart"],["🫁","lungs",1,"lungs"],
  ["🧠","brain",1,"brain"],["🦷","tooth",1,"tooth"],["🦴","bone",1,"bone"],
  ["👀","eyes",1,"eyes"],["👁️","eye",1,"eye"],["👅","tongue",1,"tongue"],["👄","mouth",1,"lips"],
  // People
  ["👶","baby",1,"baby"],["🧒","child",1,"child"],["👦","boy",1,"boy"],["👧","girl",1,"girl"],
  ["🧑","person",1,"person"],["👨","man",1,"man"],["👩","woman",1,"woman"],
  ["🧓","older person",1],["👴","old man",1,"older_man"],["👵","old woman",1,"older_woman"],
  ["👮","police officer",1,"cop"],["🕵️","detective",1,"detective"],
  ["💂","guard",1,"guardsman"],["👷","construction worker",1,"construction_worker"],
  ["🤴","prince",1,"prince"],["👸","princess",1,"princess"],
  ["👳","person wearing turban",1,"man_with_turban"],["🧕","woman with headscarf",1,"woman_with_headscarf"],
  ["🤵","person in tuxedo",1,"man_in_tuxedo"],["👰","person with veil",1,"bride_with_veil"],
  ["🤰","pregnant woman",1,"pregnant_woman"],["🤱","breast-feeding",1,"breast_feeding"],
  ["👼","baby angel",1,"angel"],["🎅","Santa Claus",1,"santa"],["🤶","Mrs. Claus",1,"mrs_claus"],
  ["🦸","superhero",1,"superhero"],["🦹","supervillain",1,"supervillain"],
  ["🧙","mage",1,"mage"],["🧝","elf",1,"elf"],["🧛","vampire",1,"vampire"],
  ["🧟","zombie",1,"zombie"],["🧞","genie",1,"genie"],["🧜","merperson",1,"mermaid"],
  ["🧚","fairy",1,"fairy"],["🙍","person frowning",1,"person_frowning"],
  ["🙎","person pouting",1,"person_with_pouting_face"],["🙅","person gesturing NO",1,"no_good"],
  ["🙆","person gesturing OK",1,"ok_woman"],["💁","person tipping hand",1,"information_desk_person"],
  ["🙋","person raising hand",1,"raising_hand"],["🧏","deaf person",1,"deaf_person"],
  ["🙇","person bowing",1,"bow"],["🤦","person facepalming",1,"facepalm"],
  ["🤷","person shrugging",1,"shrug"],["💆","person getting massage",1,"massage"],
  ["💇","person getting haircut",1,"haircut"],["🚶","person walking",1,"walking"],
  ["🏃","person running",1,"runner"],["💃","woman dancing",1,"dancer"],
  ["🕺","man dancing",1,"man_dancing"],["🧘","person in lotus position",1,"person_in_lotus_position"],
  ["👫","woman and man holding hands",1,"couple"],["👬","men holding hands",1,"two_men_holding_hands"],
  ["👭","women holding hands",1,"two_women_holding_hands"],["💏","kiss",1,"couplekiss"],
  ["💑","couple with heart",1,"couple_with_heart"],["👨‍👩‍👦","family",1,"family"],
  // ── Animals & Nature ──
  ["🐶","dog face",2,"dog"],["🐱","cat face",2,"cat"],["🐭","mouse face",2,"mouse"],
  ["🐹","hamster",2,"hamster"],["🐰","rabbit face",2,"rabbit"],["🦊","fox",2,"fox_face"],
  ["🐻","bear",2,"bear"],["🐼","panda",2,"panda_face"],["🐨","koala",2,"koala"],
  ["🐯","tiger face",2,"tiger"],["🦁","lion",2,"lion"],["🐮","cow face",2,"cow"],
  ["🐷","pig face",2,"pig"],["🐸","frog",2,"frog"],["🐵","monkey face",2,"monkey_face"],
  ["🙈","see-no-evil monkey",2,"see_no_evil"],["🙉","hear-no-evil monkey",2,"hear_no_evil"],
  ["🙊","speak-no-evil monkey",2,"speak_no_evil"],["🐔","chicken",2,"chicken"],
  ["🐧","penguin",2,"penguin"],["🐦","bird",2,"bird"],["🐤","baby chick",2,"baby_chick"],
  ["🦆","duck",2,"duck"],["🦅","eagle",2,"eagle"],["🦉","owl",2,"owl"],["🦇","bat",2,"bat"],
  ["🐺","wolf",2,"wolf"],["🐗","boar",2,"boar"],["🐴","horse face",2,"horse"],["🦄","unicorn",2,"unicorn"],
  ["🐝","honeybee",2,"bee"],["🪱","worm",2,"worm"],["🐛","bug",2,"bug"],
  ["🦋","butterfly",2,"butterfly"],["🐌","snail",2,"snail"],["🐞","lady beetle",2,"beetle"],
  ["🐜","ant",2,"ant"],["🦟","mosquito",2,"mosquito"],["🦗","cricket",2,"cricket"],
  ["🦂","scorpion",2,"scorpion"],["🐢","turtle",2,"turtle"],["🐍","snake",2,"snake"],
  ["🦎","lizard",2,"lizard"],["🦖","T-Rex",2,"t-rex"],["🦕","sauropod",2,"sauropod"],
  ["🐙","octopus",2,"octopus"],["🦑","squid",2,"squid"],["🦐","shrimp",2,"shrimp"],
  ["🦞","lobster",2,"lobster"],["🦀","crab",2,"crab"],["🐡","blowfish",2,"blowfish"],
  ["🐠","tropical fish",2,"tropical_fish"],["🐟","fish",2,"fish"],["🐬","dolphin",2,"dolphin"],
  ["🐳","spouting whale",2,"whale"],["🦈","shark",2,"shark"],["🐊","crocodile",2,"crocodile"],
  ["🐘","elephant",2,"elephant"],["🦛","hippopotamus",2,"hippopotamus"],
  ["🦏","rhinoceros",2,"rhinoceros"],["🐪","camel",2,"dromedary_camel"],
  ["🦒","giraffe",2,"giraffe"],["🦘","kangaroo",2,"kangaroo"],["🦬","bison",2,"bison"],
  ["🐎","horse",2,"racehorse"],["🐑","ewe",2,"sheep"],["🦌","deer",2,"deer"],
  ["🐕","dog",2,"dog2"],["🦮","guide dog",2,"guide_dog"],["🐈","cat",2,"cat2"],
  ["🦤","dodo",2,"dodo"],["🦚","peacock",2,"peacock"],["🦜","parrot",2,"parrot"],
  ["🦢","swan",2,"swan"],["🦩","flamingo",2,"flamingo"],["🕊️","dove",2,"dove"],
  ["🐇","rabbit",2,"rabbit2"],["🦝","raccoon",2,"raccoon"],["🦨","skunk",2,"skunk"],
  ["🦡","badger",2,"badger"],["🦦","otter",2,"otter"],["🦥","sloth",2,"sloth"],
  ["🐿️","chipmunk",2,"chipmunk"],["🦔","hedgehog",2,"hedgehog"],
  ["🦍","gorilla",2,"gorilla"],["🦧","orangutan",2,"orangutan"],
  // Plants
  ["🌵","cactus",2,"cactus"],["🎄","Christmas tree",2,"christmas_tree"],
  ["🌲","evergreen tree",2,"evergreen_tree"],["🌳","deciduous tree",2,"deciduous_tree"],
  ["🌴","palm tree",2,"palm_tree"],["🌱","seedling",2,"seedling"],["🌿","herb",2,"herb"],
  ["☘️","shamrock",2,"shamrock"],["🍀","four leaf clover",2,"four_leaf_clover"],
  ["🍃","leaves",2,"leaves"],["🍂","fallen leaf",2,"fallen_leaf"],["🍁","maple leaf",2,"maple_leaf"],
  ["🌾","sheaf of rice",2,"ear_of_rice"],["🌺","hibiscus",2,"hibiscus"],
  ["🌻","sunflower",2,"sunflower"],["🌹","rose",2,"rose"],["🥀","wilted flower",2,"wilted_flower"],
  ["🌷","tulip",2,"tulip"],["🌼","blossom",2,"blossom"],["🌸","cherry blossom",2,"cherry_blossom"],
  ["💐","bouquet",2,"bouquet"],["🍄","mushroom",2,"mushroom"],["🌰","chestnut",2,"chestnut"],
  // Weather
  ["🌊","water wave",2,"ocean"],["💧","droplet",2,"droplet"],["🌈","rainbow",2,"rainbow"],
  ["⚡","lightning",2,"zap"],["❄️","snowflake",2,"snowflake"],["🌪️","tornado",2,"tornado"],
  ["🌙","crescent moon",2,"crescent_moon"],["☀️","sun",2,"sunny"],["⛅","sun behind cloud",2,"partly_sunny"],
  ["☁️","cloud",2,"cloud"],["🌧️","cloud with rain",2,"cloud_with_rain"],
  ["⛈️","cloud with lightning and rain",2,"thunder_cloud_and_rain"],
  ["🌨️","cloud with snow",2,"cloud_with_snow"],["⛄","snowman",2,"snowman"],
  ["🌬️","wind face",2,"wind_face"],["🌀","cyclone",2,"cyclone"],["🌫️","fog",2],
  // ── Food & Drink ──
  ["🍎","red apple",3,"apple"],["🍊","tangerine",3,"tangerine"],["🍋","lemon",3,"lemon"],
  ["🍌","banana",3,"banana"],["🍉","watermelon",3,"watermelon"],["🍇","grapes",3,"grapes"],
  ["🍓","strawberry",3,"strawberry"],["🫐","blueberries",3,"blueberries"],
  ["🍒","cherries",3,"cherries"],["🍑","peach",3,"peach"],["🥭","mango",3,"mango"],
  ["🍍","pineapple",3,"pineapple"],["🥥","coconut",3,"coconut"],["🥝","kiwi fruit",3,"kiwi_fruit"],
  ["🍅","tomato",3,"tomato"],["🫒","olive",3,"olive"],["🥑","avocado",3,"avocado"],
  ["🍆","eggplant",3,"eggplant"],["🥦","broccoli",3,"broccoli"],["🥬","leafy green",3,"leafy_green"],
  ["🥒","cucumber",3,"cucumber"],["🌶️","hot pepper",3,"hot_pepper"],
  ["🫑","bell pepper",3,"bell_pepper"],["🧄","garlic",3,"garlic"],["🧅","onion",3,"onion"],
  ["🥔","potato",3,"potato"],["🌽","ear of corn",3,"corn"],["🥐","croissant",3,"croissant"],
  ["🥯","bagel",3,"bagel"],["🍞","bread",3,"bread"],["🥖","baguette bread",3,"baguette_bread"],
  ["🥨","pretzel",3,"pretzel"],["🧀","cheese wedge",3,"cheese"],["🥚","egg",3,"egg"],
  ["🍳","cooking",3,"cooking"],["🧇","waffle",3,"waffle"],["🥞","pancakes",3,"pancakes"],
  ["🧈","butter",3,"butter"],["🍗","poultry leg",3,"poultry_leg"],["🍖","meat on bone",3,"meat_on_bone"],
  ["🥩","cut of meat",3,"cut_of_meat"],["🥓","bacon",3,"bacon"],["🌭","hot dog",3,"hotdog"],
  ["🍔","hamburger",3,"hamburger"],["🍟","french fries",3,"fries"],["🍕","pizza",3,"pizza"],
  ["🌮","taco",3,"taco"],["🌯","burrito",3,"burrito"],["🫔","tamale",3],
  ["🥙","stuffed flatbread",3,"stuffed_flatbread"],["🧆","falafel",3,"falafel"],
  ["🍝","spaghetti",3,"spaghetti"],["🥗","green salad",3,"salad"],
  ["🥘","shallow pan of food",3,"shallow_pan_of_food"],["🥫","canned food",3,"canned_food"],
  ["🍱","bento box",3,"bento"],["🍙","rice ball",3,"rice_ball"],["🍚","cooked rice",3,"rice"],
  ["🍛","curry rice",3,"curry"],["🍜","steaming bowl",3,"ramen"],["🍲","pot of food",3,"stew"],
  ["🍣","sushi",3,"sushi"],["🍤","fried shrimp",3,"fried_shrimp"],["🦪","oyster",3,"oyster"],
  ["🍦","soft ice cream",3,"icecream"],["🍩","doughnut",3,"doughnut"],["🍪","cookie",3,"cookie"],
  ["🎂","birthday cake",3,"birthday"],["🍰","shortcake",3,"cake"],["🧁","cupcake",3,"cupcake"],
  ["🍫","chocolate bar",3,"chocolate_bar"],["🍬","candy",3,"candy"],["🍭","lollipop",3,"lollipop"],
  ["🍯","honey pot",3,"honey_pot"],["☕","hot beverage",3,"coffee"],["🫖","teapot",3,"teapot"],
  ["🍵","teacup without handle",3,"tea"],["🧃","beverage box",3,"beverage_box"],
  ["🥤","cup with straw",3,"cup_with_straw"],["🧋","bubble tea",3,"bubble_tea"],
  ["🍺","beer mug",3,"beer"],["🍻","clinking beer mugs",3,"beers"],
  ["🥂","clinking glasses",3,"champagne"],["🍷","wine glass",3,"wine_glass"],
  ["🥃","tumbler glass",3,"tumbler_glass"],["🍸","cocktail glass",3,"cocktail"],
  ["🍹","tropical drink",3,"tropical_drink"],["🍾","bottle with popping cork",3,"bottle_with_popping_cork"],
  ["🧊","ice",3,"ice_cube"],["🥄","spoon",3,"spoon"],
  ["🍴","fork and knife",3,"fork_and_knife"],["🥢","chopsticks",3,"chopsticks"],
  // ── Travel & Places ──
  ["🚗","automobile",4,"car"],["🚕","taxi",4,"taxi"],["🚙","sport utility vehicle",4,"blue_car"],
  ["🚌","bus",4,"bus"],["🏎️","racing car",4,"racing_car"],["🚓","police car",4,"police_car"],
  ["🚑","ambulance",4,"ambulance"],["🚒","fire engine",4,"fire_engine"],
  ["🚚","delivery truck",4,"truck"],["🚜","tractor",4,"tractor"],
  ["🛺","auto rickshaw",4,"auto_rickshaw"],["🚲","bicycle",4,"bike"],
  ["🛴","kick scooter",4,"scooter"],["🛵","motor scooter",4,"motor_scooter"],
  ["🏍️","motorcycle",4,"motorcycle"],["🚀","rocket",4,"rocket"],
  ["🛸","flying saucer",4,"flying_saucer"],["✈️","airplane",4,"airplane"],
  ["🛫","airplane departure",4,"airplane_departure"],["🛬","airplane arrival",4,"airplane_arriving"],
  ["🪂","parachute",4,"parachute"],["🚁","helicopter",4,"helicopter"],
  ["🛶","canoe",4,"canoe"],["⛵","sailboat",4,"sailboat"],["🚤","speedboat",4,"speedboat"],
  ["🚢","ship",4,"ship"],["🚨","police car light",4,"rotating_light"],
  ["🚥","horizontal traffic light",4,"traffic_light"],["🚦","vertical traffic light",4,"vertical_traffic_light"],
  ["🛑","stop sign",4,"octagonal_sign"],["⛽","fuel pump",4,"fuelpump"],
  ["⛰️","mountain",4,"mountain"],["🌋","volcano",4,"volcano"],
  ["🏔️","snow-capped mountain",4,"snow_capped_mountain"],["🗻","mount fuji",4,"mount_fuji"],
  ["🏕️","camping",4,"camping"],["🏖️","beach with umbrella",4,"beach_with_umbrella"],
  ["🏜️","desert",4,"desert"],["🏝️","desert island",4,"desert_island"],
  ["🌏","globe showing Asia-Australia",4,"earth_asia"],["🌍","globe showing Europe-Africa",4,"earth_africa"],
  ["🌎","globe showing Americas",4,"earth_americas"],["🗺️","world map",4,"world_map"],
  ["🏠","house",4,"house"],["🏡","house with garden",4,"house_with_garden"],
  ["🏢","office building",4,"office"],["🏥","hospital",4,"hospital"],
  ["🏦","bank",4,"bank"],["🏨","hotel",4,"hotel"],["🏪","convenience store",4,"convenience_store"],
  ["🏫","school",4,"school"],["🏭","factory",4,"factory"],
  ["🏰","castle",4,"european_castle"],["🏯","Japanese castle",4,"japanese_castle"],
  ["💒","wedding",4,"wedding"],["🗼","Tokyo Tower",4,"tokyo_tower"],
  ["🗽","Statue of Liberty",4,"statue_of_liberty"],["⛪","church",4,"church"],
  ["🕌","mosque",4,"mosque"],["🛕","hindu temple",4,"hindu_temple"],
  // ── Activities ──
  ["⚽","soccer ball",5,"soccer"],["🏀","basketball",5,"basketball"],
  ["🏈","american football",5,"football"],["⚾","baseball",5,"baseball"],
  ["🥎","softball",5,"softball"],["🎾","tennis",5,"tennis"],
  ["🏐","volleyball",5,"volleyball"],["🏉","rugby football",5,"rugby_football"],
  ["🥏","flying disc",5,"flying_disc"],["🎱","pool 8 ball",5,"8ball"],
  ["🏓","ping pong",5,"table_tennis_paddle_and_ball"],["🏸","badminton",5,"badminton"],
  ["🏒","ice hockey",5,"ice_hockey"],["🥍","lacrosse",5,"lacrosse"],
  ["🪃","boomerang",5,"boomerang"],["🥅","goal net",5,"goal_net"],
  ["⛳","flag in hole",5,"golf"],["🪁","bow and arrow",5,"archery"],
  ["🎣","fishing pole",5,"fishing_pole_and_fish"],["🤿","diving mask",5,"diving_mask"],
  ["🎿","skis",5,"ski"],["🛷","sled",5,"sled"],["🥌","curling stone",5,"curling_stone"],
  ["🎯","bullseye",5,"dart"],["🎮","video game",5,"video_game"],
  ["🕹️","joystick",5,"joystick"],["🎲","game die",5,"game_die"],
  ["♟️","chess pawn",5,"chess_pawn"],["🧩","puzzle piece",5,"jigsaw"],
  ["🎭","performing arts",5,"performing_arts"],["🎨","artist palette",5,"art"],
  ["🖼️","framed picture",5,"framed_picture"],["🎪","circus tent",5,"circus_tent"],
  ["🎤","microphone",5,"microphone"],["🎧","headphone",5,"headphones"],
  ["🎼","musical score",5,"musical_score"],["🎵","musical note",5,"musical_note"],
  ["🎶","musical notes",5,"notes"],["🎸","guitar",5,"guitar"],["🪕","banjo",5,"banjo"],
  ["🎹","musical keyboard",5,"musical_keyboard"],["🥁","drum",5,"drum"],
  ["🪘","long drum",5,"long_drum"],["🎷","saxophone",5,"saxophone"],
  ["🎺","trumpet",5,"trumpet"],["🎻","violin",5,"violin"],["🪗","accordion",5,"accordion"],
  ["🎬","clapper board",5,"clapper"],["🎥","movie camera",5,"movie_camera"],
  ["📷","camera",5,"camera"],["🎦","cinema",5,"cinema"],
  // ── Objects ──
  ["💡","light bulb",6,"bulb"],["🔦","flashlight",6,"flashlight"],["🕯️","candle",6,"candle"],
  ["💰","money bag",6,"moneybag"],["💵","dollar banknote",6,"dollar"],
  ["💳","credit card",6,"credit_card"],["💎","gem stone",6,"gem"],
  ["⚖️","balance scale",6,"scales"],["🔧","wrench",6,"wrench"],["🔨","hammer",6,"hammer"],
  ["🛠️","hammer and wrench",6,"hammer_and_wrench"],["⚙️","gear",6,"gear"],
  ["🔗","link",6,"link"],["🧲","magnet",6,"magnet"],["🔫","water pistol",6,"gun"],
  ["💣","bomb",6,"bomb"],["🔪","kitchen knife",6,"hocho"],["🧰","toolbox",6,"toolbox"],
  ["🪜","ladder",6,"ladder"],["🧪","test tube",6,"test_tube"],
  ["🧴","lotion bottle",6,"lotion_bottle"],["🧷","safety pin",6,"safety_pin"],
  ["🧹","broom",6,"broom"],["🧺","basket",6,"basket"],["🧻","roll of paper",6,"roll_of_paper"],
  ["🪣","bucket",6,"bucket"],["🧼","soap",6,"soap"],["🪥","toothbrush",6,"toothbrush"],
  ["🧽","sponge",6,"sponge"],["💊","pill",6,"pill"],["💉","syringe",6,"syringe"],
  ["🩺","stethoscope",6,"stethoscope"],["🩹","adhesive bandage",6,"adhesive_bandage"],
  ["🚪","door",6,"door"],["🛏️","bed",6,"bed"],["🛋️","couch and lamp",6,"couch_and_lamp"],
  ["🪑","chair",6,"chair"],["🚽","toilet",6,"toilet"],["🚿","shower",6,"shower"],
  ["📱","mobile phone",6,"iphone"],["💻","laptop",6,"computer"],
  ["⌨️","keyboard",6,"keyboard"],["🖥️","desktop computer",6,"desktop_computer"],
  ["🖨️","printer",6,"printer"],["🖱️","computer mouse",6,"computer_mouse"],
  ["💾","floppy disk",6,"floppy_disk"],["💿","optical disk",6,"cd"],
  ["📺","television",6,"tv"],["📞","telephone receiver",6,"telephone_receiver"],
  ["☎️","telephone",6,"phone"],["📡","satellite antenna",6,"satellite"],
  ["🔋","battery",6,"battery"],["🔌","electric plug",6,"electric_plug"],
  ["📚","books",6,"books"],["📖","open book",6,"open_book"],["📝","memo",6,"memo"],
  ["🔍","magnifying glass tilted left",6,"mag"],["📋","clipboard",6,"clipboard"],
  ["📌","pushpin",6,"pushpin"],["📎","paperclip",6,"paperclip"],["✂️","scissors",6,"scissors"],
  ["🔒","locked",6,"lock"],["🔓","unlocked",6,"unlock"],["🔑","key",6,"key"],
  ["📦","package",6,"package"],["📫","closed mailbox with raised flag",6,"mailbox"],
  ["✏️","pencil",6,"pencil2"],["🎁","wrapped gift",6,"gift"],["🎀","ribbon",6,"ribbon"],
  ["🎊","confetti ball",6,"confetti_ball"],["🎉","party popper",6,"tada"],
  ["🎈","balloon",6,"balloon"],["🏆","trophy",6,"trophy"],
  ["🥇","1st place medal",6,"first_place_medal"],["🥈","2nd place medal",6,"second_place_medal"],
  ["🥉","3rd place medal",6,"third_place_medal"],
  // ── Symbols ──
  ["✅","check mark button",7,"white_check_mark"],["❌","cross mark",7,"x"],
  ["❓","question mark",7,"question"],["❗","exclamation mark",7,"exclamation"],
  ["‼️","double exclamation mark",7,"bangbang"],["⁉️","exclamation question mark",7,"interrobang"],
  ["🔔","bell",7,"bell"],["🔕","bell with slash",7,"no_bell"],
  ["🔇","muted speaker",7,"mute"],["🔊","speaker high volume",7,"loud_sound"],
  ["📢","loudspeaker",7,"loudspeaker"],["📣","megaphone",7,"mega"],
  ["▶️","play button",7,"arrow_forward"],["⏩","fast-forward button",7,"fast_forward"],
  ["◀️","reverse button",7,"arrow_backward"],["⏪","fast reverse button",7,"rewind"],
  ["⏸️","pause button",7,"double_vertical_bar"],["⏹️","stop button",7,"black_square_for_stop"],
  ["🔀","shuffle tracks button",7,"twisted_rightwards_arrows"],["🔁","repeat button",7,"repeat"],
  ["🔴","red circle",7,"red_circle"],["🟠","orange circle",7,"orange_circle"],
  ["🟡","yellow circle",7,"yellow_circle"],["🟢","green circle",7,"green_circle"],
  ["🔵","blue circle",7,"blue_circle"],["🟣","purple circle",7,"purple_circle"],
  ["⚫","black circle",7,"black_circle"],["⚪","white circle",7,"white_circle"],
  ["🟤","brown circle",7,"brown_circle"],["🔶","large orange diamond",7,"large_orange_diamond"],
  ["🔷","large blue diamond",7,"large_blue_diamond"],
  ["🔺","red triangle pointed up",7,"small_red_triangle"],
  ["🔻","red triangle pointed down",7,"small_red_triangle_down"],
  ["🟥","red square",7,"red_square"],["🟧","orange square",7,"orange_square"],
  ["🟨","yellow square",7,"yellow_square"],["🟩","green square",7,"green_square"],
  ["🟦","blue square",7,"blue_square"],["🟪","purple square",7,"purple_square"],
  ["⬛","black large square",7,"black_large_square"],["⬜","white large square",7,"white_large_square"],
  ["🟫","brown square",7,"brown_square"],
  ["↗️","up-right arrow",7,"arrow_upper_right"],["➡️","right arrow",7,"arrow_right"],
  ["↘️","down-right arrow",7,"arrow_lower_right"],["↙️","down-left arrow",7,"arrow_lower_left"],
  ["↖️","up-left arrow",7,"arrow_upper_left"],["⬆️","up arrow",7,"arrow_up"],
  ["⬇️","down arrow",7,"arrow_down"],["↕️","up-down arrow",7,"arrows_up_down"],
  ["↔️","left-right arrow",7,"left_right_arrow"],["↩️","right arrow curving left",7,"leftwards_arrow_with_hook"],
  ["↪️","left arrow curving right",7,"arrow_right_hook"],
  ["🔃","clockwise vertical arrows",7,"arrows_clockwise"],
  ["🔄","counterclockwise arrows button",7,"arrows_counterclockwise"],
  ["🔙","BACK arrow",7,"back"],["🔚","END arrow",7,"end"],
  ["🔛","ON! arrow",7,"on"],["🔜","SOON arrow",7,"soon"],["🔝","TOP arrow",7,"top"],
  ["♻️","recycling symbol",7,"recycle"],["⚠️","warning",7,"warning"],
  ["☢️","radioactive",7,"radioactive"],["☣️","biohazard",7,"biohazard"],
  ["✔️","check mark",7,"heavy_check_mark"],["☑️","check box with check",7,"ballot_box_with_check"],
  ["❎","cross mark button",7,"negative_squared_cross_mark"],
  ["🆗","OK button",7,"ok"],["🆒","COOL button",7,"cool"],
  ["🆕","NEW button",7,"new"],["🆓","FREE button",7,"free"],
  ["🆘","SOS button",7,"sos"],["🆙","UP! button",7,"up"],["🆚","VS button",7,"vs"],
  ["♈","Aries",7,"aries"],["♉","Taurus",7,"taurus"],["♊","Gemini",7,"gemini"],
  ["♋","Cancer",7,"cancer"],["♌","Leo",7,"leo"],["♍","Virgo",7,"virgo"],
  ["♎","Libra",7,"libra"],["♏","Scorpius",7,"scorpius"],["♐","Sagittarius",7,"sagittarius"],
  ["♑","Capricorn",7,"capricorn"],["♒","Aquarius",7,"aquarius"],["♓","Pisces",7,"pisces"],
  ["⛎","Ophiuchus",7,"ophiuchus"],["☮️","peace symbol",7,"peace_symbol"],
  ["✝️","latin cross",7,"latin_cross"],["☯️","yin yang",7,"yin_yang"],
  ["🕉️","om",7,"om_symbol"],["☪️","star and crescent",7,"star_and_crescent"],
  ["🔰","Japanese symbol for beginner",7,"beginner"],["⭕","hollow red circle",7,"o"],
  ["©️","copyright",7,"copyright"],["®️","registered",7,"registered"],["™️","trade mark",7,"tm"],
  ["🔮","crystal ball",7,"crystal_ball"],["🪄","magic wand",7,"magic_wand"],
  ["🎴","flower playing cards",7,"flower_playing_cards"],["🃏","joker",7,"black_joker"],
  ["♠️","spade suit",7,"spades"],["♥️","heart suit",7,"hearts"],
  ["♦️","diamond suit",7,"diamonds"],["♣️","club suit",7,"clubs"],
];

// Build lookup structures
const EMOJI_SHORTCODE_MAP = Object.create(null);
const _EMOJI_SEARCH = [];
const EMOJI_CATEGORIES = [
  { icon: "😀", name: "Smileys",    emojis: [] },
  { icon: "👋", name: "People",     emojis: [] },
  { icon: "🐶", name: "Animals",    emojis: [] },
  { icon: "🍕", name: "Food",       emojis: [] },
  { icon: "🏖️", name: "Travel",     emojis: [] },
  { icon: "⚽", name: "Activities", emojis: [] },
  { icon: "💡", name: "Objects",    emojis: [] },
  { icon: "❤️", name: "Symbols",    emojis: [] },
];
for (const [e, n, cat, sc] of _EMOJI_RAW) {
  EMOJI_CATEGORIES[cat].emojis.push(e);
  _EMOJI_SEARCH.push({ e, n });
  if (sc) EMOJI_SHORTCODE_MAP[sc] = e;
}

let _emojiHoverTimer = null;
let _emojiLastConversion = null; // { text, emoji } for backspace undo
let _emojiConverting = false;    // suppress re-entry during conversion

// Lazy-init: regex matching all known emoji (longest first) + codepoint cache.
let _emojiRegex = null;
let _emojiCpCache = null;
function _initEmojiRegex() {
  if (_emojiRegex || typeof twemoji === "undefined") return;
  _emojiCpCache = new Map();
  const sorted = _EMOJI_RAW.map(([e]) => e).sort((a, b) => b.length - a.length);
  for (const e of sorted) _emojiCpCache.set(e, twemoji.convert.toCodePoint(e));
  _emojiRegex = new RegExp(sorted.join("|"), "gu");
}

// Creates a DOM <img> element for a single emoji char (Apple 64px sprite).
// Single source of truth for emoji image construction — all other helpers
// (_emojiImgHtml, _emojiInsert, tryEmojiShortcode) delegate here.
function _makeEmojiImg(emoji) {
  _initEmojiRegex();
  const cp = (_emojiCpCache && _emojiCpCache.has(emoji))
    ? _emojiCpCache.get(emoji)
    : twemoji.convert.toCodePoint(emoji);
  const img = document.createElement("img");
  img.src = `/emoji/apple/64/${cp}.png`;
  img.alt = emoji;           // stored as Unicode for serialization (serializeRichText reads .alt)
  img.className = "emoji";
  img.setAttribute("draggable", "false");
  return img;
}

// Returns the outerHTML string of the Apple emoji <img> — for use in innerHTML generation.
function _emojiImgHtml(emoji) {
  if (typeof twemoji === "undefined") return escapeHtml(emoji);
  return _makeEmojiImg(emoji).outerHTML;
}

// Moves the cursor (Selection) to immediately after `node`.
function _placeCursorAfter(node, sel) {
  const r = document.createRange();
  r.setStartAfter(node);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

// Walks every text node in `el`, replaces known emoji with Apple <img> elements.
// Used instead of twemoji.parse because Twemoji 14's compiled regex doesn't cover
// Unicode 15 emoji (🫨 etc.) — _makeEmojiImg works for any emoji via pure math.
function _applyEmojiDirect(el) {
  if (!el || typeof twemoji === "undefined") return;
  _initEmojiRegex();
  if (!_emojiRegex) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (const node of nodes) {
    const text = node.textContent;
    _emojiRegex.lastIndex = 0;
    if (!_emojiRegex.test(text)) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    _emojiRegex.lastIndex = 0;
    let m;
    while ((m = _emojiRegex.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(_makeEmojiImg(m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  }
}

// Kept for input field (handles OS-pasted emoji beyond our known set via Twemoji's regex).
function applyAppleEmoji(el) {
  if (!el || typeof twemoji === "undefined") return;
  twemoji.parse(el, {
    folder: "64",
    ext: ".png",
    base: "/emoji/apple/",
    attributes: () => ({ draggable: "false", class: "emoji" }),
  });
}

// Inserts an Apple emoji <img> at the current cursor position inside #chat-input.
// Falls back to plain Unicode text if Twemoji isn't loaded (shouldn't happen in prod).
function _emojiInsert(emoji) {
  const inputEl = document.getElementById("chat-input");
  if (!inputEl) return;
  inputEl.focus();
  const sel = window.getSelection();
  if (!sel) return;

  // Use the existing cursor if it's inside the input; otherwise place it at the end.
  let range;
  if (sel.rangeCount && inputEl.contains(sel.getRangeAt(0).startContainer)) {
    range = sel.getRangeAt(0);
  } else {
    range = document.createRange();
    range.selectNodeContents(inputEl);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  if (typeof twemoji !== "undefined") {
    const img = _makeEmojiImg(emoji);
    range.deleteContents();
    range.insertNode(img);
    _placeCursorAfter(img, sel);
  } else {
    document.execCommand("insertText", false, emoji);
  }

  // Notify oninput so the typing indicator and hasText check stay in sync.
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
}

function _positionEmojiDock() {
  const dock = document.getElementById("emoji-dock");
  const chatMain = document.querySelector(".chat-main");
  if (!dock || !chatMain) return;
  const r = chatMain.getBoundingClientRect();
  dock.style.left = `${r.right + 8}px`;
  dock.style.top  = `${r.top}px`;
  dock.style.height = `${r.height}px`;
}

// Called from oninput: checks if the text immediately before the cursor matches
// ":shortcode:" and, if so, replaces it with an Apple emoji <img>.
// Sets _emojiLastConversion so the user can Backspace to undo the substitution.
function tryEmojiShortcode(inputEl) {
  if (_emojiConverting) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return;
  const node = range.endContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;

  const textBefore = node.textContent.substring(0, range.endOffset);
  const match = textBefore.match(/:(\w+):$/);
  if (!match) return;
  const emoji = EMOJI_SHORTCODE_MAP[match[1]];
  if (!emoji) return;

  const fullMatch = match[0];
  const replaceRange = document.createRange();
  replaceRange.setStart(node, range.endOffset - fullMatch.length);
  replaceRange.setEnd(node, range.endOffset);

  if (typeof twemoji !== "undefined") {
    const img = _makeEmojiImg(emoji);
    replaceRange.deleteContents();
    replaceRange.insertNode(img);
    _placeCursorAfter(img, sel);
  } else {
    // Fallback when Twemoji isn't available: insert Unicode char via execCommand.
    sel.removeAllRanges();
    sel.addRange(replaceRange);
    _emojiConverting = true;
    document.execCommand("insertText", false, emoji);
    _emojiConverting = false;
  }
  _emojiLastConversion = { text: fullMatch, emoji };
}

function undoEmojiConversion() {
  if (!_emojiLastConversion) return false;
  const { text, emoji } = _emojiLastConversion;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return false;

  const container = range.endContainer;
  const offset = range.endOffset;

  // Primary: cursor is inside an element and the child just before it is the emoji <img>
  if (container.nodeType === Node.ELEMENT_NODE && offset > 0) {
    const prev = container.childNodes[offset - 1];
    if (prev && prev.nodeName === "IMG" && prev.classList.contains("emoji") && prev.alt === emoji) {
      const r = document.createRange();
      r.selectNode(prev);
      sel.removeAllRanges();
      sel.addRange(r);
      _emojiConverting = true;
      document.execCommand("insertText", false, text);
      _emojiConverting = false;
      _emojiLastConversion = null;
      return true;
    }
  }
  // Secondary: cursor is at start of a text node and the previous sibling is the emoji <img>
  if (container.nodeType === Node.TEXT_NODE && offset === 0) {
    const prev = container.previousSibling;
    if (prev && prev.nodeName === "IMG" && prev.classList.contains("emoji") && prev.alt === emoji) {
      const r = document.createRange();
      r.selectNode(prev);
      sel.removeAllRanges();
      sel.addRange(r);
      _emojiConverting = true;
      document.execCommand("insertText", false, text);
      _emojiConverting = false;
      _emojiLastConversion = null;
      return true;
    }
  }
  // Fallback: emoji is still a raw text node (twemoji unavailable)
  if (container.nodeType === Node.TEXT_NODE) {
    const textBefore = container.textContent.substring(0, offset);
    if (textBefore.endsWith(emoji)) {
      const r = document.createRange();
      r.setStart(container, offset - emoji.length);
      r.setEnd(container, offset);
      sel.removeAllRanges();
      sel.addRange(r);
      _emojiConverting = true;
      document.execCommand("insertText", false, text);
      _emojiConverting = false;
      _emojiLastConversion = null;
      return true;
    }
  }
  return false;
}

// ─── Cursor preservation helpers ─────────────────────────────────────────────
// When applyAppleEmoji (Twemoji.parse) rewrites text nodes containing emoji it
// destroys any live Selection that points into those nodes. To recover, we
// snapshot the cursor position as a "logical character offset" before the call
// and then walk the updated DOM to find the same position afterwards.
//
// Logical char offset: number of Unicode chars consumed, where each emoji <img>
// counts as the length of its .alt string (the original Unicode char sequence).
// This keeps the offset stable across the text-node → <img> replacement.

function _saveCursorOffset(root) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return -1;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return -1;
  let offset = 0;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
  while (tw.nextNode()) {
    const n = tw.currentNode;
    if (n === range.endContainer && n.nodeType === Node.TEXT_NODE) {
      return offset + range.endOffset;
    }
    if (n.nodeType === Node.TEXT_NODE) {
      offset += n.textContent.length;
    } else if (n.nodeName === "IMG" && n.classList.contains("emoji")) {
      offset += (n.alt || "").length;
    }
  }
  return -1; // cursor not found inside root
}

function _restoreCursorOffset(root, savedOffset) {
  if (savedOffset < 0) return;
  const sel = window.getSelection();
  if (!sel) return;
  let remaining = savedOffset;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
  while (tw.nextNode()) {
    const n = tw.currentNode;
    if (n.nodeType === Node.TEXT_NODE) {
      const len = n.textContent.length;
      if (remaining <= len) {
        const r = document.createRange();
        r.setStart(n, remaining);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        return;
      }
      remaining -= len;
    } else if (n.nodeName === "IMG" && n.classList.contains("emoji")) {
      const len = (n.alt || "").length;
      if (remaining <= len) {
        const r = document.createRange();
        r.setStartAfter(n);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        return;
      }
      remaining -= len;
    }
  }
  // Fallback: place cursor at end of root
  const r = document.createRange();
  r.selectNodeContents(root);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

// Runs applyAppleEmoji on the input field while keeping the cursor in its current
// logical position. Needed because Twemoji.parse rewrites text nodes, which
// invalidates any live Selection pointing into them.
// If the input doesn't have focus, cursor preservation is skipped (no selection to save).
function _applyEmojiToInputSafe(inputEl) {
  if (document.activeElement !== inputEl) {
    applyAppleEmoji(inputEl);
    return;
  }
  const saved = _saveCursorOffset(inputEl);
  applyAppleEmoji(inputEl);
  _restoreCursorOffset(inputEl, saved);
}

// Global observer: replaces emoji in ANY new DOM content automatically.
// Only exception: #chat-input, which uses _applyEmojiToInputSafe for cursor preservation.
function _setupGlobalEmojiObserver() {
  const obs = new MutationObserver(mutations => {
    const toProcess = new Set();
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.nodeName === "IMG" && node.classList.contains("emoji")) continue;
          toProcess.add(node);
        } else if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
          toProcess.add(node.parentElement);
        }
      }
    }
    for (const el of toProcess) {
      if (el.id === "chat-input" || el.closest?.("#chat-input")) continue;
      _applyEmojiDirect(el);
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

function initEmojiPicker() {
  if (document.getElementById("emoji-hover-popup")) return;

  // ── Shared helpers ──

  // Render every category as a continuous scrollable list with section headers
  function _renderAllEmojis(bodyEl) {
    bodyEl.innerHTML = EMOJI_CATEGORIES.map((cat, i) =>
      `<div class="emoji-section" data-section="${i}">` +
      `<div class="emoji-section-label">${cat.name}</div>` +
      `<div class="emoji-section-grid">` +
      cat.emojis.map(e => `<button class="emoji-cell" data-emoji="${escapeAttr(e)}">${_emojiImgHtml(e)}</button>`).join("") +
      `</div></div>`
    ).join("");
  }

  // Bind category tabs so they scroll to the matching section;
  // also update active tab on scroll.
  function _bindTabNav(tabsEl, bodyEl) {
    tabsEl.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-cat]");
      if (!tab) return;
      const section = bodyEl.querySelector(`[data-section="${tab.dataset.cat}"]`);
      if (section) bodyEl.scrollTop = section.offsetTop;
      tabsEl.querySelectorAll(".emoji-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
    });
    bodyEl.addEventListener("scroll", () => {
      const sections = bodyEl.querySelectorAll(".emoji-section");
      if (!sections.length) return;
      let activeIdx = 0;
      sections.forEach(s => {
        if (s.offsetTop <= bodyEl.scrollTop + 20) activeIdx = +s.dataset.section;
      });
      tabsEl.querySelectorAll(".emoji-tab").forEach(t => {
        t.classList.toggle("active", +t.dataset.cat === activeIdx);
      });
    }, { passive: true });
  }

  // ── Hover popup (mini dock — identical layout, no search, disappears on mouse leave) ──
  const hoverPopup = document.createElement("div");
  hoverPopup.id = "emoji-hover-popup";
  hoverPopup.className = "emoji-hover-popup";
  hoverPopup.style.display = "none";

  const hpTabsHtml = EMOJI_CATEGORIES.map((c, i) =>
    `<button class="emoji-tab${i === 0 ? " active" : ""}" data-cat="${i}" title="${c.name}">${_emojiImgHtml(c.icon)}</button>`
  ).join("");
  hoverPopup.innerHTML = `
    <div class="emoji-dock-header">
      <div class="emoji-tabs" id="emoji-hp-tabs">${hpTabsHtml}</div>
    </div>
    <div class="emoji-hover-body" id="emoji-hover-body"></div>
  `;
  document.body.appendChild(hoverPopup);
  _renderAllEmojis(document.getElementById("emoji-hover-body"));
  _bindTabNav(
    document.getElementById("emoji-hp-tabs"),
    document.getElementById("emoji-hover-body")
  );

  hoverPopup.addEventListener("mousedown", e => e.preventDefault());
  hoverPopup.addEventListener("mouseenter", () => clearTimeout(_emojiHoverTimer));
  hoverPopup.addEventListener("mouseleave", () => {
    _emojiHoverTimer = setTimeout(() => { hoverPopup.style.display = "none"; }, 200);
  });
  hoverPopup.addEventListener("click", e => {
    const cell = e.target.closest("[data-emoji]");
    if (!cell) return;
    _emojiInsert(cell.dataset.emoji);
  });

  // ── Docked panel ──
  const dock = document.createElement("div");
  dock.id = "emoji-dock";
  dock.className = "emoji-dock";
  dock.style.display = "none";

  const dockTabsHtml = EMOJI_CATEGORIES.map((c, i) =>
    `<button class="emoji-tab${i === 0 ? " active" : ""}" data-cat="${i}" title="${c.name}">${_emojiImgHtml(c.icon)}</button>`
  ).join("");
  dock.innerHTML = `
    <div class="emoji-dock-header">
      <div class="emoji-tabs" id="emoji-dock-tabs">${dockTabsHtml}</div>
      <button class="emoji-dock-close" id="emoji-dock-close" title="Close">✕</button>
    </div>
    <div class="emoji-search-wrap">
      <input class="emoji-search" id="emoji-search" type="text"
             placeholder="Search emoji…" autocomplete="off" spellcheck="false">
    </div>
    <div class="emoji-dock-body" id="emoji-dock-body"></div>
  `;
  document.body.appendChild(dock);

  const dockBodyEl = document.getElementById("emoji-dock-body");
  const dockTabsEl = document.getElementById("emoji-dock-tabs");
  _renderAllEmojis(dockBodyEl);
  _bindTabNav(dockTabsEl, dockBodyEl);

  dock.addEventListener("mousedown", e => {
    if (!e.target.closest(".emoji-search")) e.preventDefault();
  });
  dock.addEventListener("click", e => {
    const cell = e.target.closest(".emoji-cell[data-emoji]");
    if (cell) {
      _emojiInsert(cell.dataset.emoji);
      setTimeout(() => document.getElementById("chat-input")?.focus(), 0);
    }
  });

  // Search
  dock.querySelector(".emoji-search").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) {
      _renderAllEmojis(dockBodyEl);
      dockBodyEl.scrollTop = 0;
      dockTabsEl.querySelectorAll(".emoji-tab").forEach((t, i) =>
        t.classList.toggle("active", i === 0)
      );
      return;
    }
    const results = _EMOJI_SEARCH.filter(({ n }) => n.includes(q));
    dockBodyEl.innerHTML = results.length
      ? `<div class="emoji-section-grid">${results.map(({ e }) =>
          `<button class="emoji-cell" data-emoji="${escapeAttr(e)}">${_emojiImgHtml(e)}</button>`).join("")}</div>`
      : `<div class="emoji-no-results">Nothing found for "${q}"</div>`;
  });

  document.getElementById("emoji-dock-close").addEventListener("click", () => {
    dock.style.display = "none";
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && dock.style.display !== "none") dock.style.display = "none";
  });
  window.addEventListener("resize", () => {
    if (dock.style.display !== "none") _positionEmojiDock();
  });
}

function setupEmojiBtn() {
  const btn = document.getElementById("emoji-btn");
  if (!btn) return;
  const hoverPopup = document.getElementById("emoji-hover-popup");
  const dock = document.getElementById("emoji-dock");
  if (!hoverPopup || !dock) return;

  btn.onmouseenter = () => {
    clearTimeout(_emojiHoverTimer);
    if (dock.style.display !== "none") return;
    hoverPopup.style.display = "flex";
    const r = btn.getBoundingClientRect();
    const pw = hoverPopup.offsetWidth || 288;
    const ph = hoverPopup.offsetHeight || 340;
    // Button is on the right — right-align popup with button right edge
    let left = r.right - pw;
    if (left < 8) left = 8;
    let top = r.top - ph - 8;
    if (top < 8) top = r.bottom + 8;
    hoverPopup.style.left = `${left}px`;
    hoverPopup.style.top  = `${top}px`;
  };

  btn.onmouseleave = () => {
    _emojiHoverTimer = setTimeout(() => { hoverPopup.style.display = "none"; }, 200);
  };

  btn.onclick = (e) => {
    e.stopPropagation();
    hoverPopup.style.display = "none";
    clearTimeout(_emojiHoverTimer);
    if (dock.style.display !== "none") {
      dock.style.display = "none";
    } else {
      // Reset search when opening
      const searchEl = document.getElementById("emoji-search");
      if (searchEl) { searchEl.value = ""; searchEl.dispatchEvent(new Event("input")); }
      dock.style.display = "flex";
      _positionEmojiDock();
    }
  };
}

// ─── Init ───

initFormatMenu();
initEmojiPicker();
_setupGlobalEmojiObserver();
initMessageContextMenu();
initLightbox();

window.addEventListener("auth:logout", () => {
  stopNotifPolling();
  disconnectWs();
  currentUser = null;
  navigate("login");
});

if (auth.isLoggedIn()) {
  auth.me().then((user) => {
    currentUser = user;
    connectWs();
    startNotifPolling();
  }).catch(() => {});
}

navigate(auth.isLoggedIn() ? "feed" : "login");
