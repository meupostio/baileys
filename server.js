/**
 * Baileys multi-sessão + resolução de @lid -> número real
 * Env: PORT, API_KEY, WEBHOOK_URL, AUTH_DIR
 */
const express = require("express");
const fs = require("fs");
const path = require("path");
const P = require("pino");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "auth_info");

const app = express();
app.use(express.json({ limit: "10mb" }));
const logger = P({ level: "info" });

app.use((req, res, next) => {
  if (req.path === "/") return next();
  if (!API_KEY) return next();
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

/** sessionId -> { sock, status, qr, phone, lidMap: Map, saveTimer } */
const sessions = new Map();
const onlyDigits = (v) => String(v || "").split("@")[0].replace(/[^0-9]/g, "");
const lidFilePath = (id) => path.join(AUTH_DIR, id, "lid-map.json");

function loadLidMap(sessionId) {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(lidFilePath(sessionId), "utf8"))));
  } catch { return new Map(); }
}

function scheduleSaveLidMap(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  clearTimeout(s.saveTimer);
  s.saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(lidFilePath(sessionId)), { recursive: true });
      fs.writeFileSync(lidFilePath(sessionId), JSON.stringify(Object.fromEntries(s.lidMap)));
    } catch (e) { logger.warn({ e: e.message }, "[lid] save failed"); }
  }, 1500);
}

/** guarda o par lid -> telefone (descarta os 15 dígitos do @lid) */
function learnLid(sessionId, lidRaw, phoneRaw) {
  const lid = onlyDigits(lidRaw);
  const phone = onlyDigits(phoneRaw);
  if (!lid || !phone || lid === phone) return;
  if (phone.length < 10 || phone.length > 14) return;
  const s = sessions.get(sessionId);
  if (!s || s.lidMap.get(lid) === phone) return;
  s.lidMap.set(lid, phone);
  scheduleSaveLidMap(sessionId);
  logger.info({ sessionId, lid, phone }, "[lid] learned");
  postWebhook({ event: "lid-map", sessionId, entries: [{ lid, phone }] });
}

/** cache -> Baileys lidMapping -> store de contatos */
async function resolveLid(sessionId, lidRaw) {
  const lid = onlyDigits(lidRaw);
  const s = sessions.get(sessionId);
  if (!lid || !s) return null;

  const cached = s.lidMap.get(lid);
  if (cached) return cached;

  try {
    const mapping = s.sock?.signalRepository?.lidMapping;
    if (mapping?.getPNForLID) {
      const digits = onlyDigits(await mapping.getPNForLID(`${lid}@lid`));
      if (digits) { learnLid(sessionId, lid, digits); return digits; }
    }
  } catch (e) { logger.warn({ e: e.message }, "[lid] getPNForLID failed"); }

  try {
    for (const [jid, c] of Object.entries(s.sock?.store?.contacts || {})) {
      if (onlyDigits(jid) === lid || onlyDigits(c?.lid) === lid) {
        const digits = onlyDigits(c?.id || c?.jid || jid);
        if (digits && digits.length <= 14) { learnLid(sessionId, lid, digits); return digits; }
      }
    }
  } catch {}
  return null;
}

async function postWebhook(body) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) { logger.warn({ e: e.message }, "[webhook] failed"); }
}

async function startSession(sessionId) {
  let s = sessions.get(sessionId);
  if (s?.sock && s.status === "connected") return s;

  const dir = path.join(AUTH_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: "silent" }),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  s = s || { lidMap: loadLidMap(sessionId) };
  s.sock = sock; s.status = "connecting"; s.qr = null;
  sessions.set(sessionId, s);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      s.qr = await QRCode.toDataURL(qr);
      s.status = "qr";
      postWebhook({ event: "status-updated", sessionId, status: "qr_ready", qrcode: s.qr });
    }
    if (connection === "open") {
      s.status = "connected"; s.qr = null; s.phone = onlyDigits(sock.user?.id);
      if (sock.user?.lid) learnLid(sessionId, sock.user.lid, s.phone);
      postWebhook({ event: "status-updated", sessionId, status: "connected", phone: s.phone });
      const entries = [...s.lidMap].map(([lid, phone]) => ({ lid, phone }));
      if (entries.length) postWebhook({ event: "lid-map", sessionId, entries });
    }
    if (connection === "close") {
      const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      s.status = loggedOut ? "logged_out" : "disconnected";
      postWebhook({ event: "status-updated", sessionId, status: s.status });
      if (!loggedOut) setTimeout(() => startSession(sessionId).catch(() => {}), 4000);
    }
  });

  const learnFromContacts = (list) => {
    for (const c of list || []) if (c?.lid && c?.id) learnLid(sessionId, c.lid, c.id);
  };
  sock.ev.on("contacts.upsert", learnFromContacts);
  sock.ev.on("contacts.set", (d) => learnFromContacts(d?.contacts));
  sock.ev.on("lid-mapping.update", (m) => {
    for (const [lid, pn] of Object.entries(m || {})) learnLid(sessionId, lid, pn);
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      const key = msg.key || {};
      const remoteJid = key.remoteJid || "";
      if (remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") continue;

      const lidCand = [remoteJid, key.participant, key.senderLid]
        .find((j) => String(j || "").endsWith("@lid"));
      const pnCand = [key.senderPn, key.remoteJidAlt, key.participantPn]
        .find((j) => String(j || "").endsWith("@s.whatsapp.net"));
      if (lidCand && pnCand) learnLid(sessionId, lidCand, pnCand);

      let phone = onlyDigits(pnCand || (remoteJid.endsWith("@lid") ? "" : remoteJid));
      if (!phone && lidCand) phone = (await resolveLid(sessionId, lidCand)) || "";

      postWebhook({
        event: key.fromMe ? "message-sent" : "message-received",
        sessionId,
        messageId: key.id,
        data: {
          key,
          message: msg.message,
          pushName: msg.pushName,
          fromMe: !!key.fromMe,
          messageTimestamp: msg.messageTimestamp,
          senderPn: key.senderPn || null,
          remoteJidAlt: key.remoteJidAlt || null,
          participantPn: key.participantPn || null,
          lid: lidCand ? onlyDigits(lidCand) : null,
          phone: phone || null,
        },
      });
    }
  });

  return s;
}

