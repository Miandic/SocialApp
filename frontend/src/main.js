import { auth, posts, users, messenger } from "./api.js";

// ─── Simple SPA router ───

let currentUser = null; // cached /me response
let ws = null; // WebSocket connection
let currentChatId = null; // currently open chat

const routes = {
  login: renderLogin,
  register: renderRegister,
  feed: renderFeed,
  profile: renderProfile,
  chats: renderChats,
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
      <div class="logo">Diffract</div>
      <nav class="nav-links">
        <a data-page="feed">Feed</a>
        <a data-page="chats">Chats</a>
        <a data-page="profile">Profile</a>
        <a id="logout-btn">Logout</a>
      </nav>
    `;
    header.querySelector("#logout-btn").onclick = async () => {
      disconnectWs();
      try { await auth.logout(); } catch {}
      auth.clearTokens();
      currentUser = null;
      navigate("login");
    };
    header.querySelectorAll("[data-page]").forEach((a) => {
      a.onclick = () => navigate(a.dataset.page);
    });
  } else {
    header.innerHTML = `<div class="logo">Diffract</div>`;
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
    // Auto-reconnect after 3s if still logged in
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
    ws.onclose = null; // prevent auto-reconnect
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
    default:
      console.log("[WS] Unhandled:", msg);
  }
}

function handleNewMessage(msg) {
  // If we're viewing this chat, append the message
  if (currentChatId === msg.chat_id) {
    appendMessage(msg);
    scrollMessagesDown();
  }

  // Update chat list preview if visible
  const chatItem = document.querySelector(`[data-chat-id="${msg.chat_id}"]`);
  if (chatItem) {
    const preview = chatItem.querySelector(".chat-preview");
    if (preview) {
      preview.textContent = `${msg.sender_username}: ${msg.encrypted_content}`;
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
        <button class="btn btn-sm" type="submit">Post</button>
      </form>
      <div id="feed-list"></div>
    </div>
  `;

  document.getElementById("post-form").onsubmit = async (e) => {
    e.preventDefault();
    const content = new FormData(e.target).get("content");
    if (!content.trim()) return;
    try {
      await posts.create({ content });
      e.target.reset();
      loadFeed();
    } catch (err) {
      alert(err.message || "Failed to post");
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
  return `
    <div class="card" data-post-id="${post.id}">
      <div class="post-author">
        <strong>${post.author.display_name || post.author.username}</strong>
        <span>@${post.author.username} · ${time}</span>
      </div>
      <div class="post-content">${escapeHtml(post.content)}</div>
      <div class="post-actions">
        <button data-action="like" data-id="${post.id}">
          ${post.is_liked ? "Unlike" : "Like"} (${post.like_count})
        </button>
      </div>
    </div>
  `;
}

function attachPostActions(container) {
  container.querySelectorAll("[data-action='like']").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const isLiked = btn.textContent.trim().startsWith("Unlike");
      try {
        if (isLiked) await posts.unlike(id);
        else await posts.like(id);
        loadFeed();
      } catch {}
    };
  });
}

// ─── Profile ───

