const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIG
// ============================================
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'sinalverde-whatsapp-key-2026';
const AUTH_DIR = process.env.AUTH_DIR || './auth_data';
const LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

// ============================================
// STATE
// ============================================
let sock = null;
let qrCode = null;          // último QR code gerado (base64 data URI)
let qrCodeRaw = null;       // QR code texto puro
let connectionStatus = 'disconnected'; // disconnected | connecting | connected
let connectedPhone = null;  // número conectado
let messagesSent = 0;
let lastError = null;

// ============================================
// LOGGER
// ============================================
const logger = pino({ level: LOG_LEVEL });

// ============================================
// WHATSAPP CONNECTION
// ============================================
async function connectWhatsApp() {
  if (connectionStatus === 'connecting') {
    console.log('[WA] Já está conectando, aguardando...');
    return;
  }

  connectionStatus = 'connecting';
  qrCode = null;
  qrCodeRaw = null;
  lastError = null;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }),
      browser: ['SinalVerde', 'Chrome', '120.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 30000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 500,
      markOnlineOnConnect: false,
    });

    // Save credentials on update
    sock.ev.on('creds.update', saveCreds);

    // Connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('[WA] QR Code gerado — escaneie com o celular');
        qrCodeRaw = qr;
        try {
          qrCode = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        } catch (e) {
          console.error('[WA] Erro ao gerar QR base64:', e.message);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = DisconnectReason;
        
        connectionStatus = 'disconnected';
        connectedPhone = null;
        
        console.log(`[WA] Desconectado — código: ${statusCode}`);

        if (statusCode === reason.loggedOut) {
          console.log('[WA] Deslogado — limpando sessão. Precisa escanear QR novamente.');
          // Limpar auth data
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (e) {}
          lastError = 'Sessão encerrada. Escaneie o QR Code novamente.';
        } else if (statusCode === reason.restartRequired) {
          console.log('[WA] Restart necessário, reconectando...');
          setTimeout(connectWhatsApp, 2000);
        } else if (statusCode !== reason.connectionClosed) {
          console.log('[WA] Reconectando em 5s...');
          lastError = `Desconectado (código ${statusCode}). Reconectando...`;
          setTimeout(connectWhatsApp, 5000);
        }
      }

      if (connection === 'open') {
        connectionStatus = 'connected';
        qrCode = null;
        qrCodeRaw = null;
        lastError = null;

        // Extrair número conectado
        const me = sock.user;
        connectedPhone = me?.id?.split(':')[0] || me?.id?.split('@')[0] || 'desconhecido';
        console.log(`[WA] ✅ Conectado como ${connectedPhone}`);
      }
    });

  } catch (err) {
    console.error('[WA] Erro ao conectar:', err.message);
    connectionStatus = 'disconnected';
    lastError = err.message;
  }
}

// ============================================
// SEND MESSAGE
// ============================================
async function sendMessage(phone, message) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp não está conectado');
  }

  // Normalizar número: remover tudo que não é dígito
  let number = phone.replace(/\D/g, '');
  
  // Se começar com 0, remover
  if (number.startsWith('0')) number = number.substring(1);
  
  // Se não começar com 55 (Brasil), adicionar
  if (!number.startsWith('55')) number = '55' + number;
  
  // Formato WhatsApp: 5521999998888@s.whatsapp.net
  const jid = number + '@s.whatsapp.net';

  try {
    // Verificar se número existe no WhatsApp
    const [exists] = await sock.onWhatsApp(jid);
    if (!exists?.exists) {
      throw new Error(`Número ${phone} não encontrado no WhatsApp`);
    }

    await sock.sendMessage(exists.jid, { text: message });
    messagesSent++;
    console.log(`[WA] ✉️ Mensagem enviada para ${phone}`);
    return { success: true, jid: exists.jid };
  } catch (err) {
    console.error(`[WA] Erro ao enviar para ${phone}:`, err.message);
    throw err;
  }
}

