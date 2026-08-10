// ============================================
// SERVIDOR BAILEYS MULTI-USUÁRIO COM STORE
// ============================================
const { 
  makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
  downloadMediaMessage,
  makeInMemoryStore,
  proto,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const express = require('express');
const P = require('pino');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'your-secret-key-here';
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const sessions = new Map();
const jidMap = new Map();

const logger = P({ 
  level: LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' }
  }
});

// ============================================
// CAPTURA ERROS NÃO TRATADOS — evita crash
// ============================================
process.on('uncaughtException', (err) => {
  logger.error('❌ uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  logger.error('❌ unhandledRejection:', reason);
});

// ============================================
// JID HELPERS
// ============================================
function saveJidFromMessage(remoteJid, senderPn) {
  if (!remoteJid) return;
  if (remoteJid.endsWith('@g.us')) return;
  if (remoteJid === 'status@broadcast') return;
  if (remoteJid.endsWith('@newsletter')) return;
  if (remoteJid.endsWith('@broadcast')) return;

  if (remoteJid.endsWith('@lid') && senderPn) {
    const phone = senderPn.replace(/\D/g, '').split('@')[0].split(':')[0];
    const jidToUse = senderPn.includes('@') ? senderPn : `${phone}@s.whatsapp.net`;
    jidMap.set(phone, jidToUse);
    // Também mapeia o @lid para o número real
    const lid = remoteJid.split('@')[0];
    jidMap.set(lid, jidToUse);
    logger.info(`[JID] Mapeado ${phone} → ${jidToUse} (via senderPn)`);
  } else if (remoteJid.endsWith('@s.whatsapp.net')) {
    const phone = remoteJid.replace(/\D/g, '').split('@')[0].split(':')[0];
    if (!jidMap.has(phone)) jidMap.set(phone, remoteJid);
  }
}

function resolveJid(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/\D/g, '').split('@')[0].split(':')[0];
  if (jidMap.has(cleaned)) {
    const resolved = jidMap.get(cleaned);
    logger.info(`[JID] Resolvido ${cleaned} → ${resolved}`);
    return resolved;
  }
  if (phone.includes('@g.us')) return `${cleaned}@g.us`;
  return `${cleaned}@s.whatsapp.net`;
}

// Resolve @lid para @s.whatsapp.net usando o store
function resolveJidFromStore(store, jid) {
  if (!jid || !jid.endsWith('@lid')) return jid;
  const lid = jid.split('@')[0];
  
  // Tenta no jidMap primeiro
  if (jidMap.has(lid)) return jidMap.get(lid);
  
  // Tenta no store de contatos
  if (store?.contacts) {
    for (const [id, contact] of Object.entries(store.contacts)) {
      if (contact.lid && contact.lid.includes(lid)) {
        const resolved = id.endsWith('@s.whatsapp.net') ? id : `${id}@s.whatsapp.net`;
        jidMap.set(lid, resolved);
        return resolved;
      }
    }
  }
  return jid;
}

// ============================================
// AUTH
// ============================================
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    logger.warn(`[AUTH] Acesso não autorizado`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};
app.use(authenticate);

// ============================================
// WEBHOOK
// ============================================
async function sendWebhook(payload, retries = 3) {
  if (!WEBHOOK_URL) return;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (response.ok) {
        logger.info(`[WEBHOOK] Enviado: ${payload.event}`);
        return;
      }
      logger.warn(`[WEBHOOK] Falha (${response.status}), tentativa ${i + 1}/${retries}`);
    } catch (e) {
      logger.error(`[WEBHOOK] Erro tentativa ${i + 1}/${retries}:`, e.message);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 2000));
    }
  }
  logger.error(`[WEBHOOK] Falhou após ${retries} tentativas`);
}

