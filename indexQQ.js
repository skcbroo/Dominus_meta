const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

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

// ====== META WRAPPERS ======
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

// ====== UTILS ======
function renderText(tpl, ctx) {
  return String(tpl || "").replace(/\{\{(\w+)\}\}/g, (_, k) => String(ctx[k] ?? ""));
}
function primeiroNome(nome) {
  if (!nome) return "Contato";
  const p = String(nome).trim().split(/\s+/)[0] || "Contato";
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

// ====== CARREGAR DIALOGUES ======
const DIALOGUES_FILE = process.env.DIALOGUES_FILE || "./dialogues.json";
let DIALOGUES = { rounds: {} };

function loadDialogues() {
  try {
    DIALOGUES = JSON.parse(fs.readFileSync(path.resolve(DIALOGUES_FILE), "utf-8"));
    console.log(`✅ Dialogues carregado: rounds=${Object.keys(DIALOGUES.rounds || {}).length}`);
  } catch (e) {
    console.warn("⚠️ Falha ao carregar dialogues.json:", e.message);
    DIALOGUES = { rounds: {} };
  }
}
loadDialogues();

// ====== ESTADO POR CONTATO ======
const conversaState = new Map(); // from -> { lastRoundA }

// ====== HEALTH ======
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, provider: "meta" });
});

// ====== VERIFICAÇÃO WEBHOOK ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ====== WEBHOOK (MENSAGENS RECEBIDAS) ======
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (Array.isArray(value?.messages)) {
      for (const msg of value.messages) {
        const from = msg.from;
        const body = msg.text?.body || "";
        console.log("📩 Mensagem recebida:", { from, body });

        // estado da conversa
        let st = conversaState.get(from) || { lastRoundA: 0, nomeA: "Cliente" };

        // define próximo round
        let proximoB = null;
        if (st.lastRoundA === 0) { st.lastRoundA = 1; proximoB = 2; }
        else if (st.lastRoundA === 1) { st.lastRoundA = 3; proximoB = 4; }
        else if (st.lastRoundA === 3) { st.lastRoundA = 5; proximoB = 6; }
        else {
          console.log(`[B] conversa concluída com ${from}`);
          conversaState.delete(from);
          continue;
        }
        conversaState.set(from, st);

        // pega template do dialogues.json
        const opts = DIALOGUES?.rounds?.[String(proximoB)]?.B || [];
        if (!opts.length) {
          console.log(`⚠️ Nenhum template para round ${proximoB}`);
          continue;
        }

        const nomeA = primeiroNome(body); // heurística simples
        const tpl = opts[Math.floor(Math.random() * opts.length)];
        const resposta = renderText(tpl, { nome: nomeA, nomeA, nomeB: "Dominus" });

        try {
          await sendText(from, resposta);
          console.log(`🤖 Round ${proximoB} enviado para ${from}:`, resposta);
        } catch (e) {
          console.warn("Falha ao responder:", e.response?.data || e.message);
        }

        if (proximoB === 6) {
          conversaState.delete(from);
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