async function renderProfile(container) {
  try {
    if (!currentUser) currentUser = await auth.me();
    const profile = await users.profile(currentUser.username);
    container.innerHTML = `
      <div class="card">
        <h2>${profile.display_name || profile.username}</h2>
        <p style="color:var(--text-muted)">@${profile.username}</p>
        ${profile.bio ? `<p style="margin-top:8px">${escapeHtml(profile.bio)}</p>` : ""}
        <div style="display:flex;gap:20px;margin-top:12px;color:var(--text-muted);font-size:14px">
          <span><strong>${profile.followers_count}</strong> followers</span>
          <span><strong>${profile.following_count}</strong> following</span>
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="error-msg">${err.message || "Failed to load profile"}</div>`;
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

  // Ensure WebSocket is connected
  connectWs();

  // Load chat list
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
        ? `${chat.last_message.sender_username}: ${chat.last_message.encrypted_content}`
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
  // DM: show the other person's name
  const other = chat.members.find((m) => m.user_id !== currentUser.id);
  if (other) return other.display_name || other.username;
  return "Chat";
}

async function openChat(chatId) {
  currentChatId = chatId;

  // Highlight active chat in sidebar
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
      <input type="text" id="chat-input" placeholder="Type a message..." autocomplete="off" />
      <button class="btn" type="submit">Send</button>
    </form>
  `;

  // Load chat info and messages
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
      // Messages come newest-first from API, reverse for display
      messagesEl.innerHTML = messages
        .reverse()
        .map((m) => renderMessage(m))
        .join("");
      scrollMessagesDown();
    }
  } catch (err) {
    document.getElementById("chat-messages").innerHTML = `
      <div class="error-msg" style="padding:20px">${err.message || "Failed to load messages"}</div>
    `;
  }

  // Send message
  document.getElementById("chat-input-form").onsubmit = (e) => {
    e.preventDefault();
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text) return;

    // For testing — send plaintext as "encrypted_content".
    // In production this would be actual E2E encrypted ciphertext.
    sendWs({
      type: "send_message",
      chat_id: chatId,
      encrypted_content: text,
      nonce: "test-nonce", // placeholder
      message_type: "text",
    });

    input.value = "";
    input.focus();
  };

  // Typing indicator on input
  let typingTimeout = null;
  document.getElementById("chat-input").oninput = () => {
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
    <div class="message ${isMe ? "message-mine" : "message-theirs"}">
      ${!isMe ? `<div class="message-sender">${escapeHtml(msg.sender_username)}</div>` : ""}
      <div class="message-bubble ${isMe ? "bubble-mine" : "bubble-theirs"}">
        <div class="message-text">${escapeHtml(msg.encrypted_content)}</div>
        <div class="message-time">${time}</div>
      </div>
    </div>
  `;
}

function appendMessage(msg) {
  const messagesEl = document.getElementById("chat-messages");
  if (!messagesEl) return;

  // Clear "no messages" placeholder if present
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
      <div class="form-group">
        <label>Username</label>
        <input id="new-chat-username" placeholder="Enter username to chat with" />
      </div>
      <div class="error-msg" id="new-chat-error"></div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn" id="start-dm-btn">Start DM</button>
        <button class="btn btn-outline" id="cancel-chat-btn">Cancel</button>
      </div>
    </div>
  `;

  document.body.appendChild(dialog);

  document.getElementById("dialog-overlay").onclick = () => dialog.remove();
  document.getElementById("cancel-chat-btn").onclick = () => dialog.remove();

  document.getElementById("start-dm-btn").onclick = async () => {
    const username = document.getElementById("new-chat-username").value.trim();
    const errorEl = document.getElementById("new-chat-error");

    if (!username) {
      errorEl.textContent = "Enter a username";
      return;
    }

    if (currentUser && username === currentUser.username) {
      errorEl.textContent = "You can't chat with yourself";
      return;
    }

    try {
      // First look up the user to get their ID
      const profile = await users.profile(username);

      // Create or find existing DM
      const chat = await messenger.createChat({
        member_ids: [profile.id],
        is_group: false,
      });

      dialog.remove();
      await loadChatList();
      openChat(chat.id);
    } catch (err) {
      errorEl.textContent = err.message || "User not found";
    }
  };

  // Enter to submit
  document.getElementById("new-chat-username").onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("start-dm-btn").click();
    }
  };

  document.getElementById("new-chat-username").focus();
}

// ─── Helpers ───

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ─── Init ───

window.addEventListener("auth:logout", () => {
  disconnectWs();
  currentUser = null;
  navigate("login");
});

// On load: if logged in, fetch user and connect WS
if (auth.isLoggedIn()) {
  auth.me().then((user) => {
    currentUser = user;
    connectWs();
  }).catch(() => {});
}

navigate(auth.isLoggedIn() ? "feed" : "login");
