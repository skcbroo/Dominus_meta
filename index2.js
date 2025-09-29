// index.js (substitui o arquivo que você me mandou)
const fs = require("fs");
const express = require("express");
const qrcode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const MONITOR_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 horas
const ADMIN_LOG_NUMBER = process.env.ADMIN_LOG_NUMBER; // vem do .env/railway
const SESSION_PATH = process.env.SESSION_PATH || "/data/whatsapp"; // <-- subpasta fixa no volume
const CLIENT_ID = process.env.WWEBJS_CLIENT_ID || "zapbot";        // <-- id fixo
// =====================

const app = express();

// ---- helpers de normalização ----
function normalizaTexto(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function ehAfirmação(body) {
  const t = normalizaTexto(body);
  return /^(SIM|S|OK|CLARO|POSSO|QUERO|VAMOS|SIM POR FAVOR|SIM, POR FAVOR|POSITIVO|TÁ|TA|BORA|ENVIA|PODE ENVIAR)$/.test(t);
}

/** Normaliza número BR para formato com DDI 55 (ex: 5561999112233) */
function normalizarBrasil(numeroRaw) {
  let n = (numeroRaw || "").replace(/\D/g, "");
  if (!n.startsWith("55")) n = "55" + n;
  n = n.replace(/^55+0*/, "55");
  return n;
}

function primeiroNomeFormatado(nome) {
  if (!nome) return "Contato";
  const partes = nome.trim().split(/\s+/);
  const primeiro = partes[0].toLowerCase();
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1);
}

// ====== ESTADO DE RASTREIO ======
const pending = new Map();
let adminLogChatId = null;

// ====== ESTADO DO CLIENT/QR ======
let lastQr = null;
let isReady = false;

async function resolverChatId(client, numeroE164) {
  const id = await client.getNumberId(numeroE164);
  return id ? id._serialized : null;
}

async function enviarLog(client, { nome, resposta, numero, processo }) {
  try {
    if (!ADMIN_LOG_NUMBER) return;
    if (!adminLogChatId) {
      const norm = normalizarBrasil(ADMIN_LOG_NUMBER);
      adminLogChatId = await resolverChatId(client, norm);
      if (!adminLogChatId) {
        console.warn("⚠️ Não consegui resolver o chatId do número de logs:", ADMIN_LOG_NUMBER);
        return;
      }
    }

    const textoLog =
`📬 *Resposta recebida*
• Cliente: ${nome}
• Número: ${numero}
• Processo: ${processo || "(não informado)"}
• Resposta: ${resposta}`;

    await client.sendMessage(adminLogChatId, textoLog);
  } catch (e) {
    console.warn("⚠️ Falha ao enviar log:", e?.message || e);
  }
}

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: CLIENT_ID,                  // manter fixo entre deploys
    dataPath: SESSION_PATH                // apontar pro volume montado na Railway
  }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu"
    ]
  }
});

// ---- Eventos WhatsApp ----
client.on("qr", (qr) => {
  lastQr = qr;
  isReady = false;
  console.log("✅ QR atualizado. Acesse /qr para escanear.");
});

client.on("authenticated", () => {
  console.log("🔐 Autenticado.");
});

client.on("auth_failure", (msg) => {
  console.error("❌ Falha de autenticação:", msg);
  // Se ficar preso, podemos expor um /reset depois, mas normalmente não precisa.
});

client.on("ready", async () => {
  isReady = true;
  lastQr = null;
  console.log("✅ Cliente conectado com sucesso!");

  try {
    const dados = JSON.parse(fs.readFileSync("./teste.json", "utf-8"));
    await enviarMensagemParaNumeros(dados, client);
    console.log("📤 Mensagens enviadas com sucesso!");
  } catch (error) {
    console.error("❌ Erro ao enviar as mensagens:", error);
  }
});

client.on("disconnected", (reason) => {
  isReady = false;
  console.warn("⚠️ Disconnected:", reason);
});

client.on("message", async (msg) => {
  try {
    if (msg.fromMe) return;
    const chatId = msg.from;
    const track = pending.get(chatId);
    if (!track) return;

    const agora = Date.now();
    if (agora > track.expireAtMs) {
      pending.delete(chatId);
      return;
    }

    // log local
    console.log("-------------------------------");
    console.log("📌 [RESPOSTA RECEBIDA]");
    console.log("Cliente:", track.nome);
    console.log("Número:", track.numeroDestino);
    console.log("Processo:", track.processo || "(não informado)");
    console.log("Resposta:", msg.body);
    console.log("-------------------------------");

    const msgTimeMs = (msg.timestamp || 0) * 1000;
    if (msgTimeMs && msgTimeMs < track.sentAtMs) return;

    const body = msg.body || "";

    if (ehAfirmação(body)) {
      try {
        await msg.reply(
`Excelente! ✅
Vou encaminhar seus dados para análise, em breve um analista entrará em contato!`
        );
      } catch {}
    }

    await enviarLog(client, {
      nome: track.nome,
      resposta: body,
      numero: track.numeroDestino,
      processo: track.processo
    });

    pending.delete(chatId);
  } catch (e) {
    console.warn("⚠️ Falha ao processar resposta:", e?.message || e);
  }
});

