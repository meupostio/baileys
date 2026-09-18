/**
 * Baileys multi-sessão — versão corrigida (Render)
 *
 * Correções em relação à versão anterior:
 *  1. Credenciais e chaves de sessão gravadas no banco (tabela
 *     public.whatsapp_session_keys), não mais no disco temporário do Render.
 *  2. Uma única sessão por sessionId: mutex + encerramento do socket anterior,
 *     reconexão com espera crescente.
 *  3. getMessage: responde aos pedidos de reenvio do aparelho do contato
 *     (é o que destrava o "Aguardando mensagem").
 *  4. Bad MAC tratado por conversa: apaga só a sessão daquele contato.
 *  5. Webhook "session-error" avisa o CRM.
 *
 * Dependências novas: @supabase/supabase-js
 *   npm i @supabase/supabase-js
 *
 * Env: PORT, API_KEY, WEBHOOK_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *      (AUTH_DIR não é mais usado)
 */
const express = require("express");
const P = require("pino");
const QRCode = require("qrcode");
const { createClient } = require("@supabase/supabase-js");
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON,
  proto,
} = require("@whiskeysockets/baileys");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const logger = P({ level: "info" });

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  logger.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes — sessões não serão persistidas");
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const app = express();
app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  if (req.path === "/") return next();
  if (!API_KEY) return next();
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

const onlyDigits = (v) => String(v || "").split("@")[0].replace(/[^0-9]/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------- auth state persistido no banco ---------------------- */

const encode = (value) => JSON.parse(JSON.stringify(value, BufferJSON.replacer));
const decode = (value) => JSON.parse(JSON.stringify(value), BufferJSON.reviver);

async function dbRead(sessionId, key) {
  const { data, error } = await db
    .from("whatsapp_session_keys")
    .select("value")
    .eq("session_id", sessionId)
    .eq("key", key)
    .maybeSingle();
  if (error) {
    logger.warn({ sessionId, key, error: error.message }, "[auth] read failed");
    return null;
  }
  return data ? decode(data.value) : null;
}

async function dbWriteMany(sessionId, rows) {
  if (!rows.length) return;
  const { error } = await db
    .from("whatsapp_session_keys")
    .upsert(rows, { onConflict: "session_id,key" });
  if (error) logger.warn({ sessionId, error: error.message }, "[auth] write failed");
}

async function dbDeleteMany(sessionId, keys) {
  if (!keys.length) return;
  const { error } = await db
    .from("whatsapp_session_keys")
    .delete()
    .eq("session_id", sessionId)
    .in("key", keys);
  if (error) logger.warn({ sessionId, error: error.message }, "[auth] delete failed");
}

async function useSupabaseAuthState(sessionId) {
  const creds = (await dbRead(sessionId, "creds")) || initAuthCreds();

  const keys = {
    get: async (type, ids) => {
      const out = {};
      await Promise.all(
        ids.map(async (id) => {
          let value = await dbRead(sessionId, `${type}-${id}`);
          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          if (value) out[id] = value;
        }),
      );
      return out;
    },
    set: async (data) => {
      const upserts = [];
      const deletes = [];
      const now = new Date().toISOString();
      for (const type of Object.keys(data)) {
        for (const id of Object.keys(data[type] || {})) {
          const value = data[type][id];
          const key = `${type}-${id}`;
          if (value) upserts.push({ session_id: sessionId, key, value: encode(value), updated_at: now });
          else deletes.push(key);
        }
      }
      await Promise.all([dbWriteMany(sessionId, upserts), dbDeleteMany(sessionId, deletes)]);
    },
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      await dbWriteMany(sessionId, [
        { session_id: sessionId, key: "creds", value: encode(creds), updated_at: new Date().toISOString() },
      ]);
    },
    clearSessionFor: async (jid) => {
      const digits = String(jid || "");
      const { data } = await db
        .from("whatsapp_session_keys")
        .select("key")
        .eq("session_id", sessionId)
        .like("key", `session-${digits.split("@")[0]}%`);
      await dbDeleteMany(sessionId, (data || []).map((r) => r.key));
    },
    wipe: async () => {
      await db.from("whatsapp_session_keys").delete().eq("session_id", sessionId);
    },
  };
}

