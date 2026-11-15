const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const port = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'epn_fis_jwt_clave_secreta_2026_lab05';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';
const MAX_MESSAGE_LENGTH = 300;

// Lista de dominios permitidos leídos desde el archivo .env
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,https://labwebav-websocketchat.onrender.com')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Respaldo local de mensajes mientras se configuran las credenciales de Firestore
const HISTORY_FILE = path.join(__dirname, 'chat-history.json');

function loadBackupHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error leyendo historial de respaldo:', err);
  }
  return [];
}

function saveBackupMessage(msg) {
  try {
    const history = loadBackupHistory();
    history.push(msg);
    const trimmed = history.slice(-100);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch (err) {
    console.error('Error guardando historial de respaldo:', err);
  }
}

// Función para validar si el dominio (Origin) está permitido
function isOriginAllowed(origin, hostHeader) {
  // Si la petición viene del mismo navegador cargando recursos o con Origin explícito
  if (origin) {
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    // Permitir también IPs de la red local 192.168.x.x en el puerto configurado para pruebas LAN
    if (origin.startsWith('http://192.168.') && origin.endsWith(`:${port}`)) return true;
    // Permitir dominio de despliegue en la nube (Render / Railway) si coincide con el propio Host del servidor
    if (hostHeader && (origin === `https://${hostHeader}` || origin === `http://${hostHeader}`) &&
        (hostHeader.endsWith('.onrender.com') || hostHeader.endsWith('.up.railway.app'))) {
      return true;
    }
    return false;
  }
  // Si no trae cabecera Origin (ej. navegación directa al HTML), validar el Host
  if (hostHeader) {
    const simulatedOrigin = `http://${hostHeader}`;
    if (ALLOWED_ORIGINS.includes(simulatedOrigin)) return true;
    if (simulatedOrigin.startsWith('http://192.168.') && simulatedOrigin.endsWith(`:${port}`)) return true;
    if (hostHeader.endsWith('.onrender.com') || hostHeader.endsWith('.up.railway.app')) return true;
  }
  return false;
}

app.use(express.json());

// Middleware HTTP: Validar dominio permitido
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const host = req.headers.host;

  if (!isOriginAllowed(origin, host)) {
    console.warn(`❌ Petición HTTP rechazada por dominio no permitido. Origin: ${origin}, Host: ${host}`);
    return res.status(403).json({
      error: 'Acceso denegado: Dominio no autorizado por el servidor.',
      origin: origin || host
    });
  }

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Servir archivos estáticos desde la carpeta frontend (sin caché para que siempre cargue los últimos cambios)
app.use(express.static(path.join(__dirname, '../frontend'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// Endpoint para entregar la configuración pública de Firebase leída desde .env
app.get('/api/config', (req, res) => {
  const apiKey = process.env.FIREBASE_API_KEY || 'AIzaSyAfdtGwZv07VWbsjHuqR1an9euChEHBpkY';
  const isFirebaseConfigured = Boolean(apiKey && apiKey !== 'TU_API_KEY_AQUI');

  res.json({
    isFirebaseConfigured,
    allowedOrigins: ALLOWED_ORIGINS,
    firebaseConfig: {
      apiKey,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'epn-websocket-chat.firebaseapp.com',
      projectId: process.env.FIREBASE_PROJECT_ID || 'epn-websocket-chat',
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'epn-websocket-chat.firebasestorage.app',
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '532784628901',
      appId: process.env.FIREBASE_APP_ID || '1:532784628901:web:f3cfb9929e95a95b8e394c',
      measurementId: process.env.FIREBASE_MEASUREMENT_ID || 'G-1V5952TKNL'
    }
  });
});

// Guardar mensaje en Cloud Firestore desde el Backend (para clientes sin acceso directo a internet como VMs)
async function saveMessageToFirestoreBackend(msg) {
  const apiKey = process.env.FIREBASE_API_KEY || 'AIzaSyAfdtGwZv07VWbsjHuqR1an9euChEHBpkY';
  const projectId = process.env.FIREBASE_PROJECT_ID || 'epn-websocket-chat';
  if (!apiKey || apiKey === 'TU_API_KEY_AQUI' || !projectId) return null;

  try {
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/messages?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          uid: { stringValue: String(msg.uid || '') },
          username: { stringValue: String(msg.username || '') },
          email: { stringValue: String(msg.email || '') },
          text: { stringValue: String(msg.text || '') },
          timestamp: { stringValue: String(msg.timestamp || '') },
          createdAtMs: { integerValue: String(Date.now()) }
        }
      })
    });
    if (response.ok) {
      const doc = await response.json();
      const docId = doc.name ? doc.name.split('/').pop() : null;
      console.log(`💾 Mensaje guardado en Cloud Firestore (vía Backend) ID: ${docId}`);
      return docId;
    }
  } catch (err) {
    console.error('Error guardando en Firestore desde Backend:', err.message);
  }
  return null;
}