// ============================================
// EXPRESS API
// ============================================
const app = express();
app.use(express.json());

// Auth middleware
function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'API Key inválida' });
  }
  next();
}

// Health check (sem auth)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    whatsapp: connectionStatus,
    phone: connectedPhone,
    messagesSent,
    uptime: Math.floor(process.uptime()),
  });
});

// Status completo
app.get('/status', authMiddleware, (req, res) => {
  res.json({
    status: connectionStatus,
    phone: connectedPhone,
    messagesSent,
    lastError,
    hasQrCode: !!qrCode,
    uptime: Math.floor(process.uptime()),
  });
});

// Obter QR Code (retorna imagem base64 ou JSON)
app.get('/qr', authMiddleware, (req, res) => {
  if (connectionStatus === 'connected') {
    return res.json({ status: 'connected', phone: connectedPhone, message: 'Já está conectado!' });
  }
  if (!qrCode) {
    return res.json({ status: 'waiting', message: 'QR Code ainda não foi gerado. Aguarde ou chame /connect.' });
  }
  
  // Se pedir como imagem
  if (req.query.format === 'image') {
    const base64Data = qrCode.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    res.setHeader('Content-Type', 'image/png');
    return res.send(buffer);
  }
  
  res.json({ status: 'qr_ready', qrCode, qrCodeRaw });
});

// Forçar conexão / reconexão
app.post('/connect', authMiddleware, async (req, res) => {
  if (connectionStatus === 'connected') {
    return res.json({ status: 'already_connected', phone: connectedPhone });
  }
  
  // Limpar sessão se pedido
  if (req.body?.reset) {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('[WA] Sessão limpa — novo QR será gerado');
    } catch (e) {}
  }
  
  connectWhatsApp();
  res.json({ status: 'connecting', message: 'Conectando... Acesse /qr para obter o QR Code.' });
});

// Desconectar
app.post('/disconnect', authMiddleware, async (req, res) => {
  if (sock) {
    try {
      await sock.logout();
    } catch (e) {}
    sock = null;
  }
  connectionStatus = 'disconnected';
  connectedPhone = null;
  qrCode = null;
  
  // Limpar sessão
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch (e) {}
  
  res.json({ status: 'disconnected', message: 'Desconectado e sessão limpa.' });
});

// Enviar mensagem
app.post('/send', authMiddleware, async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: 'Campos "phone" e "message" são obrigatórios' });
  }

  try {
    const result = await sendMessage(phone, message);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Enviar mensagem em lote (com delay entre cada)
app.post('/send-batch', authMiddleware, async (req, res) => {
  const { messages } = req.body; // [{ phone, message }]

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Campo "messages" deve ser um array de { phone, message }' });
  }

  if (messages.length > 50) {
    return res.status(400).json({ error: 'Máximo 50 mensagens por lote' });
  }

  const results = [];
  for (const msg of messages) {
    try {
      const result = await sendMessage(msg.phone, msg.message);
      results.push({ phone: msg.phone, success: true, ...result });
    } catch (err) {
      results.push({ phone: msg.phone, success: false, error: err.message });
    }
    // Delay entre mensagens (2-5s aleatório) para evitar ban
    await delay(2000 + Math.random() * 3000);
  }

  const sent = results.filter(r => r.success).length;
  const failed = results.length - sent;
  res.json({ total: results.length, sent, failed, results });
});

// ============================================
// START
// ============================================
app.listen(PORT, () => {
  console.log(`[WA] 🚀 API rodando na porta ${PORT}`);
  console.log(`[WA] API Key: ${API_KEY.substring(0, 10)}...`);
  
  // Auto-conectar se já tiver sessão salva
  if (fs.existsSync(AUTH_DIR)) {
    console.log('[WA] Sessão encontrada — reconectando automaticamente...');
    connectWhatsApp();
  } else {
    console.log('[WA] Sem sessão — chame POST /connect para gerar QR Code');
  }
});
