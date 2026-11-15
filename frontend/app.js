// ============================================================================
// EPN FIS WebChat Seguro - Cliente WebSocket + Firebase Auth + Firestore + JWT
// ============================================================================

const MAX_MESSAGE_LENGTH = 300;
const THEME_STORAGE_KEY = 'epn_webchat_theme';
const SESSION_AUTH_KEY = 'epn_webchat_auth_session';

let ws = null;
let connected = false;
let myClientId = null;
let currentUser = null; // { uid, email, username }
let jwtToken = null;
let authMode = 'login'; // 'login' | 'register'

// Instancias de Firebase
let isFirebaseReady = false;
let firebaseAuth = null;
let firestoreDb = null;

let typingTimeout = null;
let isCurrentlyTyping = false;
let alertTimeout = null;
let reconnectTimer = null;

// Mapa de usuarios escribiendo: Map<username, timeoutId>
const typingUsers = new Map();
// Conjunto de IDs de mensajes renderizados para evitar duplicados al cargar Firestore
const renderedMessageIds = new Set();

// Referencias del DOM
const htmlRoot = document.documentElement;
const themeToggleBtn = document.getElementById('themeToggleBtn');
const themeIcon = document.getElementById('themeIcon');
const themeLabel = document.getElementById('themeLabel');

const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const onlineCountNum = document.getElementById('onlineCountNum');
const securityBadge = document.getElementById('securityBadge');

const activeUserBar = document.getElementById('activeUserBar');
const currentUsernameLabel = document.getElementById('currentUsernameLabel');
const logoutBtn = document.getElementById('logoutBtn');

const authOverlay = document.getElementById('authOverlay');
const authTitle = document.getElementById('authTitle');
const firebaseStatusBanner = document.getElementById('firebaseStatusBanner');
const tabLoginBtn = document.getElementById('tabLoginBtn');
const tabRegisterBtn = document.getElementById('tabRegisterBtn');
const authForm = document.getElementById('authForm');
const authUsername = document.getElementById('authUsername');
const authEmail = document.getElementById('authEmail');
const authPassword = document.getElementById('authPassword');
const authErrorBox = document.getElementById('authErrorBox');
const authSubmitBtn = document.getElementById('authSubmitBtn');

const messagesArea = document.getElementById('messages');
const typingContainer = document.getElementById('typingContainer');
const typingText = document.getElementById('typingText');
const validationAlert = document.getElementById('validationAlert');
const validationAlertText = document.getElementById('validationAlertText');

const messageInput = document.getElementById('messageInput');
const charCounter = document.getElementById('charCounter');
const sendBtn = document.getElementById('sendBtn');

// ============================================================================
// 1. Modo Claro / Oscuro con persistencia en localStorage
// ============================================================================
function applyTheme(theme) {
    const validTheme = theme === 'dark' ? 'dark' : 'light';
    htmlRoot.setAttribute('data-theme', validTheme);
    localStorage.setItem(THEME_STORAGE_KEY, validTheme);

    if (validTheme === 'dark') {
        themeIcon.textContent = '☀️';
        themeLabel.textContent = 'Claro';
    } else {
        themeIcon.textContent = '🌙';
        themeLabel.textContent = 'Oscuro';
    }
}

function initTheme() {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'light';
    applyTheme(savedTheme);
}

themeToggleBtn.addEventListener('click', () => {
    const currentTheme = htmlRoot.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
});