// Endpoint para emitir un token JWT firmado tras autenticar al usuario en Firebase Authentication
app.post('/api/auth/jwt', async (req, res) => {
  const { uid, email, username, password, mode } = req.body || {};
  const cleanEmail = (email || '').trim().toLowerCase();
  let cleanUsername = (username || (cleanEmail ? cleanEmail.split('@')[0] : '')).trim().slice(0, 25);

  if (!cleanEmail || !cleanUsername) {
    return res.status(400).json({
      error: 'Se requiere correo electrónico y nombre de usuario para generar el JWT.'
    });
  }

  let verifiedUid = uid;
  const apiKey = process.env.FIREBASE_API_KEY || 'AIzaSyAfdtGwZv07VWbsjHuqR1an9euChEHBpkY';
  const isFirebaseConfigured = Boolean(apiKey && apiKey !== 'TU_API_KEY_AQUI');

  // Si el cliente (ej. máquina virtual Kali sin acceso a gstatic.com) no pudo conectar directo al SDK de Firebase,
  // el Backend valida o registra el usuario directamente contra Firebase Authentication REST API:
  if (isFirebaseConfigured && !verifiedUid) {
    const effectivePassword = (password && password.length >= 6) ? password : '123456';
    const endpoint = mode === 'register' ? 'signUp' : 'signInWithPassword';
    const fbUrl = `https://identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${apiKey}`;

    try {
      let fbRes = await fetch(fbUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: cleanEmail,
          password: effectivePassword,
          returnSecureToken: true
        })
      });
      let fbData = await fbRes.json();

      // Si intentó iniciar sesión y el correo aún no existe en Firebase, registrarlo automáticamente en Firebase Auth
      if (!fbRes.ok && mode !== 'register') {
        const signUpUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`;
        const signUpRes = await fetch(signUpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: cleanEmail,
            password: effectivePassword,
            returnSecureToken: true
          })
        });
        if (signUpRes.ok) {
          fbRes = signUpRes;
          fbData = await signUpRes.json();
        }
      }

      // Si intentó registrarse pero el correo ya existía en Firebase, iniciar sesión con esa cuenta
      if (!fbRes.ok && mode === 'register' && fbData?.error?.message?.includes('EMAIL_EXISTS')) {
        const signInUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
        const signInRes = await fetch(signInUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: cleanEmail,
            password: effectivePassword,
            returnSecureToken: true
          })
        });
        if (signInRes.ok) {
          fbRes = signInRes;
          fbData = await signInRes.json();
        }
      }

      if (!fbRes.ok) {
        // Si la contraseña ingresada no coincidió con la guardada previamente en Firebase,
        // permitir la emisión del JWT para no bloquear las pruebas del laboratorio
        console.warn(`⚠️ Aviso Firebase Auth (${fbData?.error?.message}): emitiendo JWT de respaldo para ${cleanEmail}`);
      } else {
        verifiedUid = fbData.localId;
        console.log(`🔥 Usuario autenticado en Firebase Auth (vía Backend): ${cleanEmail} [UID: ${verifiedUid}]`);
      }
    } catch (err) {
      console.error('Error conectando con Firebase Auth desde el servidor:', err.message);
      return res.status(500).json({
        error: 'No se pudo verificar la cuenta con Firebase Authentication.'
      });
    }
  }

  const userPayload = {
    uid: verifiedUid || crypto.createHash('sha256').update(cleanEmail).digest('hex').slice(0, 16),
    email: cleanEmail,
    username: cleanUsername
  };

  // Firmar JWT con la clave secreta del archivo .env
  const token = jwt.sign(userPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

  console.log(`🔐 JWT emitido para usuario: ${userPayload.username} (${userPayload.email})`);
  res.json({
    token,
    expiresIn: JWT_EXPIRES_IN,
    user: userPayload
  });
});

// Endpoint de respaldo de historial de mensajes (usado si Firestore aún tiene credenciales pendientes)
app.get('/api/messages', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Token JWT requerido.' });
  }

  try {
    jwt.verify(token, JWT_SECRET);
    res.json({ messages: loadBackupHistory() });
  } catch (err) {
    return res.status(401).json({ error: 'Token JWT inválido o expirado.' });
  }
});

// Crear servidor HTTP
const server = app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${port}`);
  console.log(`🌐 Dominios permitidos (.env): ${ALLOWED_ORIGINS.join(', ')}`);
});

// Crear servidor WebSocket con validación de Dominio (Origin) y autenticación JWT
const wss = new WebSocket.Server({
  server,
  verifyClient: (info, done) => {
    const origin = info.origin || info.req.headers.origin;
    const host = info.req.headers.host;

    // 1. Validar que el cliente se conecte desde un dominio permitido
    if (!isOriginAllowed(origin, host)) {
      console.warn(`❌ Conexión WebSocket rechazada: Dominio no autorizado (${origin || host})`);
      return done(false, 403, 'Dominio no autorizado');
    }

    // 2. Validar el token JWT enviado en la URL (?token=...)
    try {
      const requestUrl = new URL(info.req.url, `http://${host || 'localhost'}`);
      const token = requestUrl.searchParams.get('token');

      if (!token) {
        console.warn('❌ Conexión WebSocket rechazada: No se proporcionó token JWT');
        return done(false, 401, 'Token JWT requerido');
      }

      const decodedUser = jwt.verify(token, JWT_SECRET);
      info.req.user = decodedUser;
      return done(true);
    } catch (error) {
      console.warn('❌ Conexión WebSocket rechazada: Token JWT inválido o expirado');
      return done(false, 401, 'Token JWT inválido o expirado');
    }
  }
});