/* --------------------------------- estado --------------------------------- */

/** sessionId -> { sock, status, qr, phone, lidMap, msgCache, badMac, auth, attempts, starting, stopped } */
const sessions = new Map();
const startLocks = new Map();

function getSession(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      sock: null,
      status: "idle",
      qr: null,
      phone: null,
      lidMap: new Map(),
      msgCache: new Map(),
      badMac: new Map(),
      auth: null,
      attempts: 0,
      stopped: false,
    };
    sessions.set(sessionId, s);
  }
  return s;
}

function cacheMessage(s, key, message) {
  if (!key?.id || !message) return;
  s.msgCache.set(key.id, message);
  if (s.msgCache.size > 1000) {
    const first = s.msgCache.keys().next().value;
    s.msgCache.delete(first);
  }
}

/* ------------------------------- lid mapping ------------------------------- */

function learnLid(sessionId, lidRaw, phoneRaw) {
  const lid = onlyDigits(lidRaw);
  const phone = onlyDigits(phoneRaw);
  if (!lid || !phone || lid === phone) return;
  if (phone.length < 10 || phone.length > 14) return;
  const s = sessions.get(sessionId);
  if (!s || s.lidMap.get(lid) === phone) return;
  s.lidMap.set(lid, phone);
  postWebhook({ event: "lid-map", sessionId, entries: [{ lid, phone }] });
}

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

/* --------------------------------- webhook --------------------------------- */

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

/* --------------------------------- sessão ---------------------------------- */

function closeSocket(s) {
  try { s.sock?.ev?.removeAllListeners?.(); } catch {}
  try { s.sock?.ws?.close?.(); } catch {}
  try { s.sock?.end?.(new Error("replaced")); } catch {}
  s.sock = null;
}

async function startSession(sessionId) {
  // mutex: nunca dois sockets para o mesmo sessionId
  if (startLocks.has(sessionId)) return startLocks.get(sessionId);
  const p = (async () => {
    const s = getSession(sessionId);
    s.stopped = false;
    if (s.sock && (s.status === "connected" || s.status === "connecting" || s.status === "qr")) return s;

    closeSocket(s);

    const auth = await useSupabaseAuthState(sessionId);
    s.auth = auth;
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: auth.state,
      printQRInTerminal: false,
      logger: P({ level: "silent" }),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      // Responde aos pedidos de reenvio do aparelho do contato.
      getMessage: async (key) => s.msgCache.get(key?.id) || undefined,
    });

    s.sock = sock;
    s.status = "connecting";
    s.qr = null;

    sock.ev.on("creds.update", auth.saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        s.qr = await QRCode.toDataURL(qr);
        s.status = "qr";
        postWebhook({ event: "status-updated", sessionId, status: "qr_ready", qrcode: s.qr });
      }
      if (connection === "open") {
        s.status = "connected";
        s.qr = null;
        s.attempts = 0;
        s.badMac.clear();
        s.phone = onlyDigits(sock.user?.id);
        if (sock.user?.lid) learnLid(sessionId, sock.user.lid, s.phone);
        postWebhook({ event: "status-updated", sessionId, status: "connected", phone: s.phone });
        const entries = [...s.lidMap].map(([lid, phone]) => ({ lid, phone }));
        if (entries.length) postWebhook({ event: "lid-map", sessionId, entries });
      }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        s.status = loggedOut ? "logged_out" : "disconnected";
        closeSocket(s);
        postWebhook({ event: "status-updated", sessionId, status: s.status });
        if (loggedOut) {
          await auth.wipe();
          return;
        }
        if (s.stopped) return;
        s.attempts = Math.min((s.attempts || 0) + 1, 6);
        const wait = Math.min(5000 * 2 ** (s.attempts - 1), 60000);
        await sleep(wait);
        startSession(sessionId).catch(() => {});
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
        if (remoteJid === "status@broadcast") continue;

        cacheMessage(s, key, msg.message);

        // Falha de decriptação desta conversa (Bad MAC / sessão fora de sincronia)
        const failed =
          msg.messageStubType === 2 ||
          (!msg.message && !key.fromMe) ||
          Boolean(msg.message?.senderKeyDistributionMessage && !msg.message?.conversation && msg.messageStubType);
        if (failed && remoteJid) {
          await handleDecryptFailure(sessionId, remoteJid);
        }

        if (remoteJid.endsWith("@g.us")) continue;

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
  })();

  startLocks.set(sessionId, p);
  try {
    return await p;
  } finally {
    startLocks.delete(sessionId);
  }
}