// ============================================================================
// 2. Inicialización de Configuración desde .env (/api/config) y Firebase
// ============================================================================
async function initializeAppConfig() {
    try {
        const res = await fetch('/api/config');
        const configData = await res.json();

        if (configData.isFirebaseConfigured && window.firebase) {
            if (!firebase.apps.length) {
                firebase.initializeApp(configData.firebaseConfig);
            }
            firebaseAuth = firebase.auth();
            firestoreDb = firebase.firestore();
            isFirebaseReady = true;
            firebaseStatusBanner.textContent = '🔥 Conectado a Firebase Auth + Cloud Firestore (.env)';
            securityBadge.textContent = '🔥 Firebase + 🔐 JWT';
        } else if (configData.isFirebaseConfigured) {
            isFirebaseReady = false;
            firebaseStatusBanner.textContent = '🔥 Conectado a Firebase Auth + Firestore vía Servidor (.env)';
            securityBadge.textContent = '🔥 Firebase + 🔐 JWT';
        } else {
            isFirebaseReady = false;
            firebaseStatusBanner.textContent = '⚙️ Modo JWT Activo (Credenciales Firebase en .env listas para reemplazar)';
            securityBadge.textContent = '🔐 JWT Activo';
        }
    } catch (err) {
        console.error('Error cargando /api/config:', err);
        firebaseStatusBanner.textContent = '⚠️ Error cargando configuración del servidor';
    }

    // Restaurar sesión de esta pestaña si existe
    const savedSession = sessionStorage.getItem(SESSION_AUTH_KEY);
    if (savedSession) {
        try {
            const parsed = JSON.parse(savedSession);
            if (parsed.token && parsed.user) {
                jwtToken = parsed.token;
                currentUser = parsed.user;
                onLoginSuccess();
            }
        } catch (_) {
            sessionStorage.removeItem(SESSION_AUTH_KEY);
        }
    }
}

// ============================================================================
// 3. Autenticación (Firebase Authentication + Emisión de Token JWT)
// ============================================================================
function setAuthMode(mode) {
    authMode = mode;
    authErrorBox.classList.add('hidden');
    if (mode === 'login') {
        tabLoginBtn.classList.add('active');
        tabRegisterBtn.classList.remove('active');
        authTitle.textContent = 'Iniciar Sesión';
        authSubmitBtn.textContent = 'Iniciar Sesión y Entrar';
    } else {
        tabRegisterBtn.classList.add('active');
        tabLoginBtn.classList.remove('active');
        authTitle.textContent = 'Crear Cuenta';
        authSubmitBtn.textContent = 'Registrarse y Entrar';
    }
}

tabLoginBtn.addEventListener('click', () => setAuthMode('login'));
tabRegisterBtn.addEventListener('click', () => setAuthMode('register'));

function showAuthError(msg) {
    authErrorBox.textContent = `⚠️ ${msg}`;
    authErrorBox.classList.remove('hidden');
}

authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authErrorBox.classList.add('hidden');

    const usernameVal = authUsername.value.trim();
    const emailVal = authEmail.value.trim();
    const passwordVal = authPassword.value;

    if (!emailVal || ! emailVal.includes('@')) {
        showAuthError('Ingresa un correo electrónico válido.');
        return;
    }
    if (!passwordVal || passwordVal.length < 6) {
        showAuthError('La contraseña debe tener al menos 6 caracteres.');
        return;
    }
    if (authMode === 'register' && !usernameVal) {
        showAuthError('Ingresa un nombre de usuario para registrarte.');
        return;
    }

    authSubmitBtn.disabled = true;
    authSubmitBtn.textContent = 'Autenticando...';

    try {
        let uid = null;
        let finalUsername = usernameVal || emailVal.split('@')[0];

        // Si Firebase tiene credenciales reales en .env, autenticar contra Firebase Auth
        if (isFirebaseReady && firebaseAuth) {
            try {
                let userCredential;
                if (authMode === 'register') {
                    userCredential = await firebaseAuth.createUserWithEmailAndPassword(emailVal, passwordVal);
                    if (usernameVal && userCredential.user) {
                        await userCredential.user.updateProfile({ displayName: usernameVal });
                    }
                } else {
                    userCredential = await firebaseAuth.signInWithEmailAndPassword(emailVal, passwordVal);
                }
                const fbUser = userCredential.user;
                uid = fbUser.uid;
                finalUsername = usernameVal || fbUser.displayName || emailVal.split('@')[0];
            } catch (fbErr) {
                console.warn('Delegando validación de cuenta al Backend:', fbErr.message);
            }
        }

        // Solicitar Token JWT firmado al Backend (si el cliente está en una VM sin salida a gstatic.com, el Backend autentica contra Firebase Auth)
        const jwtResponse = await fetch('/api/auth/jwt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uid,
                email: emailVal,
                username: finalUsername,
                password: passwordVal,
                mode: authMode
            })
        });

        const jwtData = await jwtResponse.json();
        if (!jwtResponse.ok) {
            throw new Error(jwtData.error || 'No se pudo generar el token JWT.');
        }

        jwtToken = jwtData.token;
        currentUser = jwtData.user;

        sessionStorage.setItem('jwt_token', jwtToken);
        localStorage.setItem('jwt_token', jwtToken);
        sessionStorage.setItem(SESSION_AUTH_KEY, JSON.stringify({
            token: jwtToken,
            user: currentUser
        }));

        console.log('🔐 Autenticación exitosa. Token JWT recibido:', jwtToken);
        onLoginSuccess();
    } catch (err) {
        console.error('Error de autenticación:', err);
        showAuthError(err.message || 'Error al iniciar sesión.');
    } finally {
        authSubmitBtn.disabled = false;
        setAuthMode(authMode);
    }
});

