// ============================================
// SERVIDOR BAILEYS MULTI-USUÁRIO V2
// ============================================
// Este servidor suporta múltiplas sessões simultâneas
// por user_id (não por número de telefone)
// ============================================

import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { Boom } from '@hapi/boom';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'your-secret-key-here';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

// Logger configurado
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
});

// Armazena as sessões ativas por user_id
const sessions = new Map();

// ============================================
// MIDDLEWARE DE AUTENTICAÇÃO
// ============================================
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.use(authenticate);

// ============================================
// FUNÇÃO: Obter ou criar sessão
// ============================================
function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      socket: null,
      qr: null,
      status: 'disconnected',
      phone: null,
      retryCount: 0,
      lastQrTime: null,
      authPath: `./baileys_auth_${sessionId}`,
    });
  }
  return sessions.get(sessionId);
}

// ============================================
// FUNÇÃO: Enviar webhook para Supabase
// ============================================
async function sendWebhook(type, data, sessionId) {
  if (!WEBHOOK_URL) {
    logger.warn('WEBHOOK_URL não configurado');
    return;
  }

  const payload = {
    type,
    sessionId,
    timestamp: new Date().toISOString(),
    data,
  };

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        logger.info(`✅ Webhook enviado: ${type} (${sessionId})`);
        return;
      }

      logger.warn(`⚠️ Webhook falhou (tentativa ${attempt}/${maxRetries}): ${response.status}`);
    } catch (error) {
      logger.error(`❌ Erro no webhook (tentativa ${attempt}/${maxRetries}):`, error.message);
    }

    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// ============================================
// FUNÇÃO: Limpar sessão completamente
// ============================================
async function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  
  if (session) {
    logger.info(`🧹 Limpando sessão: ${sessionId}`);
    
    // Fecha socket se existir
    if (session.socket) {
      try {
        await session.socket.logout();
      } catch (e) {
        logger.warn(`Erro ao fazer logout: ${e.message}`);
      }
      session.socket = null;
    }
    
    // Limpa dados da sessão
    session.qr = null;
    session.status = 'disconnected';
    session.phone = null;
    session.retryCount = 0;
    session.lastQrTime = null;
  }
  
  // Remove pasta de autenticação
  const authPath = `./baileys_auth_${sessionId}`;
  if (fs.existsSync(authPath)) {
    try {
      fs.rmSync(authPath, { recursive: true, force: true });
      logger.info(`📁 Pasta de auth removida: ${authPath}`);
    } catch (e) {
      logger.error(`❌ Erro ao remover pasta de auth: ${e.message}`);
    }
  }
}

