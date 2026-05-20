// ============================================
// SERVIDOR BAILEYS MULTI-USUÁRIO
// ============================================
// CommonJS para Render.com
// ============================================

const { 
  makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
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

// ============================================
// ESTRUTURA MULTI-USUÁRIO
// ============================================
const sessions = new Map();

// ============================================
// MAPA DE JIDs REAIS (corrige contato fantasma)
// Quando o lead manda mensagem, salvamos o JID
// exato que o WhatsApp usou. Quando vamos responder,
// usamos esse mesmo JID — sem risco de duplicar contato.
// ============================================
const jidMap = new Map(); // phone_limpo -> jid_original

function saveJid(remoteJid) {
  if (!remoteJid) return;
  const phone = remoteJid.split('@')[0].split(':')[0];
  jidMap.set(phone, remoteJid);
}

function resolveJid(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/\D/g, '').split('@')[0].split(':')[0];

  // Se já vimos esse lead receber mensagem, usa o JID original dele
  if (jidMap.has(cleaned)) {
    return jidMap.get(cleaned);
  }

  // Fallback: monta JID padrão (Brasil: adiciona nono dígito se faltou)
  let number = cleaned;
  if (number.startsWith('55') && number.length === 12) {
    const ddd = number.substring(2, 4);
    const rest = number.substring(4);
    number = `55${ddd}9${rest}`;
  }

  if (phone.includes('@g.us')) return `${number}@g.us`;
  return `${number}@s.whatsapp.net`;
}

// ============================================
// Logger
// ============================================
const logger = P({ 
  level: LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  }
});

