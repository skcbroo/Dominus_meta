const express = require("express");
const axios = require("axios");

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const META_TOKEN = process.env.META_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const META_BASE = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
const META_HEADERS = {
  Authorization: `Bearer ${META_TOKEN}`,
  "Content-Type": "application/json",
};

// ====== EXPRESS ======
const app = express();
app.use(express.json());

// ====== META WRAPPER ======
async function sendText(toE164, text) {
  return axios.post(
    META_BASE,
    {
      messaging_product: "whatsapp",
      to: toE164,
      type: "text",
      text: { body: text },
    },
    { headers: META_HEADERS }
  );
}

// ====== HEALTHCHECK ======
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, provider: "meta" });
});

// ====== VERIFICAÇÃO DE WEBHOOK ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ====== RECEBIMENTO DE MENSAGENS ======
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Mensagens recebidas
    if (Array.isArray(value?.messages)) {
      for (const msg of value.messages) {
        const from = msg.from; // número do cliente
        const body = msg.text?.body || "";

        console.log("📩 Mensagem recebida:", { from, body });

        try {
          await sendText(from, "Olá, tudo certo?");
          console.log("🤖 Resposta enviada para", from);
        } catch (e) {
          console.warn("Falha ao responder:", e.response?.data || e.message);
        }
      }
    }
  } catch (e) {
    console.warn("⚠️ Webhook error:", e.message);
  } finally {
    res.sendStatus(200);
  }
});

// ====== BOOT ======
app.listen(PORT, () => {
  console.log(`🌐 HTTP on :${PORT}`);
  if (!META_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ META_TOKEN e PHONE_NUMBER_ID são obrigatórios no .env.");
  }
});