// ============================================
// FUNÇÃO: Criar conexão WhatsApp
// ============================================
async function createWhatsAppConnection(sessionId, options = {}) {
  let session = getOrCreateSession(sessionId);
  
  logger.info(`🔌 Iniciando conexão para sessão: ${sessionId}`);
  
  // Limpa sessão antiga se existir
  if (session.socket) {
    logger.info('🔄 Fechando socket anterior...');
    try {
      await session.socket.logout();
    } catch (e) {
      logger.warn(`Erro ao fechar socket: ${e.message}`);
    }
    session.socket = null;
  }
  
  // Remove pasta de auth se forçado
  if (options.force || options.fresh) {
    await cleanupSession(sessionId);
    session = getOrCreateSession(sessionId);
  }
  
  // Garante que a pasta existe
  if (!fs.existsSync(session.authPath)) {
    fs.mkdirSync(session.authPath, { recursive: true });
  }
  
  try {
    const { state, saveCreds } = await useMultiFileAuthState(session.authPath);
    const { version } = await fetchLatestBaileysVersion();
    
    const socket = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: Browsers.ubuntu('Chrome'),
      getMessage: async () => null,
    });
    
    session.socket = socket;
    session.status = 'connecting';
    session.qr = null;
    session.lastQrTime = Date.now();
    
    // ============================================
    // EVENT: connection.update
    // ============================================
    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      logger.info(`[${sessionId}] 🔄 Connection update:`, {
        connection,
        hasQr: !!qr,
        reason: lastDisconnect?.error?.message,
      });
      
      // QR Code recebido
      if (qr) {
        try {
          session.qr = await qrcode.toDataURL(qr);
          session.status = 'qr_ready';
          session.lastQrTime = Date.now();
          logger.info(`[${sessionId}] 📱 QR Code gerado`);
          
          await sendWebhook('qr', { qr: session.qr }, sessionId);
        } catch (err) {
          logger.error(`[${sessionId}] ❌ Erro ao gerar QR:`, err);
        }
      }
      
      // Conectado
      if (connection === 'open') {
        const phone = socket.user?.id?.split(':')[0] || null;
        session.status = 'connected';
        session.phone = phone;
        session.qr = null;
        session.retryCount = 0;
        
        logger.info(`[${sessionId}] ✅ Conectado! Phone: ${phone}`);
        
        await sendWebhook('status-updated', { 
          connected: true,
          status: 'connected',
          phone: { number: phone }
        }, sessionId);
      }
      
      // Desconectado
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error instanceof Boom) && 
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        
        logger.warn(`[${sessionId}] ⚠️ Desconectado. Reconectar: ${shouldReconnect}`);
        
        if (shouldReconnect && session.retryCount < 3) {
          session.retryCount++;
          logger.info(`[${sessionId}] 🔄 Tentando reconectar (${session.retryCount}/3)...`);
          setTimeout(() => createWhatsAppConnection(sessionId), 5000);
        } else {
          session.status = 'disconnected';
          session.socket = null;
          session.qr = null;
          session.phone = null;
          
          await sendWebhook('status-updated', {
            connected: false,
            status: 'disconnected'
          }, sessionId);
        }
      }
    });
    
    // ============================================
    // EVENT: creds.update
    // ============================================
    socket.ev.on('creds.update', saveCreds);
    
    // ============================================
    // EVENT: messages.upsert
    // ============================================
    socket.ev.on('messages.upsert', async ({ messages }) => {
      for (const message of messages) {
        if (!message.message) continue;
        
        logger.info(`[${sessionId}] 💬 Nova mensagem:`, {
          from: message.key.remoteJid,
          id: message.key.id,
        });
        
        await sendWebhook('received-message', {
          instanceId: sessionId,
          data: {
            key: message.key,
            message: message.message,
            messageTimestamp: message.messageTimestamp,
            pushName: message.pushName,
          }
        }, sessionId);
      }
    });
    
    return socket;
  } catch (error) {
    logger.error(`[${sessionId}] ❌ Erro ao criar conexão:`, error);
    session.status = 'error';
    session.socket = null;
    throw error;
  }
}

// ============================================
// ROTAS DA API
// ============================================

/**
 * POST /create-session
 * Cria ou reconecta uma sessão
 */
