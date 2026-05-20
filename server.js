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
// MAPA DE JIDs REAIS (corrige contato fantasma + LID)
//
// O WhatsApp agora usa dois sistemas de ID:
//   @s.whatsapp.net  → ID antigo (número de telefone)
//   @lid             → ID novo interno do WhatsApp
//
// Quando o lead manda mensagem, chegam os dois:
//   remoteJid:    '137199139950666@lid'       ← ID novo
//   remoteJidAlt: '5511999999999@s.whatsapp.net' ← número real
//
// Salvamos o mapeamento: número limpo → jid correto para responder
// ============================================
const jidMap = new Map(); // phone_limpo -> jid_para_responder

function saveJidFromMessage(msgKey) {
  if (!msgKey) return;

  const remoteJid    = msgKey.remoteJid || '';
  const remoteJidAlt = msgKey.remoteJidAlt || '';

  // Ignora grupos
  if (remoteJid.endsWith('@g.us')) return;

  // Se veio com @lid, temos o JID novo e o número alternativo
  if (remoteJid.endsWith('@lid') && remoteJidAlt) {
    // Extrai o número limpo do Alt (número de telefone real)
    const phone = remoteJidAlt.replace(/\D/g, '').split('@')[0].split(':')[0];
    // Salva: número limpo → jid @lid (é o que o WhatsApp espera agora)
    jidMap.set(phone, remoteJid);
    logger.info(`[JID] Mapeado ${phone} → ${remoteJid} (LID)`);
  } else if (remoteJid.endsWith('@s.whatsapp.net')) {
    // Sistema antigo: salva o número → jid normal
    const phone = remoteJid.replace(/\D/g, '').split('@')[0].split(':')[0];
    // Só salva se ainda não temos mapeamento LID para esse número
    if (!jidMap.has(phone)) {
      jidMap.set(phone, remoteJid);
    }
  }
}

function resolveJid(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/\D/g, '').split('@')[0].split(':')[0];

  // Se já vimos esse lead, usa o JID exato que o WhatsApp usa
  if (jidMap.has(cleaned)) {
    const resolved = jidMap.get(cleaned);
    logger.info(`[JID] Resolvido ${cleaned} → ${resolved}`);
    return resolved;
  }

  // Fallback: monta JID padrão com número de telefone
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
// SESSÕES
// ============================================
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

// ============================================
// CRIAR CONEXÃO WHATSAPP
// ============================================
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
    syncFullHistory: fal