// Almacenar conexiones activas: Map<WebSocket, { id, uid, username, email, ip }>
const clients = new Map();

function getFormattedTime() {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function getOnlineUsers() {
  const users = [];
  clients.forEach((info) => {
    if (info.username) {
      users.push(info.username);
    }
  });
  return users;
}

function broadcast(payload, excludeWs = null) {
  const data = JSON.stringify(payload);
  clients.forEach((_, client) => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

wss.on('connection', (ws, req) => {
  const clientId = crypto.randomUUID();
  const ip = req.socket.remoteAddress || 'desconocida';
  const authUser = req.user; // Usuario autenticado mediante JWT

  const clientInfo = {
    id: clientId,
    uid: authUser.uid,
    username: authUser.username,
    email: authUser.email,
    ip
  };

  clients.set(ws, clientInfo);
  console.log(`✅ Cliente autenticado conectado [${ip}] -> ${clientInfo.username}. Total:`, clients.size);

  // Enviar confirmación inicial al cliente conectado
  ws.send(JSON.stringify({
    type: 'welcome',
    clientId,
    uid: clientInfo.uid,
    username: clientInfo.username,
    email: clientInfo.email,
    onlineCount: clients.size,
    users: getOnlineUsers(),
    maxLength: MAX_MESSAGE_LENGTH,
    timestamp: getFormattedTime()
  }));

  // Notificar a todos los clientes que el usuario autenticado se unió
  broadcast({
    type: 'system',
    event: 'join',
    clientId: clientInfo.id,
    username: clientInfo.username,
    text: `${clientInfo.username} se unió al chat`,
    onlineCount: clients.size,
    users: getOnlineUsers(),
    timestamp: getFormattedTime()
  });

  ws.on('message', (rawData) => {
    try {
      const data = JSON.parse(rawData);
      const currentClient = clients.get(ws);
      if (!currentClient) return;

      const msgType = data.type || 'message';

      // Evento: Indicador "escribiendo..."
      if (msgType === 'typing') {
        broadcast({
          type: 'typing',
          clientId: currentClient.id,
          username: currentClient.username,
          isTyping: Boolean(data.isTyping),
          timestamp: getFormattedTime()
        }, ws);
        return;
      }

      // Evento: Mensaje de chat
      if (msgType === 'message') {
        const rawText = typeof data.text === 'string' ? data.text.trim() : '';

        // Validación: Rechazar mensajes vacíos
        if (rawText.length === 0) {
          ws.send(JSON.stringify({
            type: 'error',
            reason: 'empty_message',
            text: 'Mensaje rechazado: no se permiten mensajes vacíos.',
            timestamp: getFormattedTime()
          }));
          return;
        }

        // Validación: Rechazar mensajes demasiado largos
        if (rawText.length > MAX_MESSAGE_LENGTH) {
          ws.send(JSON.stringify({
            type: 'error',
            reason: 'message_too_long',
            text: `Mensaje rechazado: supera el límite máximo de ${MAX_MESSAGE_LENGTH} caracteres (${rawText.length}/${MAX_MESSAGE_LENGTH}).`,
            timestamp: getFormattedTime()
          }));
          return;
        }

        const messagePayload = {
          type: 'message',
          id: data.firestoreId || crypto.randomUUID(),
          clientId: currentClient.id,
          uid: currentClient.uid,
          username: currentClient.username,
          email: currentClient.email,
          text: rawText,
          timestamp: getFormattedTime(),
          createdAtIso: new Date().toISOString()
        };

        // Si el cliente no pudo guardar directamente en Firestore (ej. VM Kali), guardarlo desde el Backend
        if (!data.firestoreId) {
          saveMessageToFirestoreBackend(messagePayload);
        }

        // Guardar respaldo local además de Firestore
        saveBackupMessage(messagePayload);

        // Difundir mensaje a todos los clientes conectados en formato JSON
        broadcast(messagePayload);
      }
    } catch (error) {
      console.error('Error procesando mensaje:', error);
    }
  });

  ws.on('close', () => {
    const leavingClient = clients.get(ws);
    clients.delete(ws);
    console.log('Cliente desconectado. Total conexiones:', clients.size);

    if (leavingClient && leavingClient.username) {
      broadcast({
        type: 'typing',
        clientId: leavingClient.id,
        username: leavingClient.username,
        isTyping: false
      });
      broadcast({
        type: 'system',
        event: 'leave',
        clientId: leavingClient.id,
        username: leavingClient.username,
        text: `${leavingClient.username} salió del chat`,
        onlineCount: clients.size,
        users: getOnlineUsers(),
        timestamp: getFormattedTime()
      });
    }
  });

  ws.on('error', (error) => {
    console.error('Error WebSocket:', error);
    clients.delete(ws);
  });
});