// ============================================
// MIDDLEWARE DE AUTENTICAÇÃO
// ============================================
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    logger.warn(`[AUTH] Tentativa de acesso não autorizado`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.use(authenticate);

// ============================================
// FUNÇÃO: Enviar Webhook com Retry
// ============================================
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

// ============================================
// FUNÇÃO: Obter ou criar sessão
// ============================================
async function getOrCreateSession(sessionId) {
  if (!sessionId) sessionId = 'default';
  
  if (sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }

  const sessionData = {
    sock: null,
    qrCodeData: null,
    qrExpiry: null,
    connectionStatus: 'disconnected',
    authState: null,
    phoneNumber: null,
    reconnectAttempts: 0
  };

  const authDir = path.join(__dirname, 'auth_info', sessionId);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  sessions.set(sessionId, sessionData);
  logger.info(`[${sessionId}] Nova sessão criada`);
  
  return sessionData;
}

// ============================================
// FUNÇÃO: Cleanup seguro de sessão
// ============================================
async function cleanupSession(sessionId) {
  const sessionData = sessions.get(sessionId);
  if (!sessionData) return;

  logger.info(`[${sessionId}] Iniciando cleanup de sessão...`);

  if (sessionData.sock) {
    try {
      if (sessionData.sock.user) {
        await sessionData.sock.logout();
        logger.info(`[${sessionId}] Logout realizado com sucesso`);
      } else {
        logger.warn(`[${sessionId}] Socket não autenticado, pulando logout`);
      }
    } catch (e) {
      logger.warn(`[${sessionId}] Erro ao fazer logout: ${e.message}`);
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

// ============================================
// FUNÇÃO: Criar conexão WhatsApp
// ============================================
async function createWhatsAppConnection(sessionId, options = {}) {
  const sessionData = await getOrCreateSession(sessionId);
  
  if (sessionData.sock) {
    const isCurrentlyConnected = sessionData.sock.user && sessionData.connectionStatus === 'connected';
    
    if (isCurrentlyConnected) {
      logger.info(`[${sessionId}] ✅ Socket já conectado e autenticado, mantendo conexão existente`);
      logger.info(`[${sessionId}] 📱 Telefone: ${sessionData.phoneNumber}`);
      return sessionData;
    }
    
    logger.info(`[${sessionId}] Fechando socket anterior (status: ${sessionData.connectionStatus})...`);
    await cleanupSession(sessionId);
  }

  sessionData.reconnectAttempts = 0;

  const authDir = path.join(__dirname, 'auth_info', sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  sessionData.authState = { state, saveCreds };

  const { version } = await fetchLatestBaileysVersion();
  
  logger.info(`[${sessionId}] Criando novo socket WhatsApp (versão ${version.join('.')})`);
  
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: options.printQR !== false,
    logger: P({ level: 'warn' }),
    browser: ['Baileys Server', 'Chrome', '121.0.0'],
    syncFullHistory: false
  });

  sessionData.sock = sock;

  // ============================================
  // EVENT: connection.update
  // ============================================
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessionData.qrCodeData = qr;
      sessionData.qrExpiry = Date.now() + 60000;
      sessionData.connectionStatus = 'qr_ready';
      logger.info(`[${sessionId}] 📱 QR Code disponível (expira em 60s)`);
    }

    if (connection === 'open') {
      sessionData.connectionStatus = 'connected';
      sessionData.phoneNumber = sock.user?.id?.split(':')[0] || null;
      sessionData.qrCodeData = null;
      sessionData.qrExpiry = null;
      sessionData.reconnectAttempts = 0;
      
      logger.info(`[${sessionId}] ✅ CONECTADO: ${sessionData.phoneNumber}`);
      
      await sendWebhook({
        event: 'status-updated',
        sessionId,
        status: 'connected',
        connected: true,
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
        event: 'status-updated',
        sessionId,
        status: 'disconnected',
        connected: false
      });

      if (shouldReconnect && sessionData.reconnectAttempts < 3) {
        sessionData.reconnectAttempts++;
        const delay = 5000 * sessionData.reconnectAttempts;
        logger.info(`[${sessionId}] Tentativa de reconexão ${sessionData.reconnectAttempts}/3 em ${delay}ms`);
        setTimeout(() => createWhatsAppConnection(sessionId, options), delay);
      } else if (sessionData.reconnectAttempts >= 3) {
        logger.error(`[${sessionId}] Limite de reconexões atingido (3)`);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ============================================
  // EVENT: messages.upsert
  // IDÊNTICO AO ORIGINAL — não alteramos o payload
  // do webhook para não quebrar a plataforma.
  // Apenas adicionamos o saveJid() para memorizar
  // o JID real de cada contato.
  // ============================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;

      // ✅ Memoriza o JID original do contato
      saveJid(remoteJid);

      const messageType = Object.keys(msg.message)[0];
      let content = '';

      if (messageType === 'conversation') {
        content = msg.message.conversation;
      } else if (messageType === 'extendedTextMessage') {
        content = msg.message.extendedTextMessage.text;
      }

      logger.info(`[${sessionId}] 💬 Mensagem de ${remoteJid}: ${content}`);

      // ✅ Payload IDÊNTICO ao original — não quebra a plataforma
      await sendWebhook({
        event: 'received-message',
        sessionId,
        instanceId: sessionId,
        data: {
          key: msg.key,
          message: msg.message,
          messageTimestamp: msg.messageTimestamp,
          pushName: msg.pushName
        }
      });
    }
  });

  return sessionData;
}

// ============================================
// ENDPOINTS
// ============================================

// 1. Health Check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    sessions: sessions.size,
    knownContacts: jidMap.size
  });
});

