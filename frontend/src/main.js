import { auth, posts, users, messenger, notifications, media } from "./api.js";

// ─── Simple SPA router ───

let currentUser = null; // cached /me response
let ws = null; // WebSocket connection
let currentChatId = null; // currently open chat
let lastReadByChat = {}; // { chatId: { userId: messageId } }
let notifPollTimer = null;

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
    case "error":
      console.warn("[WS] Error:", msg.message);
      toast(msg.message || "Server error");
      break;
    case "key_bundle":
      // Reserved for E2E — ignore for now
      break;
    default:
      console.log("[WS] Unhandled:", msg);
  }
}

function handleNewMessage(msg) {
  if (currentChatId === msg.chat_id) {
    appendMessage(msg);
    scrollMessagesDown();
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

  messagesEl.querySelectorAll(".read-receipt").forEach((el) => el.remove());

  const readers = lastReadByChat[currentChatId] || {};
  const otherReaderIds = Object.keys(readers).filter((uid) => uid !== currentUser.id);
  if (otherReaderIds.length === 0) return;

  const myMsgs = Array.from(messagesEl.querySelectorAll(".message-mine"));
  if (myMsgs.length === 0) return;

  const lastMine = myMsgs[myMsgs.length - 1];
  const receipt = document.createElement("div");
  receipt.className = "read-receipt";
  receipt.textContent = "Read";
  lastMine.appendChild(receipt);
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

// ─── Chats ───

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
      return `
        <div class="chat-item${active}" data-chat-id="${chat.id}">
          <div class="chat-name">${escapeHtml(name)}</div>
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

async function openChat(chatId) {
  currentChatId = chatId;

  document.querySelectorAll(".chat-item").forEach((el) => {
    el.classList.toggle("chat-item-active", el.dataset.chatId === chatId);
  });

  const mainEl = document.getElementById("chat-main");
  mainEl.innerHTML = `
    <div class="chat-header" id="chat-header">Loading...</div>
    <div class="chat-messages" id="chat-messages">
      <div style="padding:20px;text-align:center;color:var(--text-muted)">Loading messages...</div>
    </div>
    <div id="typing-indicator" class="typing-indicator"></div>
    <form class="chat-input" id="chat-input-form">
      <div id="chat-input" class="chat-input-field" contenteditable="true" data-placeholder="Type a message..."></div>
      <button class="btn" type="submit">Send</button>
    </form>
  `;

  try {
    const chats = await messenger.listChats();
    const chat = chats.find((c) => c.id === chatId);

    if (chat) {
      const name = getChatDisplayName(chat);
      const memberCount = chat.is_group ? ` (${chat.members.length} members)` : "";
      document.getElementById("chat-header").innerHTML = `
        <strong>${escapeHtml(name)}</strong>
        <span style="color:var(--text-muted);font-size:13px">${memberCount}</span>
      `;
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
      messagesEl.innerHTML = ordered.map((m) => renderMessage(m)).join("");
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

  const inputEl = document.getElementById("chat-input");

  document.getElementById("chat-input-form").onsubmit = (e) => {
    e.preventDefault();
    if (!inputEl.textContent.trim()) return;

    sendWs({
      type: "send_message",
      chat_id: chatId,
      encrypted_content: serializeRichText(inputEl),
      nonce: "test-nonce",
      message_type: "text",
    });

    inputEl.innerHTML = "";
    inputEl.focus();
  };

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("chat-input-form").requestSubmit();
    }
  });

  let typingTimeout = null;
  inputEl.oninput = () => {
    if (!typingTimeout) {
      sendWs({ type: "typing", chat_id: chatId });
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      typingTimeout = null;
    }, 2000);
  };
}

function renderMessage(msg) {
  const isMe = currentUser && msg.sender_id === currentUser.id;
  const time = new Date(msg.created_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `
    <div class="message ${isMe ? "message-mine" : "message-theirs"}" data-message-id="${msg.id}">
      ${!isMe ? `<div class="message-sender">${escapeHtml(msg.sender_username)}</div>` : ""}
      <div class="message-bubble ${isMe ? "bubble-mine" : "bubble-theirs"}">
        <div class="message-text">${renderRichText(msg.encrypted_content)}</div>
        <div class="message-time">${time}</div>
      </div>
    </div>
  `;
}

function appendMessage(msg) {
  const messagesEl = document.getElementById("chat-messages");
  if (!messagesEl) return;

  const placeholder = messagesEl.querySelector("[style*='text-align:center']");
  if (placeholder) placeholder.remove();

  messagesEl.insertAdjacentHTML("beforeend", renderMessage(msg));
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

// ─── Rich text: serialization / rendering ───

function serializeRichText(el) {
  const spans = [];

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) spans.push({ t: node.textContent, s: null });
    } else if (node.nodeName === "BR") {
      spans.push({ t: "\n", s: null });
    } else if (node.nodeName === "SPAN" || node.nodeName === "STRONG" || node.nodeName === "B") {
      const s = node.dataset && node.dataset.style
        ? node.dataset.style
        : (node.nodeName === "STRONG" || node.nodeName === "B" ? "bold" : null);
      spans.push({ t: node.textContent, s });
    } else {
      node.childNodes.forEach(walk);
    }
  }

  el.childNodes.forEach(walk);

  // Merge consecutive unstyled runs
  const merged = [];
  for (const sp of spans) {
    const prev = merged[merged.length - 1];
    if (prev && prev.s === null && sp.s === null) {
      prev.t += sp.t;
    } else {
      merged.push({ ...sp });
    }
  }
  return JSON.stringify(merged);
}

function extractPlainText(content) {
  try {
    const spans = JSON.parse(content);
    if (Array.isArray(spans)) return spans.map((s) => s.t).join("");
  } catch {}
  return content;
}

function renderRichText(content) {
  try {
    const spans = JSON.parse(content);
    if (!Array.isArray(spans)) return escapeHtml(content);
    return spans
      .map(({ t, s }) => {
        if (!s) return escapeHtml(t).replace(/\n/g, "<br>");
        switch (s) {
          case "bold":      return `<strong>${escapeHtml(t)}</strong>`;
          case "underline": return `<span class="text-underline">${escapeHtml(t)}</span>`;
          case "strike":    return `<s>${escapeHtml(t)}</s>`;
          case "mono":      return `<code class="text-mono">${escapeHtml(t)}</code>`;
          case "rainbow":   return `<span class="text-rainbow">${renderRainbowChars(t)}</span>`;
          case "wave":      return `<span class="text-wave">${renderWaveChars(t)}</span>`;
          case "type":      return renderTypeChars(t);
          default:          return escapeHtml(t);
        }
      })
      .join("");
  } catch {
    return escapeHtml(content);
  }
}

function renderRainbowChars(text) {
  return [...text]
    .map((ch, i) =>
      ch === " "
        ? " "
        : `<span style="--i:${i}">${escapeHtml(ch)}</span>`
    )
    .join("");
}

function renderWaveChars(text) {
  return [...text]
    .map((ch, i) =>
      ch === " "
        ? " "
        : `<span style="--i:${i}">${escapeHtml(ch)}</span>`
    )
    .join("");
}

function renderTypeChars(text) {
  const chars = [...text];
  const delay = Math.min(60, 1800 / Math.max(chars.length, 1));
  return chars
    .map((ch, i) =>
      `<span class="type-char" style="animation-delay:${Math.round(i * delay)}ms">${escapeHtml(ch)}</span>`
    )
    .join("");
}

// ─── Format menu ───

function initFormatMenu() {
  if (document.getElementById("fmt-menu")) return;

  const menu = document.createElement("div");
  menu.id = "fmt-menu";
  menu.className = "fmt-menu";
  menu.style.display = "none";
  menu.innerHTML = `
    <button class="fmt-btn" data-fmt="bold"    title="Bold"><b>B</b></button>
    <button class="fmt-btn" data-fmt="underline" title="Underline"><u>U</u></button>
    <button class="fmt-btn" data-fmt="strike"  title="Strikethrough"><s>S</s></button>
    <button class="fmt-btn" data-fmt="mono"    title="Monospace">{ }</button>
    <span class="fmt-sep"></span>
    <button class="fmt-btn" data-fmt="rainbow" title="Rainbow">🌈</button>
    <button class="fmt-btn" data-fmt="wave"    title="Wave">〰</button>
    <button class="fmt-btn" data-fmt="type"    title="Typewriter">⌨</button>
  `;
  document.body.appendChild(menu);

  // Prevent mousedown from stealing selection focus
  menu.addEventListener("mousedown", (e) => e.preventDefault());
  menu.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-fmt]");
    if (btn) applyFormat(btn.dataset.fmt);
  });

  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    const inputEl = document.getElementById("chat-input");
    if (!inputEl || !sel || sel.isCollapsed || !sel.rangeCount) {
      hideFmtMenu();
      return;
    }
    try {
      const range = sel.getRangeAt(0);
      if (!inputEl.contains(range.commonAncestorContainer)) {
        hideFmtMenu();
        return;
      }
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) { hideFmtMenu(); return; }

      const menuW = menu.offsetWidth || 280;
      const left = Math.max(8, Math.min(
        rect.left + rect.width / 2 - menuW / 2,
        window.innerWidth - menuW - 8
      ));
      menu.style.left = `${left}px`;
      menu.style.top  = `${rect.top - 50 + window.scrollY}px`;
      menu.style.display = "flex";
    } catch {
      hideFmtMenu();
    }
  });
}

function hideFmtMenu() {
  const menu = document.getElementById("fmt-menu");
  if (menu) menu.style.display = "none";
}

function applyFormat(fmt) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;

  const selectedText = sel.toString();
  if (!selectedText) return;

  const range = sel.getRangeAt(0);

  let node;
  if (fmt === "bold") {
    node = document.createElement("strong");
    node.dataset.style = "bold";
  } else {
    node = document.createElement("span");
    node.dataset.style = fmt;
  }
  node.textContent = selectedText;

  // Visual preview styles inside the composer
  switch (fmt) {
    case "underline": node.style.textDecoration = "underline"; break;
    case "strike":    node.style.textDecoration = "line-through"; break;
    case "mono":      node.style.fontFamily = "monospace"; node.style.fontSize = "0.9em"; break;
    case "rainbow":   node.classList.add("text-rainbow"); break;
    case "wave":      node.style.color = "var(--accent)"; node.style.borderBottom = "2px dotted var(--accent)"; break;
    case "type":      node.style.borderBottom = "1px dashed var(--text-muted)"; break;
  }

  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  sel.removeAllRanges();
  sel.addRange(range);

  hideFmtMenu();
  document.getElementById("chat-input")?.focus();
}

// ─── Helpers ───

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

// ─── Init ───

initFormatMenu();

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