async function onLoginSuccess() {
    authOverlay.classList.add('hidden');
    activeUserBar.classList.remove('hidden');
    currentUsernameLabel.textContent = currentUser.username;

    // Cargar historial previo de mensajes desde Firestore (o respaldo local)
    await loadChatHistory();

    // Abrir conexión WebSocket autenticada con el JWT
    connectWebSocket();
    messageInput.focus();
}

logoutBtn.addEventListener('click', async () => {
    if (isFirebaseReady && firebaseAuth) {
        try {
            await firebaseAuth.signOut();
        } catch (err) {
            console.warn('Error al cerrar sesión en Firebase:', err);
        }
    }

    if (ws) {
        ws.onclose = null;
        ws.close();
        ws = null;
    }

    jwtToken = null;
    currentUser = null;
    sessionStorage.removeItem(SESSION_AUTH_KEY);
    sessionStorage.removeItem('jwt_token');
    localStorage.removeItem('jwt_token');

    setConnectionState('disconnected');
    activeUserBar.classList.add('hidden');
    authOverlay.classList.remove('hidden');
});

// ============================================================================
// 4. Persistencia de Chats en Base de Datos (Firebase Cloud Firestore)
// ============================================================================
async function saveMessageToFirestore(messageData) {
    if (!isFirebaseReady || !firestoreDb) return null;

    try {
        const docRef = await firestoreDb.collection('messages').add({
            uid: currentUser.uid,
            username: currentUser.username,
            email: currentUser.email,
            text: messageData.text,
            timestamp: new Date().toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            }),
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            createdAtMs: Date.now()
        });
        console.log('💾 Mensaje guardado en Cloud Firestore con ID:', docRef.id);
        return docRef.id;
    } catch (err) {
        console.error('Error guardando mensaje en Firestore:', err);
        return null;
    }
}

async function loadChatHistory() {
    // 1. Si Firestore está activo, consultar la colección 'messages'
    if (isFirebaseReady && firestoreDb) {
        try {
            const snapshot = await firestoreDb
                .collection('messages')
                .orderBy('createdAtMs', 'asc')
                .limitToLast(50)
                .get();

            snapshot.forEach((doc) => {
                const data = doc.data();
                addChatMessage({
                    id: doc.id,
                    uid: data.uid,
                    username: data.username,
                    text: data.text,
                    timestamp: data.timestamp
                });
            });
            console.log(`📚 Historial cargado desde Cloud Firestore (${snapshot.size} mensajes)`);
            return;
        } catch (err) {
            console.warn('No se pudo leer Firestore, usando respaldo del servidor:', err);
        }
    }

    // 2. Respaldo del servidor protegido con JWT
    if (jwtToken) {
        try {
            const res = await fetch('/api/messages', {
                headers: { Authorization: `Bearer ${jwtToken}` }
            });
            if (res.ok) {
                const data = await res.json();
                (data.messages || []).forEach((msg) => addChatMessage(msg));
            }
        } catch (err) {
            console.warn('Error cargando historial de respaldo:', err);
        }
    }
}

