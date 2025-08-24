const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const multer = require("multer");
const {
  default: Gifted_Tech,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers
} = require("maher-zubair-baileys");

const app = express();
const PORT = process.env.PORT || 5000;

// Folders (use /tmp for ephemeral testing on Render)
const uploadsDir = path.join("/tmp/uploads");
const sessionsDir = path.join("/tmp/sessions");

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

const upload = multer({ dest: uploadsDir });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// Active clients map
const activeClients = new Map();

// Helper to generate session ID
function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) +
         Math.random().toString(36).substring(2, 15);
}

// Send messages loop
async function sendMessagesLoop(client, recipient, messages, delayMs, sessionId) {
  let index = 0;
  activeClients.get(sessionId).sending = true;

  while (activeClients.get(sessionId)?.sending) {
    const msg = messages[index];
    try {
      await client.sendMessage(recipient, { text: msg });
      console.log(`Sent: ${msg}`);
    } catch (err) {
      console.error("Send fail:", err.message);
      await delay(delayMs * 2);
      continue;
    }
    index = (index + 1) % messages.length;
    await delay(delayMs);
  }
}

// Pairing endpoint
app.get("/code", async (req, res) => {
  const number = req.query.number.replace(/[^0-9]/g, "");
  if (!/^\d{10,15}$/.test(number)) return res.send("Invalid number format");

  const sessionId = generateSessionId();
  const sessionPath = path.join(sessionsDir, sessionId);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const waClient = Gifted_Tech({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
      },
      printQRInTerminal: false,
      logger: pino({ level: "fatal" }).child({ level: "fatal" }),
      browser: Browsers.macOS("Desktop")
    });

    if (!waClient.authState.creds.registered) {
      await delay(1500);
      const code = await waClient.requestPairingCode(number);
      activeClients.set(sessionId, { client: waClient, number, connected: true, sending: false });

      waClient.ev.on("creds.update", saveCreds);
      waClient.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "open") activeClients.set(sessionId, { ...activeClients.get(sessionId), connected: true });
        else if (connection === "close") {
          activeClients.set(sessionId, { ...activeClients.get(sessionId), connected: false });
          if (lastDisconnect?.error?.output?.statusCode !== 401) await delay(10000), waClient.connect();
        }
      });

      return res.send(`Pairing Code: ${code}<br>Session ID: ${sessionId}`);
    } else {
      activeClients.set(sessionId, { client: waClient, number, connected: true, sending: false });
      return res.send(`Already registered. Session ID: ${sessionId}`);
    }
  } catch (err) {
    return res.send("Error: " + err.message);
  }
});

// Send message endpoint
app.post("/send-message", upload.single("messageFile"), async (req, res) => {
  const { sessionId, target, targetType, delaySec } = req.body;
  const filePath = req.file?.path;

  if (!sessionId || !target || !filePath || !delaySec || !targetType) return res.send("Missing fields");
  if (!activeClients.has(sessionId)) return res.send("Invalid session");

  const { client, connected } = activeClients.get(sessionId);
  if (!connected) return res.send("WhatsApp not connected");

  try {
    const messages = fs.readFileSync(filePath, "utf-8").split("\n").filter(m => m.trim());
    fs.unlinkSync(filePath);
    const recipient = targetType === "group" ? target + "@g.us" : target + "@s.whatsapp.net";

    sendMessagesLoop(client, recipient, messages, delaySec * 1000, sessionId).catch(console.error);
    return res.send(`Message loop started for session ${sessionId}`);
  } catch (err) {
    return res.send("Error: " + err.message);
  }
});

// Active sessions for a user
app.get("/active-sessions", (req, res) => {
  const userNumber = req.query.number;
  const sessions = Array.from(activeClients.entries())
    .filter(([id, data]) => data.number === userNumber)
    .map(([id, data]) => ({ sessionId: id, connected: data.connected, sending: data.sending }));

  res.json(sessions);
});

// Stop a session
app.get("/stop", (req, res) => {
  const { sessionId, number } = req.query;
  if (!activeClients.has(sessionId)) return res.send("Invalid session");
  const session = activeClients.get(sessionId);
  if (session.number !== number) return res.send("Ye session tera nahi hai 😅");
  session.sending = false;
  res.send(`Stopped session ${sessionId}`);
});

// Disconnect session
app.get("/disconnect", (req, res) => {
  const { sessionId } = req.query;
  if (!activeClients.has(sessionId)) return res.send("Invalid session");
  const { client } = activeClients.get(sessionId);
  client.ws.close();
  activeClients.delete(sessionId);
  res.send(`Disconnected session ${sessionId}`);
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