app.post('/create-session', async (req, res) => {
  try {
    const { session, sessionId, force, fresh } = req.body;
    const finalSessionId = session || sessionId;
    
    if (!finalSessionId) {
      return res.status(400).json({ error: 'session ou sessionId obrigatório' });
    }
    
    logger.info(`📥 POST /create-session → ${finalSessionId}`, { force, fresh });
    
    await createWhatsAppConnection(finalSessionId, { force, fresh });
    
    const sessionData = getOrCreateSession(finalSessionId);
    
    // Aguarda QR code por até 10 segundos
    const timeout = Date.now() + 10000;
    while (Date.now() < timeout && !sessionData.qr && sessionData.status === 'connecting') {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    res.json({
      success: true,
      status: sessionData.status,
      qr: sessionData.qr,
      qrcode: sessionData.qr,
      phone: sessionData.phone,
      sessionId: finalSessionId,
    });
  } catch (error) {
    logger.error('❌ Erro em /create-session:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /sessions/:sessionId/qrcode
 * Retorna QR code de uma sessão específica
 */
app.get('/sessions/:sessionId/qrcode', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }
  
  // QR code expira em 60 segundos
  const qrAge = session.lastQrTime ? Date.now() - session.lastQrTime : null;
  const qrExpired = qrAge && qrAge > 60000;
  
  res.json({
    status: session.status,
    qr: qrExpired ? null : session.qr,
    qrcode: qrExpired ? null : session.qr,
    phone: session.phone,
    qrExpired,
    qrAge,
  });
});

/**
 * GET /qrcode
 * Retorna QR code da primeira sessão disponível ou específica
 */
app.get('/qrcode', (req, res) => {
  const sessionId = req.query.sessionId;
  
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      const qrAge = session.lastQrTime ? Date.now() - session.lastQrTime : null;
      const qrExpired = qrAge && qrAge > 60000;
      
      return res.json({
        status: session.status,
        qr: qrExpired ? null : session.qr,
        qrcode: qrExpired ? null : session.qr,
        phone: session.phone,
      });
    }
  }
  
  // Retorna primeira sessão com QR ativo
  for (const [id, session] of sessions.entries()) {
    const qrAge = session.lastQrTime ? Date.now() - session.lastQrTime : null;
    const qrExpired = qrAge && qrAge > 60000;
    
    if (session.qr && !qrExpired) {
      return res.json({
        status: session.status,
        qr: session.qr,
        qrcode: session.qr,
        phone: session.phone,
        sessionId: id,
      });
    }
  }
  
  res.json({
    status: 'disconnected',
    qr: null,
    qrcode: null,
    phone: null,
  });
});

/**
 * GET /status
 * Retorna status de todas as sessões
 */
app.get('/status', (req, res) => {
  const sessionsStatus = {};
  
  for (const [id, session] of sessions.entries()) {
    sessionsStatus[id] = {
      status: session.status,
      phone: session.phone,
      hasQr: !!session.qr,
      retryCount: session.retryCount,
    };
  }
  
  res.json({
    sessions: sessionsStatus,
    total: sessions.size,
  });
});

/**
 * DELETE /sessions/:sessionId
 * Remove sessão completamente
 */
app.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    logger.info(`🗑️ DELETE /sessions/${sessionId}`);
    
    await cleanupSession(sessionId);
    sessions.delete(sessionId);
    
    res.json({ success: true, message: 'Sessão removida' });
  } catch (error) {
    logger.error('❌ Erro em DELETE /sessions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /sessions/:sessionId/disconnect
 * Desconecta sessão sem remover dados
 */
app.post('/sessions/:sessionId/disconnect', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }
    
    logger.info(`🔌 POST /sessions/${sessionId}/disconnect`);
    
    if (session.socket) {
      await session.socket.logout();
      session.socket = null;
    }
    
    session.status = 'disconnected';
    session.qr = null;
    session.phone = null;
    
    await sendWebhook('status-updated', {
      connected: false,
      status: 'disconnected'
    }, sessionId);
    
    res.json({ success: true, message: 'Sessão desconectada' });
  } catch (error) {
    logger.error('❌ Erro em POST /disconnect:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /disconnect
 * Alias para /sessions/:sessionId/disconnect (compatibilidade)
 */
app.post('/disconnect', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId obrigatório' });
    }
    
    req.params.sessionId = sessionId;
    return app._router.handle(req, res);
  } catch (error) {
    logger.error('❌ Erro em POST /disconnect:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /session/:sessionId?
 * Alias para /sessions/:sessionId (compatibilidade)
 */
app.delete('/session/:sessionId?', async (req, res) => {
  const sessionId = req.params.sessionId || 'default';
  req.params.sessionId = sessionId;
  
  await cleanupSession(sessionId);
  sessions.delete(sessionId);
  
  res.json({ success: true, message: 'Sessão removida' });
});

/**
 * POST /send-message
 * Envia mensagem de texto
 */
app.post('/send-message', async (req, res) => {
  try {
    const { sessionId, to, phone, message, text } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId obrigatório' });
    }
    
    const recipient = to || phone;
    const content = message || text;
    
    if (!recipient || !content) {
      return res.status(400).json({ error: 'destinatário e mensagem são obrigatórios' });
    }
    
    const session = sessions.get(sessionId);
    
    if (!session || !session.socket) {
      return res.status(404).json({ error: 'Sessão não encontrada ou desconectada' });
    }
    
    const jid = recipient.includes('@') ? recipient : `${recipient}@s.whatsapp.net`;
    
    const result = await session.socket.sendMessage(jid, { text: content });
    
    logger.info(`✉️ Mensagem enviada: ${sessionId} → ${recipient}`);
    
    res.json({
      success: true,
      messageId: result.key.id,
      to: jid,
    });
  } catch (error) {
    logger.error('❌ Erro em /send-message:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /health
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ============================================
// SERVIDOR
// ============================================
app.listen(PORT, () => {
  logger.info(`🚀 Servidor Baileys Multi-usuário V2 rodando na porta ${PORT}`);
  logger.info(`🔐 API Key configurada: ${API_KEY ? 'Sim' : 'Não'}`);
  logger.info(`🔗 Webhook URL: ${WEBHOOK_URL || 'Não configurado'}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('🛑 Encerrando servidor...');
  
  for (const [id, session] of sessions.entries()) {
    if (session.socket) {
      try {
        await session.socket.logout();
        logger.info(`Sessão ${id} desconectada`);
      } catch (e) {
        logger.warn(`Erro ao desconectar ${id}:`, e.message);
      }
    }
  }
  
  process.exit(0);
});