// limpeza periódica da janela de monitoramento
setInterval(() => {
  const t = Date.now();
  for (const [chatId, info] of pending) {
    if (t >= info.expireAtMs) pending.delete(chatId);
  }
}, 30 * 1000);

// ---- Rotas HTTP (QR/health) ----
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, ready: isReady, hasQr: !!lastQr });
});

app.get("/qr", async (_req, res) => {
  try {
    if (!lastQr && isReady) return res.send("✅ Já está pareado.");
    if (!lastQr) return res.send("Aguardando QR... recarregue.");
    const png = await qrcode.toBuffer(lastQr, { type: "png", margin: 1, scale: 6 });
    res.setHeader("Content-Type", "image/png");
    res.send(png);
  } catch (e) {
    console.error("Erro gerando QR:", e);
    res.status(500).send("Erro gerando QR");
  }
});

// start http + client
app.listen(PORT, () => {
  console.log(`🌐 HTTP on :${PORT}`);
});
client.initialize();

// ====== ENVIO EM MASSA ======
async function enviarMensagemParaNumeros(resultados, client) {
  for (let i = 0; i < resultados.length; i++) {
    const item = resultados[i];
    const nome = primeiroNomeFormatado(item.reclamante) || `Contato ${i + 1}`;
    const celular = item.telefone;
    if (!celular) continue;

    const mensagem =
`Olá, ${nome}! 👋 

Sou o Hugo, da Dominus Ativos Judiciais, por consultas públicas, encontramos seu contato e vimos que você tem um processo trabalhista em andamento.

💸 O que fazemos: compramos parte do seu processo e pagamos à vista — dinheiro agora, sem precisar esperar o final.

✅ Não pedimos qualquer valor, nossa intenção é comprar, não vender.
✅ Não pedimos senha nem código
✅ Contrato simples, assinado pelo celular
✅ Pagamento por PIX/TED com comprovante
✅ Se preferir, falamos com seu advogado

⏰ Fechamos o lote de análise desta semana.
Posso enviar seu caso agora e te mandar uma proposta ainda esta semana.

👉 Responda “SIM” para receber uma proposta.

Se não quiser, basta responder “NÃO” e encerramos o contato. 🤝`;

    const numeros = String(celular)
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    let enviado = false;

    for (const numeroRaw of numeros) {
      const base = normalizarBrasil(numeroRaw);
      const numeroCom9 = base;
      const numeroSem9 = base.replace(/^(55\d{2})9(\d{8})$/, "$1$2");

      let numeroValido = null;

      try {
        const idCom9 = await client.getNumberId(numeroCom9);
        if (idCom9) {
          numeroValido = idCom9._serialized;
          console.log(`✅ ${nome} — número válido (com 9): ${numeroCom9}`);
        } else {
          const idSem9 = await client.getNumberId(numeroSem9);
          if (idSem9) {
            numeroValido = idSem9._serialized;
            console.log(`✅ ${nome} — número válido (sem 9): ${numeroSem9}`);
          } else {
            console.log(`❌ ${nome} — nenhum número válido encontrado: ${numeroRaw}`);
          }
        }
      } catch (e) {
        console.log(`⚠️ Erro ao validar número (${numeroRaw}):`, e?.message || e);
      }

      if (numeroValido) {
        try {
          const sendResult = await client.sendMessage(numeroValido, mensagem);
          pending.set(sendResult.to, {
            sentAtMs: Date.now(),
            messageId: sendResult.id?._serialized || "",
            nome,
            processo: item.numero_processo,
            numeroDestino: base,
            expireAtMs: Date.now() + MONITOR_WINDOW_MS
          });

          console.log(`📤 Mensagem enviada para ${nome} em ${numeroValido}`);
          enviado = true;
          break;
        } catch (err) {
          console.log(`❌ Falha ao enviar para ${numeroValido}:`, err?.message || err);
        }
      }
    }

    if (!enviado) {
      console.log(`🚫 ${nome} — não foi possível enviar (nenhum número válido/entregue).`);
    }

    const numbale = Math.floor(Math.random() * (20000 - 10000 + 1)) + 10000;
    const delay = numbale + 10000;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