// ============================================
// SESSION MANAGEMENT
// ============================================
async function getOrCreateSession(sessionId) {
  if (!sessionId) sessionId = 'default';
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  const sessionData = {
    sock: null, store: null,
    qrCodeData: null, qrExpiry: null,
    connectionStatus: 'disconnected', authState: null,
    phoneNumber: null, reconnectAttempts: 0
  };
  const authDir = path.join(__dirname, 'auth_info', sessionId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  sessions.set(sessionId, sessionData);
  logger.info(`[${sessionId}] Nova sessão criada`);
  return sessionData;
}

async function cleanupSession(sessionId) {
  const sessionData = sessions.get(sessionId);
  if (!sessionData) return;
  logger.info(`[${sessionId}] Cleanup...`);
  if (sessionData.sock) {
    try {
      if (sessionData.sock.user) await sessionData.sock.logout();
    } catch (e) {
      logger.warn(`[${sessionId}] Erro logout: ${e.message}`);
    }
    sessionData.sock = null;
  }
  sessionData.store = null;
  sessionData.qrCodeData = null;
  sessionData.qrExpiry = null;
  sessionData.connectionStatus = 'disconnected';
  sessionData.phoneNumber = null;
  sessionData.reconnectAttempts = 0;
  logger.info(`[${sessionId}] Cleanup concluído`);
}

// ============================================
// CRIAR CONEXÃO WHATSAPP COM STORE
// ============================================
async function createWhatsAppConnection(sessionId, options = {}) {
  const sessionData = await getOrCreateSession(sessionId);
  
  if (sessionData.sock) {
    const isConnected = sessionData.sock.user && sessionData.connectionStatus === 'connected';
    if (isConnected) {
      logger.info(`[${sessionId}] ✅ Já conectado: ${sessionData.phoneNumber}`);
      return sessionData;
    }
    await cleanupSession(sessionId);
  }

  sessionData.reconnectAttempts = 0;
  const authDir = path.join(__dirname, 'auth_info', sessionId);

  // ============================================
  // STORE — resolve @lid automaticamente
  // ============================================
  const store = makeInMemoryStore({ logger: P({ level: 'silent' }) });
  sessionData.store = store;

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  sessionData.authState = { state, saveCreds };

  const { version } = await fetchLatestBaileysVersion();
  logger.info(`[${sessionId}] Criando socket (versão ${version.join('.')})`);
  
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: options.printQR !== false,
    logger: P({ level: 'silent' }),
    browser: ['Chrome (Linux)', 'Chrome', '121.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  // Vincula o store ao socket — isso é o que resolve @lid
  store.bind(sock.ev);
  sessionData.sock = sock;

  // ============================================
  // CONNECTION UPDATE
  // ============================================
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      sessionData.qrCodeData = qr;
      sessionData.qrExpiry = Date.now() + 60000;
      sessionData.connectionStatus = 'qr_ready';
      logger.info(`[${sessionId}] 📱 QR Code disponível`);
    }
    if (connection === 'open') {
      sessionData.connectionStatus = 'connected';
      sessionData.phoneNumber = sock.user?.id?.split(':')[0] || null;
      sessionData.qrCodeData = null;
      sessionData.qrExpiry = null;
      sessionData.reconnectAttempts = 0;
      logger.info(`[${sessionId}] ✅ CONECTADO: ${sessionData.phoneNumber}`);
      await sendWebhook({
        event: 'status-updated', sessionId,
        status: 'connected', connected: true,
        phone: { number: sessionData.phoneNumber }
      });
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn(`[${sessionId}] ❌ Conexão fechada (código: ${statusCode})`);
      sessionData.connectionStatus = 'disconnected';
      sessionData.qrCodeData = null;
      sessionData.qrExpiry = null;
      sessionData.phoneNumber = null;
      await sendWebhook({
        event: 'status-updated', sessionId,
        status: 'disconnected', connected: false
      });
      if (shouldReconnect && sessionData.reconnectAttempts < 5) {
        sessionData.reconnectAttempts++;
        const delay = Math.min(5000 * sessionData.reconnectAttempts, 30000);
        logger.info(`[${sessionId}] Reconectando ${sessionData.reconnectAttempts}/5 em ${delay}ms`);
        setTimeout(() => createWhatsAppConnection(sessionId, options), delay);
      } else if (sessionData.reconnectAttempts >= 5) {
        logger.error(`[${sessionId}] Limite de reconexões atingido`);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ============================================
  // CONTACTS UPDATE — popula o store com @lid
  // ============================================
  sock.ev.on('contacts.update', (updates) => {
    for (const update of updates) {
      if (update.lid && update.id) {
        const lid = update.lid.split('@')[0];
        const phone = update.id.split('@')[0];
        const jid = `${phone}@s.whatsapp.net`;
        jidMap.set(lid, jid);
        jidMap.set(phone, jid);
        logger.info(`[${sessionId}] [CONTACT] Mapeado lid=${lid} → ${jid}`);
      }
    }
  });

  // ============================================
  // MESSAGES UPSERT
  // ============================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const remoteJid = msg.key.remoteJid || '';

      // Ignora grupos, newsletters, broadcasts e status
      if (
        remoteJid.endsWith('@g.us') ||
        remoteJid.endsWith('@newsletter') ||
        remoteJid.endsWith('@broadcast') ||
        remoteJid === 'status@broadcast'
      ) continue;

      const isFromMe = msg.key.fromMe === true;
      const senderPn = msg.key.senderPn || msg.key.participant || '';

      // Resolve @lid → @s.whatsapp.net usando store
      const resolvedJid = resolveJidFromStore(store, remoteJid);
      logger.info(`[${sessionId}] 🔍 remoteJid=${remoteJid} resolved=${resolvedJid} fromMe=${isFromMe}`);

      // Salva mapeamento
      if (!isFromMe && senderPn) {
        saveJidFromMessage(remoteJid, senderPn);
      } else if (resolvedJid !== remoteJid) {
        // Atualiza o mapa com o que o store resolveu
        const phone = resolvedJid.split('@')[0];
        jidMap.set(phone, resolvedJid);
      }

      const msgType = Object.keys(msg.message)[0];
      let content = '';
      if (msgType === 'conversation') {
        content = msg.message.conversation;
      } else if (msgType === 'extendedTextMessage') {
        content = msg.message.extendedTextMessage?.text || '';
      }

      logger.info(`[${sessionId}] ${isFromMe ? '📤' : '💬'} ${resolvedJid}: ${content}`);

      // Download de áudio
      let audioBase64 = null;
      let audioMimetype = null;
      if (msg.message.audioMessage) {
        try {
          const buffer = await downloadMediaMessage(
            msg, 'buffer', {},
            { logger, reuploadRequest: sock.updateMediaMessage }
          );
          audioBase64 = buffer.toString('base64');
          audioMimetype = msg.message.audioMessage.mimetype || 'audio/ogg; codecs=opus';
        } catch (e) {
          logger.error(`[${sessionId}] Erro áudio: ${e.message}`);
        }
      }

      // Envia webhook com JID resolvido
      const webhookKey = {
        ...msg.key,
        remoteJid: resolvedJid, // usa o JID resolvido
      };

      await sendWebhook({
        event: 'received-message',
        sessionId,
        instanceId: sessionId,
        data: {
          key: webhookKey,
          message: msg.message,
          messageTimestamp: msg.messageTimestamp,
          pushName: msg.pushName,
          fromMe: isFromMe,
          audioBase64,
          audioMimetype,
        }
      });
    }
  });

  return sessionData;
}

