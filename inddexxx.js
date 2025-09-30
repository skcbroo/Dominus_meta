// index.js
const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const META_TOKEN = process.env.META_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const TEMPLATE_NAME = process.env.TEMPLATE_NAME || "contato"; // nome do template aprovado
const LANG = process.env.LANG || "pt_BR"; // idioma do template
const BotName = process.env.BotName || "Dominus";
const ARQUIVO = process.env.ARQUIVO_JSON || "./teste.json"; // lista de contatos

const META_BASE = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
const META_HEADERS = {
  Authorization: `Bearer ${META_TOKEN}`,
  "Content-Type": "application/json",
};

// ====== EXPRESS ======
const app = express();
app.use(express.json());

// ====== HELPERS ======
function normalizarBrasil(numeroRaw) {
  let n = (numeroRaw || "").replace(/\D/g, ""); // só dígitos
  if (!n.startsWith("55")) n = "55" + n; // garante DDI
  return n;
}

function primeiroNomeFormatado(nome) {
  if (!nome) return "Contato";
  const partes = nome.trim().split(/\s+/);
  const primeiro = partes[0].toLowerCase();
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1);
}

// ====== ENVIO DE TEMPLATE ======
async function sendTemplate(toE164, variables = []) {
  return axios.post(
    META_BASE,
    {
      messaging_product: "whatsapp",
      to: toE164,
      type: "template",
      template: {
        name: TEMPLATE_NAME,
        language: { code: LANG },
        components: [
          {
            type: "body",
            parameters: variables.map((v) => ({ type: "text", text: v })),
          },
        ],
      },
    },
    { headers: META_HEADERS }
  );
}

// ====== ENVIO EM MASSA ======
async function enviarMensagemParaNumeros() {
  try {
    const dados = JSON.parse(fs.readFileSync(path.resolve(ARQUIVO), "utf-8"));
    for (let i = 0; i < dados.length; i++) {
      const item = dados[i];
      const nome = primeiroNomeFormatado(item.reclamante) || `Contato ${i + 1}`;
      const celular = item.telefone;
      if (!celular) continue;

      const numero = normalizarBrasil(celular);

      try {
        const resp = await sendTemplate(numero, [nome, BotName]);
        console.log(`📤 Template enviado para ${nome} (${numero}) →`, resp.data.messages[0].id);
      } catch (err) {
        console.error(`❌ Falha ao enviar para ${nome} (${numero})`, err.response?.data || err.message);
      }

      // delay entre disparos (60–120s aleatório)
      const delay = 60000 + Math.floor(Math.random() * 60001);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  } catch (e) {
    console.error("❌ Erro lendo arquivo:", e.message);
  }
}

// ====== ROTAS HTTP ======
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, provider: "meta" });
});

app.get("/send-all", async (_req, res) => {
  enviarMensagemParaNumeros();
  res.json({ ok: true, started: true });
});

// ====== BOOT ======
app.listen(PORT, () => {
  console.log(`🌐 HTTP on :${PORT}`);
  if (!META_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ META_TOKEN e PHONE_NUMBER_ID são obrigatórios no .env.");
  }
});