/* ------------------------------ rotas ------------------------------ */

app.get("/health", (_req, res) => {
  let known = 0;
  for (const s of sessions.values()) known += s.lidMap?.size || 0;
  res.json({ status: "ok", uptime: process.uptime(), sessions: sessions.size, knownContacts: known });
});

app.post("/create-session", async (req, res) => {
  const sessionId = req.body?.sessionId;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  try {
    const s = await startSession(sessionId);
    res.json({ sessionId, status: s.status, qrcode: s.qr || null, phone: s.phone || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/qrcode", (req, res) => {
  const s = sessions.get(req.query.sessionId);
  if (!s) return res.status(404).json({ error: "session not found" });
  res.json({ sessionId: req.query.sessionId, status: s.status, qrcode: s.qr || null, phone: s.phone || null });
});

app.post("/logout", async (req, res) => {
  const s = sessions.get(req.body?.sessionId);
  try { await s?.sock?.logout(); } catch {}
  res.json({ success: true });
});

app.delete("/session/:id", async (req, res) => {
  const sessionId = req.params.id;
  const s = sessions.get(sessionId);
  try { await s?.sock?.logout(); } catch {}
  try { s?.sock?.end?.(); } catch {}
  sessions.delete(sessionId);
  try { fs.rmSync(path.join(AUTH_DIR, sessionId), { recursive: true, force: true }); } catch {}
  const exists = fs.existsSync(path.join(AUTH_DIR, sessionId));
  res.json({ success: !exists, deleted: !exists, exists });
});

app.post("/send-message", async (req, res) => {
  const { sessionId, phone, jid, message } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s?.sock || s.status !== "connected") return res.status(409).json({ error: "session not connected" });
  let target = jid || phone || "";
  if (!String(target).includes("@")) target = `${onlyDigits(target)}@s.whatsapp.net`;
  try {
    const sent = await s.sock.sendMessage(target, { text: String(message ?? "") });
    res.json({ success: true, messageId: sent?.key?.id || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/lid-map", (req, res) => {
  const s = sessions.get(req.query.sessionId);
  if (!s) return res.json({ entries: [] });
  res.json({ entries: [...s.lidMap].map(([lid, phone]) => ({ lid, phone })) });
});

app.get("/resolve-lid", async (req, res) => {
  const phone = await resolveLid(req.query.sessionId, req.query.lid);
  res.json({ phone, jid: phone ? `${phone}@s.whatsapp.net` : null, source: phone ? "resolved" : "not_found" });
});

app.post("/resolve-lid", async (req, res) => {
  const { sessionId, lid, lids } = req.body || {};
  if (Array.isArray(lids)) {
    const entries = [];
    for (const l of lids) {
      const phone = await resolveLid(sessionId, l);
      if (phone) entries.push({ lid: onlyDigits(l), phone });
    }
    return res.json({ entries });
  }
  const phone = await resolveLid(sessionId, lid);
  res.json({ phone, jid: phone ? `${phone}@s.whatsapp.net` : null, source: phone ? "resolved" : "not_found" });
});

app.post("/on-whatsapp", async (req, res) => {
  const { sessionId, phone } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s?.sock) return res.json({ exists: false });
  try {
    const r = await s.sock.onWhatsApp(`${onlyDigits(phone)}@s.whatsapp.net`);
    res.json({ exists: !!r?.[0]?.exists, jid: r?.[0]?.jid || null, lid: r?.[0]?.lid || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => logger.info(`server on :${PORT}`));