// ============================================
// ENDPOINTS
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), sessions: sessions.size, knownContacts: jidMap.size });
});

app.post('/create-session', async (req, res) => {
  try {
    const { sessionId, printQR } = req.body;
    const sid = sessionId || 'default';
    const sessionData = await createWhatsAppConnection(sid, { printQR });
    await new Promise(r => setTimeout(r, 3000));
    if (sessionData.connectionStatus === 'connected') {
      return res.json({ success: true, status: 'connected', phone: sessionData.phoneNumber });
    }
    if (sessionData.qrCodeData) {
      const qrBase64 = await QRCode.toDataURL(sessionData.qrCodeData);
      return res.json({ success: true, qrcode: qrBase64, status: sessionData.connectionStatus, expiresIn: 60 });
    }
    return res.json({ success: true, status: sessionData.connectionStatus });
  } catch (error) {
    logger.error(`Erro /create-session:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/qrcode', async (req, res) => {
  try {
    const sessionId = req.query.sessionId || 'default';
    const sessionData = sessions.get(sessionId);
    if (!sessionData) return res.json({ status: 'disconnected' });
    if (sessionData.qrCodeData && sessionData.qrExpiry && Date.now() > sessionData.qrExpiry) {
      sessionData.qrCodeData = null;
      sessionData.qrExpiry = null;
    }
    if (sessionData.connectionStatus === 'connected') {
      return res.json({ status: 'connected', phone: sessionData.phoneNumber });
    }
    if (sessionData.qrCodeData) {
      const qrBase64 = await QRCode.toDataURL(sessionData.qrCodeData);
      return res.json({ qrcode: qrBase64, status: sessionData.connectionStatus, expiresIn: Math.max(0, Math.floor((sessionData.qrExpiry - Date.now()) / 1000)) });
    }
    return res.json({ status: sessionData.connectionStatus });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/disconnect', async (req, res) => {
  try {
    await cleanupSession(req.body.sessionId || 'default');
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/logout', async (req, res) => {
  try {
    await cleanupSession(req.body.sessionId || 'default');
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/session/:sessionId?', async (req, res) => {
  try {
    const sessionId = req.params.sessionId || 'default';
    await cleanupSession(sessionId);
    const authDir = path.join(__dirname, 'auth_info', sessionId);
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    sessions.delete(sessionId);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================
// SEND MESSAGE — com store resolve @lid
// ============================================
app.post('/send-message', async (req, res) => {
  try {
    const { sessionId, phone, message } = req.body;
    const sid = sessionId || 'default';
    if (!phone || !message) return res.status(400).json({ error: 'phone e message são obrigatórios' });
    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }
    const sock = sessionData.sock;
    const store = sessionData.store;

    // Resolve o JID correto usando store + jidMap
    let jid = resolveJid(phone);

    // Tenta resolver via store de contatos se ainda for @lid ou número simples
    if (store?.contacts) {
      const phoneCleaned = phone.replace(/\D/g, '').slice(-11);
      for (const [id, contact] of Object.entries(store.contacts)) {
        if (id.includes(phoneCleaned) && id.endsWith('@s.whatsapp.net')) {
          jid = id;
          logger.info(`[${sid}] 🔄 JID resolvido via store: ${jid}`);
          break;
        }
      }
    }

    logger.info(`[${sid}] 📤 Enviando para jid=${jid} (phone=${phone})`);
    const result = await sock.sendMessage(jid, { text: message });
    logger.info(`[${sid}] ✅ Enviado para ${jid} (id: ${result?.key?.id})`);
    res.json({ success: true, jid, messageId: result?.key?.id });
  } catch (error) {
    logger.error(`Erro /send-message:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-buttons', async (req, res) => {
  try {
    const { sessionId, phone, text, footer, title, buttons } = req.body;
    const sid = sessionId || 'default';
    if (!phone || !text || !buttons?.length) return res.status(400).json({ error: 'phone, text e buttons são obrigatórios' });
    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') return res.status(400).json({ error: 'WhatsApp não conectado' });
    const jid = resolveJid(phone);
    const nativeButtons = buttons.map(btn => ({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.text, id: btn.id }) }));
    const interactiveMsg = { interactiveMessage: proto.Message.InteractiveMessage.fromObject({ body: proto.Message.InteractiveMessage.Body.fromObject({ text }), footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: footer || '' }), header: proto.Message.InteractiveMessage.Header.fromObject({ title: title || '', subtitle: '', hasMediaAttachment: false }), nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({ buttons: nativeButtons }) }) };
    const msg = generateWAMessageFromContent(jid, { viewOnceMessage: { message: interactiveMsg } }, {});
    await sessionData.sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    res.json({ success: true, jid, type: 'buttons' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/send-list', async (req, res) => {
  try {
    const { sessionId, phone, text, title, buttonText, footer, sections } = req.body;
    const sid = sessionId || 'default';
    if (!phone || !text || !sections?.length) return res.status(400).json({ error: 'phone, text e sections são obrigatórios' });
    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') return res.status(400).json({ error: 'WhatsApp não conectado' });
    const jid = resolveJid(phone);
    const listParams = { title: buttonText || 'Ver opções', sections: sections.map(s => ({ title: s.title || '', rows: s.rows.map(r => ({ header: '', title: r.title, description: r.description || '', id: r.id })) })) };
    const interactiveMsg = { interactiveMessage: proto.Message.InteractiveMessage.fromObject({ body: proto.Message.InteractiveMessage.Body.fromObject({ text }), footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: footer || '' }), header: proto.Message.InteractiveMessage.Header.fromObject({ title: title || '', subtitle: '', hasMediaAttachment: false }), nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({ buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify(listParams) }] }) }) };
    const msg = generateWAMessageFromContent(jid, { viewOnceMessage: { message: interactiveMsg } }, {});
    await sessionData.sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    res.json({ success: true, jid, type: 'list' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/send-link-button', async (req, res) => {
  try {
    const { sessionId, phone, text, footer, title, buttons } = req.body;
    const sid = sessionId || 'default';
    if (!phone || !text || !buttons?.length) return res.status(400).json({ error: 'phone, text e buttons são obrigatórios' });
    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') return res.status(400).json({ error: 'WhatsApp não conectado' });
    const jid = resolveJid(phone);
    const nativeButtons = buttons.map(btn => {
      if (btn.url) return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: btn.text, url: btn.url, merchant_url: btn.url }) };
      if (btn.phoneNumber) return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: btn.text, phone_number: btn.phoneNumber }) };
      return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.text, id: btn.id || btn.text }) };
    });
    const interactiveMsg = { interactiveMessage: proto.Message.InteractiveMessage.fromObject({ body: proto.Message.InteractiveMessage.Body.fromObject({ text }), footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: footer || '' }), header: proto.Message.InteractiveMessage.Header.fromObject({ title: title || '', subtitle: '', hasMediaAttachment: false }), nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({ buttons: nativeButtons }) }) };
    const msg = generateWAMessageFromContent(jid, { viewOnceMessage: { message: interactiveMsg } }, {});
    await sessionData.sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    res.json({ success: true, jid, type: 'link_button' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/status', (req, res) => {
  const allSessions = {};
  sessions.forEach((data, sid) => {
    allSessions[sid] = { status: data.connectionStatus, phone: data.phoneNumber, hasQR: !!data.qrCodeData, reconnectAttempts: data.reconnectAttempts };
  });
  res.json({ success: true, uptime: process.uptime(), totalSessions: sessions.size, knownContacts: jidMap.size, sessions: allSessions });
});

app.listen(PORT, () => {
  logger.info(`🚀 Servidor Baileys rodando na porta ${PORT}`);
  logger.info(`🔐 API Key: ${API_KEY ? '✅' : '❌'}`);
  logger.info(`🪝 Webhook: ${WEBHOOK_URL || 'Não configurado'}`);
});

process.on('SIGINT', async () => {
  for (const [sid] of sessions.entries()) await cleanupSession(sid);
  process.exit(0);
});
process.on('SIGTERM', async () => {
  for (const [sid] of sessions.entries()) await cleanupSession(sid);
  process.exit(0);
});