/**
 * Bad MAC / sessão fora de sincronia com um contato específico:
 * após 3 falhas, apaga só a sessão daquele contato — ela é refeita
 * automaticamente na próxima mensagem — sem derrubar a conexão.
 */
async function handleDecryptFailure(sessionId, jid) {
  const s = sessions.get(sessionId);
  if (!s) return;
  const count = (s.badMac.get(jid) || 0) + 1;
  s.badMac.set(jid, count);
  if (count < 3) return;
  s.badMac.set(jid, 0);
  try {
    await s.auth?.clearSessionFor?.(jid);
    logger.warn({ sessionId, jid }, "[signal] sessão do contato reiniciada após falhas de decriptação");
    postWebhook({ event: "session-error", sessionId, reason: "bad_mac", jid, error: "Bad MAC" });
  } catch (e) {
    logger.warn({ e: e.message }, "[signal] clearSessionFor failed");
  }
}

/* ------------------------------ erros globais ------------------------------ */

process.on("unhandledRejection", (e) => logger.warn({ e: String(e?.message || e) }, "unhandledRejection"));
process.on("uncaughtException", (e) => logger.error({ e: String(e?.message || e) }, "uncaughtException"));

/* --------------------------------- rotas ---------------------------------- */

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

app.get("/qrcode", async (req, res) => {
  const sessionId = req.query.sessionId;
  let s = sessions.get(sessionId);
  // Depois de um restart do Render a sessão existe no banco: religa sozinha.
  if (!s) {
    const creds = await dbRead(sessionId, "creds");
    if (!creds) return res.status(404).json({ error: "session not found" });
    s = await startSession(sessionId);
  }
  res.json({ sessionId, status: s.status, qrcode: s.qr || null, phone: s.phone || null });
});

app.post("/logout", async (req, res) => {
  const sessionId = req.body?.sessionId;
  const s = sessions.get(sessionId);
  if (s) s.stopped = true;
  try { await s?.sock?.logout(); } catch {}
  if (s) closeSocket(s);
  res.json({ success: true });
});

app.delete("/session/:id", async (req, res) => {
  const sessionId = req.params.id;
  const s = sessions.get(sessionId);
  if (s) s.stopped = true;
  try { await s?.sock?.logout(); } catch {}
  if (s) closeSocket(s);
  sessions.delete(sessionId);
  try { await db.from("whatsapp_session_keys").delete().eq("session_id", sessionId); } catch {}
  res.json({ success: true, deleted: true, exists: false });
});

app.post("/send-message", async (req, res) => {
  const { sessionId, phone, jid, message } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s?.sock || s.status !== "connected") return res.status(409).json({ error: "session not connected" });
  let target = jid || phone || "";
  if (!String(target).includes("@")) target = `${onlyDigits(target)}@s.whatsapp.net`;
  try {
    const sent = await s.sock.sendMessage(target, { text: String(message ?? "") });
    if (sent?.key && sent?.message) cacheMessage(s, sent.key, sent.message);
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

/* Religa sozinho todas as sessões já pareadas após um restart do Render. */
async function resumeSessions() {
  try {
    const { data } = await db
      .from("whatsapp_session_keys")
      .select("session_id")
      .eq("key", "creds");
    for (const row of data || []) {
      startSession(row.session_id).catch((e) =>
        logger.warn({ sessionId: row.session_id, e: e.message }, "[resume] failed"),
      );
      await sleep(1500);
    }
  } catch (e) {
    logger.warn({ e: e.message }, "[resume] failed");
  }
}

app.listen(PORT, () => {
  logger.info(`server on :${PORT}`);
  resumeSessions();
});
