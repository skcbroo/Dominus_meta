// index.js
const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const META_TOKEN = process.env.META_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const TEMPLATE_NAME = "contato"; // nome do template aprovado
const LANG = "en"; // idioma do template
const ARQUIVO = process.env.ARQUIVO_JSON || "./teste.json"; // lista de contatos
const ADMIN_NUMBER = process.env.ADMIN_NUMBER; // ex: 5561999887766

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
  let n = (numeroRaw || "").replace(/\D/g, "");
  if (!n.startsWith("55")) n = "55" + n;
  return n;
}

function primeiroNomeFormatado(nome) {
  if (!nome) return "Contato";
  const partes = nome.trim().split(/\s+/);
  const primeiro = partes[0].toLowerCase();
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1);
}

function normalizaTexto(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function ehAfirmação(body) {
  const t = normalizaTexto(body);
  return (
    /^(S+I*M+|S)$/.test(t) ||
    /^OK+$/.test(t) ||
    t.includes("CLARO") ||
    t.includes("VAMOS") ||
    t.includes("QUERO") ||
    t.includes("POSITIVO") ||
    t.includes("ENVIA") ||
    t.includes("PODE ENVIAR")
  );
}

function ehNegacao(body) {
  const t = normalizaTexto(body);
  return (
    t === "N" ||
    t === "NAO" ||
    t === "NÃO" ||
    t.includes("NAO QUERO") ||
    t.includes("NÃO QUERO") ||
    t.includes("OBRIGADO") ||
    t.includes("DESCARTAR") ||
    t.includes("NAO TENHO INTERESSE") ||
    t.includes("NÃO TENHO INTERESSE")
  );
}

// ====== ENVIO ======
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

// ====== LOG ADM ======
async function enviarLogADM({ clienteJson, nomeZap, numero, resposta }) {
  if (!ADMIN_NUMBER) {
    console.warn("⚠️ ADMIN_NUMBER não definido no .env");
    return;
  }
  try {
    const textoLog = `📬 *Resposta recebida*
• Nome (JSON): ${clienteJson?.reclamante || "(não informado)"}
• Telefone (JSON): ${clienteJson?.telefone || "(não informado)"}
• Processo: ${clienteJson?.numero_processo || "(não informado)"}
• Nome no WhatsApp: ${nomeZap || "(desconhecido)"}
• Número (WhatsApp): ${numero}
• Resposta: ${resposta || "(vazio)"}`;

    await sendText(ADMIN_NUMBER, textoLog);
    console.log(`📤 Log enviado ao ADM (${ADMIN_NUMBER})`);
  } catch (e) {
    console.error("❌ Falha ao enviar log para ADM:", e.response?.data || e.message);
  }
}

// ====== MAPA DE CLIENTES ======
const clientePorNumero = new Map();

// ====== ENVIO EM MASSA ======
async function enviarMensagemParaNumeros() {
  try {
    const dados = JSON.parse(fs.readFileSync(path.resolve(ARQUIVO), "utf-8"));
    for (let i = 0; i < dados.length; i++) {
      const item = dados[i];
      const nome = primeiroNomeFormatado(item.reclamante) || `Contato ${i + 1}`;

      // pega todos os números do campo telefone
      const numeros = String(item.telefone || "")
        .split(/[,;]+/)
        .map((s) => normalizarBrasil(s.trim()))
        .filter(Boolean);

      // vincula todos os números ao objeto inteiro
      for (const num of numeros) {
        clientePorNumero.set(num, item);

        // também vincula versão sem "9"
        const sem9 = num.replace(/^55(\d{2})9(\d{8})$/, "55$1$2");
        if (sem9 !== num) {
          clientePorNumero.set(sem9, item);
        }
      }

      // envia só para o primeiro válido
      if (numeros[0]) {
        try {
          const resp = await sendTemplate(numeros[0], [nome]);
          console.log(
            `📤 Template enviado para ${nome} (${numeros[0]}) →`,
            resp.data.messages[0].id
          );
        } catch (err) {
          console.error(
            `❌ Falha ao enviar para ${nome} (${numeros[0]})`,
            err.response?.data || err.message
          );
        }
      }

      const delay = 60000 + Math.floor(Math.random() * 60001);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  } catch (e) {
    console.error("❌ Erro lendo arquivo:", e.message);
  }
}

// ====== WEBHOOK RECEBIMENTO ======
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (Array.isArray(value?.messages)) {
      for (const msg of value.messages) {
        const from = msg.from;
        let body = "";

        if (msg.text?.body) body = msg.text.body;
        if (msg.button?.text) body = msg.button.text;
        if (msg.interactive?.button_reply?.title)
          body = msg.interactive.button_reply.title;
        if (msg.interactive?.list_reply?.title)
          body = msg.interactive.list_reply.title;

        console.log("📩 Mensagem recebida:", { from, body });

        const nomeZap = value.contacts?.[0]?.profile?.name || null;
        const clienteJson = clientePorNumero.get(from) || null;

        if (ehAfirmação(body)) {
          await sendText(
            from,
            "Excelente! ✅ Vou encaminhar seus dados para análise. Em breve um analista entrará em contato."
          );
          await enviarLogADM({
            clienteJson,
            nomeZap,
            numero: from,
            resposta: body || "SIM",
          });
        } else if (ehNegacao(body)) {
          await sendText(
            from,
            "Entendo, obrigado pela atenção 🙏. Continuamos à disposição caso mude de ideia."
          );
          await enviarLogADM({
            clienteJson,
            nomeZap,
            numero: from,
            resposta: body || "NÃO",
          });
        } else {
          await sendText(
            from,
            "Olá! 😊 Responda apenas *SIM* para receber a proposta ou *NÃO* para encerrar o contato."
          );
        }
      }
    }
  } catch (e) {
    console.warn("⚠️ Webhook error:", e.message);
  } finally {
    res.sendStatus(200);
  }
});

// ====== VERIFICAÇÃO DE WEBHOOK ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

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