// 2. Criar sessão
app.post('/create-session', async (req, res) => {
  try {
    const { sessionId, printQR } = req.body;
    const sid = sessionId || 'default';

    logger.info(`[${sid}] POST /create-session`);

    const sessionData = await createWhatsAppConnection(sid, { printQR });
    
    await new Promise(resolve => setTimeout(resolve, 3000));

    if (sessionData.connectionStatus === 'connected') {
      return res.json({
        success: true,
        status: 'connected',
        phone: sessionData.phoneNumber
      });
    }

    if (sessionData.qrCodeData) {
      const qrBase64 = await QRCode.toDataURL(sessionData.qrCodeData);
      return res.json({
        success: true,
        qrcode: qrBase64,
        status: sessionData.connectionStatus,
        expiresIn: 60
      });
    }

    return res.json({
      success: true,
      status: sessionData.connectionStatus,
      message: 'Sessão criada, aguarde QR code'
    });
  } catch (error) {
    logger.error(`Erro em /create-session:`, error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Obter QR Code (polling)
app.get('/qrcode', async (req, res) => {
  try {
    const sessionId = req.query.sessionId || 'default';
    const sessionData = sessions.get(sessionId);

    if (!sessionData) {
      return res.json({ status: 'disconnected', message: 'Sessão não encontrada' });
    }

    if (sessionData.qrCodeData && sessionData.qrExpiry && Date.now() > sessionData.qrExpiry) {
      logger.warn(`[${sessionId}] QR Code expirado, limpando...`);
      sessionData.qrCodeData = null;
      sessionData.qrExpiry = null;
    }

    if (sessionData.connectionStatus === 'connected') {
      return res.json({
        status: 'connected',
        phone: sessionData.phoneNumber
      });
    }

    if (sessionData.qrCodeData) {
      const qrBase64 = await QRCode.toDataURL(sessionData.qrCodeData);
      return res.json({ 
        qrcode: qrBase64, 
        status: sessionData.connectionStatus,
        expiresIn: Math.max(0, Math.floor((sessionData.qrExpiry - Date.now()) / 1000))
      });
    }

    return res.json({ status: sessionData.connectionStatus });
  } catch (error) {
    logger.error(`Erro em /qrcode:`, error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Obter QR Code (compatibilidade)
app.get('/sessions/:id/qrcode', async (req, res) => {
  req.query.sessionId = req.params.id;
  return app._router.handle(req, res);
});

// 5. Desconectar sessão
app.post('/disconnect', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const sid = sessionId || 'default';
    await cleanupSession(sid);
    res.json({ success: true, message: 'Desconectado com sucesso' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Logout
app.post('/logout', async (req, res) => {
  try {
    const sid = req.body.sessionId || 'default';
    await cleanupSession(sid);
    res.json({ success: true, message: 'Logout realizado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 7. Deletar sessão
app.delete('/session/:sessionId?', async (req, res) => {
  try {
    const sessionId = req.params.sessionId || 'default';
    await cleanupSession(sessionId);

    const authDir = path.join(__dirname, 'auth_info', sessionId);
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }

    sessions.delete(sessionId);
    res.json({ success: true, message: 'Sessão deletada' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 8. ENVIAR MENSAGEM DE TEXTO
// ============================================
app.post('/send-message', async (req, res) => {
  try {
    const { sessionId, phone, message } = req.body;
    const sid = sessionId || 'default';

    if (!phone || !message) {
      return res.status(400).json({ error: 'phone e message são obrigatórios' });
    }

    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }

    // ✅ Usa JID original se já vimos esse contato, ou monta padrão
    const jid = resolveJid(phone);
    
    await sessionData.sock.sendMessage(jid, { text: message });
    
    logger.info(`[${sid}] ✅ Texto enviado para ${jid}`);
    res.json({ success: true, message: 'Mensagem enviada', jid });
  } catch (error) {
    logger.error(`Erro em /send-message:`, error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 9. ENVIAR BOTÕES (interactiveMessage / nativeFlow)
// ============================================
// Payload:
// {
//   "sessionId": "default",
//   "phone": "5511999999999",
//   "text": "Olá, João Silva agendou reunião!",
//   "footer": "",
//   "buttons": [
//     { "id": "quero_usar", "text": "Quero usar" },
//     { "id": "nao_quero", "text": "Não quero usar" }
//   ]
// }
// ============================================
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
      buttonParamsJson: JSON.stringify({
        display_text: btn.text,
        id: btn.id
      })
    }));

    const interactiveMsg = {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        body: proto.Message.InteractiveMessage.Body.fromObject({ text }),
        footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: footer || '' }),
        header: proto.Message.InteractiveMessage.Header.fromObject({
          title: title || '',
          subtitle: '',
          hasMediaAttachment: false
        }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
          buttons: nativeButtons
        })
      })
    };

    const msg = generateWAMessageFromContent(
      jid,
      { viewOnceMessage: { message: interactiveMsg } },
      {}
    );

    await sessionData.sock.relayMessage(jid, msg.message, { messageId: msg.key.id });

    logger.info(`[${sid}] 🔘 Botões enviados para ${jid}`);
    res.json({ success: true, jid, type: 'buttons' });
  } catch (error) {
    logger.error(`Erro em /send-buttons:`, error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 10. ENVIAR MENU / LISTA (modal com opções)
// ============================================
// Payload:
// {
//   "sessionId": "default",
//   "phone": "5511999999999",
//   "text": "ola",
//   "title": "Menu",
//   "buttonText": "Ver opções",
//   "footer": "",
//   "sections": [
//     {
//       "title": "",
//       "rows": [
//         { "id": "opt_2", "title": "Opção 2", "description": "" },
//         { "id": "opt_3", "title": "Opção 3", "description": "" },
//         { "id": "opt_4", "title": "Opção 4", "description": "" }
//       ]
//     }
//   ]
// }
// ============================================
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
        rows: section.rows.map(row => ({
          header: '',
          title: row.title,
          description: row.description || '',
          id: row.id
        }))
      }))
    };

    const interactiveMsg = {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        body: proto.Message.InteractiveMessage.Body.fromObject({ text }),
        footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: footer || '' }),
        header: proto.Message.InteractiveMessage.Header.fromObject({
          title: title || '',
          subtitle: '',
          hasMediaAttachment: false
        }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
          buttons: [{
            name: 'single_select',
            buttonParamsJson: JSON.stringify(listParams)
          }]
        })
      })
    };

    const msg = generateWAMessageFromContent(
      jid,
      { viewOnceMessage: { message: interactiveMsg } },
      {}
    );

    await sessionData.sock.relayMessage(jid, msg.message, { messageId: msg.key.id });

    logger.info(`[${sid}] 📋 Menu enviado para ${jid}`);
    res.json({ success: true, jid, type: 'list' });
  } catch (error) {
    logger.error(`Erro em /send-list:`, error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 11. ENVIAR BOTÃO COM LINK (URL)
// ============================================
// Payload:
// {
//   "sessionId": "default",
//   "phone": "5511999999999",
//   "text": "talves possa ver",
//   "footer": "",
//   "buttons": [
//     { "text": "agendar", "url": "https://exemplo.com/agendar" }
//   ]
// }
// ============================================
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
      if (btn.url) {
        return {
          name: 'cta_url',
          buttonParamsJson: JSON.stringify({
            display_text: btn.text,
            url: btn.url,
            merchant_url: btn.url
          })
        };
      } else if (btn.phoneNumber) {
        return {
          name: 'cta_call',
          buttonParamsJson: JSON.stringify({
            display_text: btn.text,
            phone_number: btn.phoneNumber
          })
        };
      } else {
        return {
          name: 'quick_reply',
          buttonParamsJson: JSON.stringify({
            display_text: btn.text,
            id: btn.id || btn.text
          })
        };
      }
    });

    const interactiveMsg = {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        body: proto.Message.InteractiveMessage.Body.fromObject({ text }),
        footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: footer || '' }),
        header: proto.Message.InteractiveMessage.Header.fromObject({
          title: title || '',
          subtitle: '',
          hasMediaAttachment: false
        }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
          buttons: nativeButtons
        })
      })
    };

    const msg = generateWAMessageFromContent(
      jid,
      { viewOnceMessage: { message: interactiveMsg } },
      {}
    );

    await sessionData.sock.relayMessage(jid, msg.message, { messageId: msg.key.id });

    logger.info(`[${sid}] 🔗 Link button enviado para ${jid}`);
    res.json({ success: true, jid, type: 'link_button' });
  } catch (error) {
    logger.error(`Erro em /send-link-button:`, error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 12. STATUS
// ============================================
app.get('/status', (req, res) => {
  const allSessions = {};
  sessions.forEach((data, sid) => {
    allSessions[sid] = {
      status: data.connectionStatus,
      phone: data.phoneNumber,
      hasQR: !!data.qrCodeData,
      reconnectAttempts: data.reconnectAttempts
    };
  });

  res.json({
    success: true,
    uptime: process.uptime(),
    totalSessions: sessions.size,
    knownContacts: jidMap.size,
    sessions: allSessions
  });
});

// ============================================
// SERVIDOR
// ============================================
app.listen(PORT, () => {
  logger.info(`🚀 Servidor Baileys Multi-usuário rodando na porta ${PORT}`);
  logger.info(`📱 Suporte para múltiplas sessões simultâneas`);
  logger.info(`🔐 API Key configurada: ${API_KEY ? '✅' : '❌'}`);
  logger.info(`🪝 Webhook URL: ${WEBHOOK_URL || 'Não configurado'}`);
  logger.info(`📋 Endpoints:`);
  logger.info(`   POST /send-message     → Texto`);
  logger.info(`   POST /send-buttons     → Botões interativos`);
  logger.info(`   POST /send-list        → Menu/Lista`);
  logger.info(`   POST /send-link-button → Botão com URL`);
});

process.on('SIGINT', async () => {
  logger.info('⚠️ Desligando servidor...');
  for (const [sid] of sessions.entries()) await cleanupSession(sid);
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('⚠️ SIGTERM recebido, desligando...');
  for (const [sid] of sessions.entries()) await cleanupSession(sid);
  process.exit(0);
});
