// ============================================
// SERVIDOR BAILEYS MULTI-USUÁRIO
// ============================================
const { 
  makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
  downloadMediaMessage,
  proto
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
    logger.info(`[JID] Mapeado ${phone} → ${jidToUse} (via senderPn)`);
  } else if (remoteJid.endsWith('@s.whatsapp.net')) {
    const phone = remoteJid.replace(/\D/g, '').split('@')[0].split(':')[0];
    if (!jidMap.has(phone)) jidMap.set(phone, remoteJid);
  }

  logger.info(`[JID] jidMap atual: ${JSON.stringify([...jidMap.entries()])}`);
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

const logger = P({ 
  level: LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' }
  }
});

const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    logger.warn(`[AUTH] Tentativa de acesso não autorizado`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.use(authenticate);

async function sendWebhook(payload, retries = 3) {
  if (!WEBHOOK_URL) return;
  console.log("Payload: ", payload);
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (response.ok) {
        logger.info(`[WEBHOOK] Enviado com sucesso: ${payload.event}`);
        return;
      }
      logger.warn(`[WEBHOOK] Falha (${response.status}), tentativa ${i + 1}/${retries}`);
    } catch (e) {
      logger.error(`[WEBHOOK] Erro na tentativa ${i + 1}/${retries}:`, e.message);
      if (i < retries - 1) await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  logger.error(`[WEBHOOK] Falhou após ${retries} tentativas`);
}

async function getOrCreateSession(sessionId) {
  if (!sessionId) sessionId = 'default';
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  const sessionData = {
    sock: null, qrCodeData: null, qrExpiry: null,
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
  logger.info(`[${sessionId}] Iniciando cleanup...`);
  if (sessionData.sock) {
    try {
      if (sessionData.sock.user) await sessionData.sock.logout();
    } catch (e) {
      logger.warn(`[${sessionId}] Erro logout: ${e.message}`);
    }
    sessionData.sock = null;
  }
  sessionData.qrCodeData = null;
  sessionData.qrExpiry = null;
  sessionData.connectionStatus = 'disconnected';
  sessionData.phoneNumber = null;
  sessionData.reconnectAttempts = 0;
  logger.info(`[${sessionId}] Cleanup concluído`);
}

async function createWhatsAppConnection(sessionId, options = {}) {
  const sessionData = await getOrCreateSession(sessionId);
  
  if (sessionData.sock) {
    const isConnected = sessionData.sock.user && sessionData.connectionStatus === 'connected';
    if (isConnected) {
      logger.info(`[${sessionId}] ✅ Socket já conectado: ${sessionData.phoneNumber}`);
      return sessionData;
    }
    await cleanupSession(sessionId);
  }

  sessionData.reconnectAttempts = 0;
  const authDir = path.join(__dirname, 'auth_info', sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  sessionData.authState = { state, saveCreds };

  const { version } = await fetchLatestBaileysVersion();
  logger.info(`[${sessionId}] Criando socket WhatsApp (versão ${version.join('.')})`);
  
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: options.printQR !== false,
    logger: P({ level: 'warn' }),
    browser: ['Baileys Server', 'Chrome', '121.0.0'],
    syncFullHistory: false
  });

  sessionData.sock = sock;

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
      if (shouldReconnect && sessionData.reconnectAttempts < 3) {
        sessionData.reconnectAttempts++;
        const delay = 5000 * sessionData.reconnectAttempts;
        logger.info(`[${sessionId}] Reconectando ${sessionData.reconnectAttempts}/3 em ${delay}ms`);
        setTimeout(() => createWhatsAppConnection(sessionId, options), delay);
      } else if (sessionData.reconnectAttempts >= 3) {
        logger.error(`[${sessionId}] Limite de reconexões atingido`);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ============================================
  // EVENT: messages.upsert
  // ============================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;

      const remoteJid = msg.key.remoteJid || '';

      // ✅ IGNORA grupos, newsletters, broadcasts e status
      if (
        remoteJid.endsWith('@g.us') ||
        remoteJid.endsWith('@newsletter') ||
        remoteJid.endsWith('@broadcast') ||
        remoteJid === 'status@broadcast'
      ) {
        logger.info(`[${sessionId}] ⏭️ Ignorado: ${remoteJid}`);
        continue;
      }

      const isFromMe = msg.key.fromMe === true;
      const senderPn = msg.key.senderPn || msg.key.participant || '';

      logger.info(`[${sessionId}] 🔍 remoteJid=${remoteJid} senderPn=${senderPn} fromMe=${isFromMe}`);

      // Salva mapeamento JID apenas para mensagens recebidas
      if (!isFromMe) {
        saveJidFromMessage(remoteJid, senderPn);
      }

      const msgType = Object.keys(msg.message)[0];
      let content = '';

      if (msgType === 'conversation') {
        content = msg.message.conversation;
      } else if (msgType === 'extendedTextMessage') {
        content = msg.message.extendedTextMessage?.text || '';
      }

      logger.info(`[${sessionId}] ${isFromMe ? '📤' : '💬'} Mensagem ${isFromMe ? 'enviada' : 'recebida'} ${remoteJid}: ${content}`);

      // ============================================
      // DOWNLOAD DE ÁUDIO
      // ============================================
      let audioBase64 = null;
      let audioMimetype = null;

      if (msg.message.audioMessage) {
        try {
          logger.info(`[${sessionId}] 🎤 Baixando áudio...`);
          const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { logger, reuploadRequest: sock.updateMediaMessage }
          );
          audioBase64 = buffer.toString('base64');
          audioMimetype = msg.message.audioMessage.mimetype || 'audio/ogg; codecs=opus';
          logger.info(`[${sessionId}] ✅ Áudio baixado (${buffer.length} bytes)`);
        } catch (e) {
          logger.error(`[${sessionId}] ❌ Erro ao baixar áudio: ${e.message}`);
        }
      }

      await sendWebhook({
        event: 'received-message',
        sessionId,
        instanceId: sessionId,
        data: {
          key: msg.key,
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

app.post('/send-message', async (req, res) => {
  try {
    const { sessionId, phone, message } = req.body;
    const sid = sessionId || 'default';
    if (!phone || !message) return res.status(400).json({ error: 'phone e message são obrigatórios' });
    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }
    const jid = resolveJid(phone);
    logger.info(`[${sid}] 📤 Enviando para jid=${jid} (phone=${phone})`);
    await sessionData.sock.sendMessage(jid, { text: message });
    logger.info(`[${sid}] ✅ Texto enviado para ${jid}`);
    res.json({ success: true, jid });
  } catch (error) {
    logger.error(`Erro /send-message:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-buttons', async (req, res) => {
  try {
    const { sessionId, phone, text, footer, title, buttons } = req.body;
    const sid = sessionId || 'default';
    if (!phone || !text || !buttons || !Array.isArray(buttons) || buttons.length === 0) {
      return res.status(400).json({ error: 'phone, text e buttons são obrigatórios' });
    }
    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }
    const jid = resolveJid(phone);
    const nativeButtons = buttons.map(btn => ({
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: btn.text, id: btn.id })
    }));
    const interactiveMsg = {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        body: proto.Message.InteractiveMessage.Body.fromObject({ text }),
        footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: footer || '' }),
        header: proto.Message.InteractiveMessage.Header.fromObject({ title: title || '', subtitle: '', hasMediaAttachment: false }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({ buttons: nativeButtons })
      })
    };
    const msg = generateWAMessageFromContent(jid, { viewOnceMessage: { message: interactiveMsg } }, {});
    await sessionData.sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    logger.info(`[${sid}] 🔘 Botões enviados para ${jid}`);
    res.json({ success: true, jid, type: 'buttons' });
  } catch (error) {
    logger.error(`Erro /send-buttons:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-list', async (req, res) => {
  try {
    const { sessionId, phone, text, title, buttonText, footer, sections } = req.body;
    const sid = sessionId || 'default';
    if (!phone || !text || !sections || !Array.isArray(sections) || sections.length === 0) {
      return res.status(400).json({ error: 'phone, text e sections são obrigatórios' });
    }
    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }
    const jid = resolveJid(phone);
    const listParams = {
      title: buttonText || 'Ver opções',
      sections: sections.map(section => ({
        title: section.title || '',
        rows: section.rows.map(row => ({ header: '', title: row.title, description: row.description || '', id: row.id }))
      }))
    };
    const interactiveMsg = {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        body: proto.Message.InteractiveMessage.Body.fromObject({ text }),
        footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: footer || '' }),
        header: proto.Message.InteractiveMessage.Header.fromObject({ title: title || '', subtitle: '', hasMediaAttachment: false }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
          buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify(listParams) }]
        })
      })
    };
    const msg = generateWAMessageFromContent(jid, { viewOnceMessage: { message: interactiveMsg } }, {});
    await sessionData.sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    logger.info(`[${sid}] 📋 Menu enviado para ${jid}`);
    res.json({ success: true, jid, type: 'list' });
  } catch (error) {
    logger.error(`Erro /send-list:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-link-button', async (req, res) => {
  try {
    const { sessionId, phone, text, footer, title, buttons } = req.body;
    const sid = sessionId || 'default';
    if (!phone || !text || !buttons || !Array.isArray(buttons) || buttons.length === 0) {
      return res.status(400).json({ error: 'phone, text e buttons são obrigatórios' });
    }
    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }
    const jid = resolveJid(phone);
    const nativeButtons = buttons.map(btn => {
      if (btn.url) return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: btn.text, url: btn.url, merchant_url: btn.url }) };
      if (btn.phoneNumber) return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: btn.text, phone_number: btn.phoneNumber }) };
      return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.text, id: btn.id || btn.text }) };
    });
    const interactiveMsg = {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        body: proto.Message.InteractiveMessage.Body.fromObject({ text }),
        footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: footer || '' }),
        header: proto.Message.InteractiveMessage.Header.fromObject({ title: title || '', subtitle: '', hasMediaAttachment: false }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({ buttons: nativeButtons })
      })
    };
    const msg = generateWAMessageFromContent(jid, { viewOnceMessage: { message: interactiveMsg } }, {});
    await sessionData.sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    logger.info(`[${sid}] 🔗 Link button enviado para ${jid}`);
    res.json({ success: true, jid, type: 'link_button' });
  } catch (error) {
    logger.error(`Erro /send-link-button:`, error);
    res.status(500).json({ error: error.message });
  }
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
