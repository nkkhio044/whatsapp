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

// Folders
const uploadsDir = path.join("/tmp/uploads");
const sessionsDir = path.join("/tmp/sessions");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

const upload = multer({ dest: uploadsDir });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Active clients
const activeClients = new Map();

// Helpers
function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

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

// Full HTML embedded
const htmlTemplate = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WhatsApp Multi-User Sender</title>
<style>
body{font-family:sans-serif;background:#f0f2f5;padding:20px;color:#333}h1,h2{color:#075E54}button{background:#25D366;color:#fff;padding:10px;border:none;border-radius:6px;cursor:pointer}button:hover{background:#128C7E}input,select{padding:8px;width:100%;margin-bottom:10px;border:1px solid #ccc;border-radius:6px}.session-item{padding:10px;margin-bottom:10px;background:#fff;border-radius:6px;display:flex;justify-content:space-between;align-items:center;box-shadow:0 2px 5px rgba(0,0,0,0.05)}
</style>
</head>
<body>
<h1>WhatsApp Multi-User Sender</h1>

<h2>Connect WhatsApp</h2>
<form id="pairing-form">
<input type="text" name="number" placeholder="Enter WhatsApp number with country code" required>
<button type="submit">Generate Pairing Code</button>
</form>
<div id="pairing-result"></div>

<h2>Send Messages</h2>
<form id="message-form" enctype="multipart/form-data">
<input type="text" name="sessionId" placeholder="Enter Session ID" required>
<select name="targetType" required>
<option value="">--Select--</option>
<option value="number">Number</option>
<option value="group">Group UID</option>
</select>
<input type="text" name="target" placeholder="Target Number/Group UID" required>
<input type="file" name="messageFile" accept=".txt" required>
<input type="number" name="delaySec" placeholder="Delay (seconds)" value="5" required>
<button type="submit">Start Sending</button>
</form>
<div id="message-result"></div>

<h2>Your Active Sessions</h2>
<div id="session-list"></div>

<script>
const userNumber = localStorage.getItem('userNumber') || '';
async function loadSessions(){
  const num = userNumber || document.querySelector('input[name=number]').value;
  localStorage.setItem('userNumber',num);
  const res = await fetch('/active-sessions?number='+num);
  const sessions = await res.json();
  const container = document.getElementById('session-list');
  container.innerHTML='';
  sessions.forEach(s=>{
    const div=document.createElement('div');
    div.className='session-item';
    div.innerHTML=\`
      <div>\${s.sessionId} (\${s.connected?'Connected':'Disconnected'}) [\${s.sending?'Sending':'Idle'}]</div>
      <button data-session="\${s.sessionId}">Stop</button>
    \`;
    container.appendChild(div);
  });
  document.querySelectorAll('#session-list button').forEach(btn=>{
    btn.onclick=async()=>{const sid=btn.dataset.session;const r=await fetch('/stop?sessionId='+sid+'&number='+num);alert(await r.text());loadSessions();}
  });
}
setInterval(loadSessions,5000);
loadSessions();

document.getElementById('pairing-form').onsubmit=async e=>{
  e.preventDefault();
  const formData=new FormData(e.target);
  const res=await fetch('/code?'+new URLSearchParams(formData));
  const text=await res.text();
  document.getElementById('pairing-result').innerHTML=text;
  loadSessions();
};

document.getElementById('message-form').onsubmit=async e=>{
  e.preventDefault();
  const formData=new FormData(e.target);
  const res=await fetch('/send-message',{method:'POST',body:formData});
  const text=await res.text();
  document.getElementById('message-result').innerHTML=text;
  loadSessions();
};
</script>
</body>
</html>
`;

// Routes
app.get("/", (req,res)=>res.send(htmlTemplate));

// Generate pairing code and session
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

// Send messages
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

// Get active sessions
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

// Start server
app.listen(PORT, () => console.log('Server running at http://localhost:'+PORT));