// ============================================================================
// 5. Indicador de Estado (Conectado / Reconectando / Desconectado)
// ============================================================================
function setConnectionState(state) {
    statusBadge.classList.remove('status-connected', 'status-reconnecting', 'status-disconnected');

    if (state === 'connected') {
        connected = true;
        statusBadge.classList.add('status-connected');
        statusText.textContent = 'Conectado';
    } else if (state === 'reconnecting') {
        connected = false;
        statusBadge.classList.add('status-reconnecting');
        statusText.textContent = 'Reconectando...';
    } else {
        connected = false;
        statusBadge.classList.add('status-disconnected');
        statusText.textContent = 'Desconectado';
    }
}

// ============================================================================
// 6. Conexión WebSocket Autenticada con JWT y Manejo de Eventos JSON
// ============================================================================
function connectWebSocket() {
    if (!jwtToken || !currentUser) return;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    setConnectionState('reconnecting');

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}?token=${encodeURIComponent(jwtToken)}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        setConnectionState('connected');
        console.log('✅ Conexión WebSocket autenticada con JWT abierta');
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            console.log('📥 Recibido JSON:', msg);

            if (typeof msg.onlineCount === 'number') {
                onlineCountNum.textContent = msg.onlineCount;
            }

            switch (msg.type) {
                case 'welcome':
                    myClientId = msg.clientId;
                    break;

                case 'users_count':
                    break;

                case 'system':
                    addSystemMessage(msg.text, msg.timestamp, msg.event);
                    break;

                case 'typing':
                    handleRemoteTyping(msg.username, msg.isTyping);
                    break;

                case 'error':
                    showValidationError(msg.text);
                    break;

                case 'message':
                default:
                    if (msg.username) {
                        handleRemoteTyping(msg.username, false);
                    }
                    addChatMessage(msg);
                    break;
            }
        } catch (err) {
            console.error('Error al parsear mensaje JSON:', err);
        }
    };

    ws.onclose = () => {
        setConnectionState('disconnected');
        if (!jwtToken) return;

        console.warn('⚠️ Conexión cerrada. Reintentando en 2.5s...');
        reconnectTimer = setTimeout(() => {
            setConnectionState('reconnecting');
            connectWebSocket();
        }, 2500);
    };

    ws.onerror = (error) => {
        console.error('Error WebSocket:', error);
    };
}

