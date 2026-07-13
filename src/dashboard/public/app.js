"use strict";

const $ = sel => document.querySelector(sel);

const loginScreen  = $("#login-screen");
const loginForm    = $("#login-form");
const loginCard    = $(".login-card");
const loginError   = $("#login-error");
const passwordInput = $("#password-input");
const dashboard     = $("#dashboard");
const channelsEl    = $("#channels");
const emptyStateEl  = $("#empty-state");
const template       = $("#channel-template");

const FALLBACK_ART =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E%3Crect width='100%25' height='100%25' fill='%23191f16'/%3E%3C/svg%3E";

let socket = null;
const cards = new Map(); // guildId -> DOM node

// ─── Auth flow ──────────────────────────────────────────────────────────
async function apiFetch(url, options = {}) {
  const res = await fetch(url, { ...options, credentials: "same-origin" });
  if (res.status === 401) {
    showLogin();
    throw new Error("unauthenticated");
  }
  return res;
}

function showLogin() {
  if (socket) { socket.disconnect(); socket = null; }
  dashboard.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  passwordInput.focus();
}

function showDashboard() {
  loginScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
  connectSocket();
}

loginForm.addEventListener("submit", async e => {
  e.preventDefault();
  loginError.textContent = "";
  const btn = $("#login-btn");
  btn.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: passwordInput.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      loginError.textContent = data.error || "Login failed.";
      loginCard.classList.remove("shake"); void loginCard.offsetWidth; loginCard.classList.add("shake");
      passwordInput.value = "";
      return;
    }
    passwordInput.value = "";
    showDashboard();
  } catch {
    loginError.textContent = "Couldn't reach the server.";
  } finally {
    btn.disabled = false;
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

// ─── Live updates ───────────────────────────────────────────────────────
function connectSocket() {
  if (socket) return;
  socket = io({ withCredentials: true });
  socket.on("stats", renderStats);
  socket.on("players", renderPlayers);
  socket.on("connect_error", () => showLogin());
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function renderStats(stats) {
  $("#online-led").className = "led " + (stats.online ? "on" : "off");
  $("#stat-ping").textContent   = stats.ping >= 0 ? `${stats.ping}ms` : "—";
  $("#stat-guilds").textContent = stats.guildCount;
  $("#stat-live").textContent   = `${stats.activePlayers}/${stats.totalPlayers}`;
  $("#stat-uptime").textContent = formatUptime(stats.uptimeMs);
}

function renderPlayers(players) {
  const seen = new Set();

  for (const p of players) {
    seen.add(p.guildId);
    let card = cards.get(p.guildId);
    if (!card) {
      card = template.content.firstElementChild.cloneNode(true);
      channelsEl.appendChild(card);
      cards.set(p.guildId, card);
      wireCardControls(card, p.guildId);
    }
    updateCard(card, p);
  }

  // Remove cards for players that no longer exist
  for (const [guildId, card] of cards) {
    if (!seen.has(guildId)) {
      card.remove();
      cards.delete(guildId);
    }
  }

  emptyStateEl.classList.toggle("hidden", players.length > 0);
  channelsEl.classList.toggle("hidden", players.length === 0);
}

function updateCard(card, p) {
  card.dataset.guildId = p.guildId;
  card.querySelector(".channel-tag").textContent = p.guildId.slice(-4).padStart(4, "0");
  card.querySelector(".channel-name").textContent = p.guildName;
  card.querySelector(".channel-listeners").textContent =
    `${p.channelName} · ${p.listeners} listening`;

  const pill = card.querySelector(".channel-pill");
  pill.className = "channel-pill " + (p.playing && !p.paused ? "playing" : p.paused ? "paused" : "");
  pill.textContent = p.playing && !p.paused ? "on air" : p.paused ? "paused" : p.afk ? "afk" : "idle";

  const vu = card.querySelector(".vu-meter");
  vu.classList.toggle("is-live", p.playing && !p.paused);

  const t = p.current;
  card.querySelector(".artwork").src = t?.artwork || FALLBACK_ART;
  card.querySelector(".track-title").textContent = t ? t.title : "Nothing playing";
  card.querySelector(".track-author").textContent = t ? t.author : "";
  card.querySelector(".track-source").textContent = t ? t.source : "";
  card.querySelector(".track-requester").textContent = t ? `req. by ${t.requester}` : "";

  const pct = t && t.duration ? Math.min(100, (p.position / t.duration) * 100) : 0;
  card.querySelector(".progress-fill").style.width = `${pct}%`;
  card.querySelector(".progress-elapsed").textContent = p.positionFmt;
  card.querySelector(".progress-duration").textContent = t ? t.durationFmt : "0:00";

  const playPauseBtn = card.querySelector(".act-playpause");
  playPauseBtn.textContent = p.paused ? "▶" : "⏸";
  playPauseBtn.title = p.paused ? "Resume" : "Pause";

  const volInput = card.querySelector(".act-volume");
  if (document.activeElement !== volInput) volInput.value = p.volume;
  card.querySelector(".fader-value").textContent = p.volume;

  for (const btn of card.querySelectorAll(".act-loop")) {
    btn.classList.toggle("is-active", btn.dataset.mode === p.repeatMode);
  }

  card.querySelector(".queue-count").textContent = p.queueLength;
  const queueList = card.querySelector(".queue-list");
  queueList.innerHTML = "";
  p.queue.forEach((track, i) => {
    const li = document.createElement("li");
    const num = document.createElement("span");
    num.className = "qi-num";
    num.textContent = `${i + 1}.`;
    const title = document.createElement("span");
    title.className = "qi-title";
    title.textContent = track.title;
    const dur = document.createElement("span");
    dur.textContent = track.durationFmt;
    li.append(num, title, dur);
    queueList.appendChild(li);
  });
}

function wireCardControls(card, guildId) {
  const post = (action, body) =>
    apiFetch(`/api/players/${guildId}/${action}`, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => {});

  card.querySelector(".act-playpause").addEventListener("click", () => {
    const isPaused = card.querySelector(".act-playpause").textContent === "▶";
    post(isPaused ? "resume" : "pause");
  });
  card.querySelector(".act-skip").addEventListener("click", () => post("skip"));
  card.querySelector(".act-stop").addEventListener("click", () => post("stop"));
  card.querySelector(".act-disconnect").addEventListener("click", () => {
    if (confirm("Disconnect this player and clear its queue?")) post("disconnect");
  });

  const volInput = card.querySelector(".act-volume");
  volInput.addEventListener("input", () => {
    card.querySelector(".fader-value").textContent = volInput.value;
  });
  volInput.addEventListener("change", () => post("volume", { level: Number(volInput.value) }));

  for (const btn of card.querySelectorAll(".act-loop")) {
    btn.addEventListener("click", () => post("loop", { mode: btn.dataset.mode }));
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────
(async function init() {
  try {
    const res = await fetch("/api/me");
    const data = await res.json();
    if (data.authenticated) showDashboard();
    else showLogin();
  } catch {
    showLogin();
  }
})();
