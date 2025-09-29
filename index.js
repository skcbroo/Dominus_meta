// botB.js — Responde rounds 2,4,6 (lado B) ao receber mensagens do A
require("dotenv").config();
const express = require("express");
const qrcode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");
const fs = require("fs");
const path = require("path");

// ====== CONFIG ======
const PORT = Number(process.env.PORT_B || process.env.PORT || 3002); // porta do bot B
//const SESSION_PATH = process.env.SESSION_PATH_B || process.env.SESSION_PATH || "/data/whatsapp";
//const CLIENT_ID = process.env.WWEBJS_CLIENT_ID_B || process.env.WWEBJS_CLIENT_ID || "zapbot";

const CONTACTS_FILE  = process.env.CONTACTS_FILE  || "./contacts.json";  // usado p/ whitelist do A
const DIALOGUES_FILE = process.env.DIALOGUES_FILE || "./dialogues.json";

const DIALOG_MIN_DELAY_MS = Number(process.env.DIALOG_MIN_DELAY_MS || 30_000);
const DIALOG_MAX_DELAY_MS = Number(process.env.DIALOG_MAX_DELAY_MS || 180_000);
const BLOCK_UNKNOWN = String(process.env.BLOCK_UNKNOWN || "true").toLowerCase() !== "false";