// ============================================================================
// 7. Renderizado de Mensajes (Izquierda recibidos / Derecha enviados)
// ============================================================================
function addChatMessage(msg) {
    if (msg.id && renderedMessageIds.has(msg.id)) {
        return;
    }
    if (msg.id) {
        renderedMessageIds.add(msg.id);
    }

    const isOwnMessage =
        (myClientId && msg.clientId && msg.clientId === myClientId) ||
        (currentUser && msg.uid && msg.uid === currentUser.uid) ||
        (currentUser && msg.username === currentUser.username);

    const rowDiv = document.createElement('div');
    rowDiv.className = `message-row ${isOwnMessage ? 'sent' : 'received'}`;

    const bubbleDiv = document.createElement('div');
    bubbleDiv.className = 'message-bubble';

    if (!isOwnMessage) {
        const senderSpan = document.createElement('span');
        senderSpan.className = 'message-sender';
        senderSpan.textContent = msg.username;
        bubbleDiv.appendChild(senderSpan);
    }

    const textDiv = document.createElement('div');
    textDiv.className = 'message-text';
    textDiv.textContent = msg.text;
    bubbleDiv.appendChild(textDiv);

    const metaDiv = document.createElement('div');
    metaDiv.className = 'message-meta';

    const timeSpan = document.createElement('span');
    timeSpan.textContent = msg.timestamp || new Date().toLocaleTimeString();
    metaDiv.appendChild(timeSpan);

    if (isOwnMessage) {
        const checkSpan = document.createElement('span');
        checkSpan.className = 'check-icon';
        checkSpan.textContent = '✓✓';
        metaDiv.appendChild(checkSpan);
    }

    bubbleDiv.appendChild(metaDiv);
    rowDiv.appendChild(bubbleDiv);

    messagesArea.appendChild(rowDiv);
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

function addSystemMessage(text, timestamp, eventType) {
    const sysDiv = document.createElement('div');
    sysDiv.className = 'system-message';

    let icon = 'ℹ️';
    if (eventType === 'join') icon = '🟢';
    if (eventType === 'leave') icon = '🔴';

    sysDiv.textContent = `${icon} ${text} • ${timestamp}`;
    messagesArea.appendChild(sysDiv);
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

// ============================================================================
// 8. Indicador "escribiendo..."
// ============================================================================
function handleRemoteTyping(username, isTyping) {
    if (!username) return;

    if (typingUsers.has(username)) {
        clearTimeout(typingUsers.get(username));
        typingUsers.delete(username);
    }

    if (isTyping) {
        const timeoutId = setTimeout(() => {
            typingUsers.delete(username);
            renderTypingIndicator();
        }, 3000);
        typingUsers.set(username, timeoutId);
    }

    renderTypingIndicator();
}

function renderTypingIndicator() {
    const names = Array.from(typingUsers.keys());
    if (names.length === 0) {
        typingContainer.classList.add('hidden');
        return;
    }

    if (names.length === 1) {
        typingText.textContent = `${names[0]} está escribiendo...`;
    } else {
        typingText.textContent = `${names.join(', ')} están escribiendo...`;
    }
    typingContainer.classList.remove('hidden');
}

function notifyTyping(typingState) {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN || !currentUser) return;

    if (isCurrentlyTyping !== typingState) {
        isCurrentlyTyping = typingState;
        ws.send(JSON.stringify({
            type: 'typing',
            username: currentUser.username,
            isTyping: typingState
        }));
    }
}

// ============================================================================
// 9. Validación y Envío de Mensajes
// ============================================================================
function showValidationError(message) {
    validationAlertText.textContent = `⚠️ ${message}`;
    validationAlert.classList.remove('hidden');

    if (alertTimeout) clearTimeout(alertTimeout);
    alertTimeout = setTimeout(() => {
        validationAlert.classList.add('hidden');
    }, 4000);
}

function hideValidationError() {
    validationAlert.classList.add('hidden');
    if (alertTimeout) {
        clearTimeout(alertTimeout);
        alertTimeout = null;
    }
}

function updateCharCounter() {
    const length = messageInput.value.length;
    charCounter.textContent = `${length} / ${MAX_MESSAGE_LENGTH}`;
    if (length > MAX_MESSAGE_LENGTH) {
        charCounter.classList.add('limit-exceeded');
    } else {
        charCounter.classList.remove('limit-exceeded');
    }
}

async function sendMessage() {
    if (!currentUser || !jwtToken) {
        showValidationError('Debes iniciar sesión antes de enviar un mensaje.');
        return;
    }

    const rawText = messageInput.value;
    const trimmedText = rawText.trim();

    if (trimmedText.length === 0) {
        showValidationError('No se pueden enviar mensajes vacíos.');
        messageInput.focus();
        return;
    }

    if (trimmedText.length > MAX_MESSAGE_LENGTH) {
        showValidationError(`El mensaje es demasiado largo (${trimmedText.length}/${MAX_MESSAGE_LENGTH} caracteres máx.).`);
        messageInput.focus();
        return;
    }

    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
        showValidationError('No hay conexión activa con el servidor WebSocket.');
        return;
    }

    hideValidationError();
    notifyTyping(false);
    if (typingTimeout) clearTimeout(typingTimeout);

    messageInput.value = '';
    updateCharCounter();
    messageInput.focus();

    // Guardar en Cloud Firestore si está configurado
    const firestoreId = await saveMessageToFirestore({ text: trimmedText });

    const payload = {
        type: 'message',
        firestoreId,
        username: currentUser.username,
        text: trimmedText
    };

    console.log('📤 Enviando JSON (message):', payload);
    ws.send(JSON.stringify(payload));
}

// ============================================================================
// 10. Event Listeners e Inicialización
// ============================================================================
sendBtn.addEventListener('click', sendMessage);

messageInput.addEventListener('input', () => {
    updateCharCounter();

    if (messageInput.value.trim().length > 0) {
        notifyTyping(true);
        if (typingTimeout) clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            notifyTyping(false);
        }, 1800);
    } else {
        notifyTyping(false);
    }
});

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
    }
});

initTheme();
updateCharCounter();
initializeAppConfig();