// Números de A liberados via .env (E164, separados por vírgula)
const ALLOWED_A_NUMBERS = (process.env.ALLOWED_A_NUMBERS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// ====== Utils ======
function randInt(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
function randomDelay(){ return randInt(DIALOG_MIN_DELAY_MS, DIALOG_MAX_DELAY_MS); }
function renderText(tpl, ctx){ return String(tpl||"").replace(/\{\{(\w+)\}\}/g,(_,k)=>String(ctx[k]??"")); }
function normalizarBrasil(numeroRaw){
  let n = String(numeroRaw||"").replace(/\D/g,"");
  if(!n.startsWith("55")) n = "55"+n;
  n = n.replace(/^55+0*/, "55");
  return n;
}
function variantsBR(n){
  const out = new Set([n]);
  // 55 + DDD(2) + 9 + 8 dígitos → versão sem o '9'
  if (n.length === 13 && n.startsWith("55") && n[4] === "9") {
    out.add(n.slice(0,4) + n.slice(5));
  }
  // 55 + DDD(2) + 8 dígitos → versão com '9'
  if (n.length === 12 && n.startsWith("55")) {
    out.add(n.slice(0,4) + "9" + n.slice(4));
  }
  return out;
}
function primeiroNome(nome){
  if(!nome) return "Contato";
  const p = String(nome).trim().split(/\s+/)[0]||"Contato";
  return p.charAt(0).toUpperCase()+p.slice(1).toLowerCase();
}

// ====== Estado ======
let lastQr = null, isReady = false;
let CONTACTS = { grupoA: [], grupoB: [] };
let DIALOGUES = { rounds: {} };
let whitelistA = new Set(); // números e164 (com variantes) de A autorizados

function load(file){
  try{ return JSON.parse(fs.readFileSync(path.resolve(file),"utf-8")); }
  catch{ return null; }
}
function reload(){
  CONTACTS = load(CONTACTS_FILE) || { grupoA: [], grupoB: [] };
  DIALOGUES = load(DIALOGUES_FILE) || { rounds: {} };

  const wl = new Set();
  // contatos do grupo A
  for (const c of (CONTACTS.grupoA || [])) {
    const base = normalizarBrasil(c.numero);
    for (const v of variantsBR(base)) wl.add(v);
  }
  // números explícitos via .env
  for (const s of ALLOWED_A_NUMBERS) {
    const base = normalizarBrasil(s);
    for (const v of variantsBR(base)) wl.add(v);
  }
  whitelistA = wl;

  console.log(`↻ [B] whitelist A=${whitelistA.size} | rounds=${Object.keys(DIALOGUES.rounds||{}).length}`);
  console.log("👀 [B] exemplos whitelistA:", Array.from(whitelistA).slice(0,8));
}
reload();

// conversaState guarda qual foi o último round A recebido por chat
// quando A manda 1 → B responde 2; quando A manda 3 → B responde 4; quando A manda 5 → B responde 6
const conversaState = new Map(); // chatIdA -> { lastARound: 0, nomeA, meuNome }

// ====== WhatsApp client (B) ======
const client = new Client({
  authStrategy: new LocalAuth({ clientId: CLIENT_ID, dataPath: SESSION_PATH }),
  puppeteer: { headless: true, args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"] }
});
client.on("qr", qr => { lastQr=qr; isReady=false; console.log("📶 [B] QR pronto em /qr"); });
client.on("ready", ()=>{
  isReady=true; lastQr=null;
  console.log("✅ [B] pronto");
  console.log("Meu JID:", client.info?.wid?._serialized || "(desconhecido)");
});
client.on("auth_failure", m=>console.error("❌ [B] auth_failure:", m));
client.on("disconnected", r=>{ isReady=false; console.warn("⚠️ [B] disconnected:", r); });

function pickB(round){
  const opts = DIALOGUES?.rounds?.[String(round)]?.B || [];
  if(!opts.length) return null;
  return opts[Math.floor(Math.random()*opts.length)];
}

client.on("message", async (msg) => {
  try{
    if(msg.fromMe) return;
    if(!msg.from.endsWith("@c.us")) return; // ignora grupos/status

    const chatId = msg.from;
    const numeroA = (chatId||"").split("@")[0];
    const e164A = normalizarBrasil(numeroA);

    if(BLOCK_UNKNOWN && !whitelistA.has(e164A)){
      console.log("🙈 [B] ignorando não-whitelist A:", e164A);
      return;
    }

    const contactA = await msg.getContact();
    const nomeA = primeiroNome(contactA?.pushname || contactA?.name || "Contato");

    // estado desta conversa
    const st = conversaState.get(chatId) || { lastARound: 0, nomeA, meuNome: "Eu" };

    // heurística simples: contar falas do A por ordem de chegada
    // 1a vez que A fala -> assumimos que é o round 1; depois 3; depois 5
    let proximoBRound;
    if(st.lastARound === 0){ st.lastARound = 1; proximoBRound = 2; }
    else if(st.lastARound === 1){ st.lastARound = 3; proximoBRound = 4; }
    else if(st.lastARound === 3){ st.lastARound = 5; proximoBRound = 6; }
    else {
      // já completou 6, não responder mais automaticamente
      console.log(`[B] conversa concluída com ${numeroA}`);
      conversaState.delete(chatId);
      return;
    }

    conversaState.set(chatId, st);

    const tpl = pickB(proximoBRound);
    if(!tpl){ console.log(`⚠️ [B] sem template B para round ${proximoBRound}`); return; }

    // responder com atraso aleatório
    const texto = renderText(tpl, { nome: nomeA, nomeA: nomeA, nomeB: st.meuNome });
    const delay = randomDelay();
    console.log(`[B→A] agendando round ${proximoBRound} em ${delay}ms p/ ${chatId}: "${texto}"`);
    setTimeout(async ()=>{
      try{ await client.sendMessage(chatId, texto); }
      catch(e){ console.warn("⚠️ [B] falha send:", e?.message||e); }
    }, delay);

    // se acabamos de responder o 6, limpamos o estado após enviar
    if(proximoBRound === 6){
      setTimeout(()=>{ conversaState.delete(chatId); }, delay+2_000);
    }
  }catch(e){
    console.warn("⚠️ [B] handler erro:", e?.message||e);
  }
});

// ====== HTTP util ======
const app = express();
app.use(express.json());

app.get("/qr", async (_req,res)=>{
  if(!lastQr && isReady) return res.send("✅ Já pareado (B).");
  if(!lastQr) return res.send("Aguardando QR (B)...");
  const png = await qrcode.toBuffer(lastQr,{type:"png",margin:1,scale:6});
  res.setHeader("Content-Type","image/png"); res.send(png);
});

app.post("/reload", (_req,res)=>{ reload(); res.json({ok:true, whitelistA: whitelistA.size}); });
app.get("/healthz", (_req,res)=>{ res.json({ok:true, ready:isReady}); });

// debug helpers
app.get("/debug/whitelist", (_req,res)=>{
  res.json({ ok:true, whitelist: Array.from(whitelistA) });
});
app.get("/whoami", (_req,res)=>{
  res.json({ jid: client.info?.wid?._serialized || null });
});

app.listen(PORT, ()=>console.log(`🌐 [B] HTTP :${PORT}`));
client.initialize();
