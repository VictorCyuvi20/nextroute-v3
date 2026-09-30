import dotenv from "dotenv";
dotenv.config();

import express, { response } from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// ─── Chaves de API ─────────────────────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ORS_API_KEY = process.env.ORS_API_KEY;
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
// Chave gratuita em: https://openweathermap.org → Sign Up → API Keys
// ───────────────────────────────────────────────────────────────────────────────

const KM_POR_LITRO = {
  carro_flex: 11, carro_gasolina: 11, carro_etanol: 9,
  diesel: 9, moto: 25, eletrico: null,
};

// ─── Cache de preços ANP ───────────────────────────────────────────────────────
let precosCache = {
  gasolina: 6.20, etanol: 4.30, diesel: 6.50,
  fonte: "Estimativa", data: new Date().toLocaleDateString("pt-BR"),
};
let precosCacheTime = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000;

async function fetchPrecosANP() {
  if (Date.now() - precosCacheTime < CACHE_TTL) return precosCache;
  try {
    console.log("🛢️  Buscando preços ANP...");
    const pkgRes = await fetch(
      "https://dados.gov.br/api/3/action/package_show?id=serie-historica-de-precos-de-combustiveis-e-de-glp",
      { signal: AbortSignal.timeout(7000) }
    );
    const pkg      = await pkgRes.json();
    const csvFiles = (pkg.result?.resources || [])
      .filter(r => r.format?.toUpperCase() === "CSV" && r.url)
      .sort((a, b) => (b.name || "").localeCompare(a.name || ""));
    if (!csvFiles.length) throw new Error("Sem CSV");
    const csvRes  = await fetch(csvFiles[0].url, { signal: AbortSignal.timeout(10000) });
    const text    = await csvRes.text();
    const lines   = text.split("\n").filter(l => l.trim());
    const headers = lines[0].split(";").map(h => h.replace(/["\r]/g, "").trim().toLowerCase());
    const iProd   = headers.findIndex(h => h.includes("produto"));
    const iPreco  = headers.findIndex(h => h.includes("preço médio revenda") || h.includes("valor de venda"));
    if (iProd === -1 || iPreco === -1) throw new Error("Colunas não encontradas");
    const found = {};
    for (let i = lines.length - 1; i > 0; i--) {
      const cols  = lines[i].split(";").map(c => c.replace(/["\r]/g, "").trim());
      const prod  = (cols[iProd] || "").toLowerCase();
      const preco = parseFloat((cols[iPreco] || "").replace(",", "."));
      if (!preco || isNaN(preco)) continue;
      if (!found.gasolina && prod.includes("gasolina comum"))                      found.gasolina = preco;
      if (!found.etanol   && (prod.includes("etanol") || prod.includes("álcool"))) found.etanol   = preco;
      if (!found.diesel   && prod.includes("diesel") && !prod.includes("s10"))     found.diesel   = preco;
      if (found.gasolina && found.etanol && found.diesel) break;
    }
    if (found.gasolina) {
      precosCache = { ...found, fonte: "ANP", data: new Date().toLocaleDateString("pt-BR") };
      precosCacheTime = Date.now();
      console.log("✅ Preços ANP:", precosCache);
    } else throw new Error("Preços não encontrados");
  } catch (e) {
    console.log("⚠️  ANP indisponível:", e.message);
    precosCache.fonte = "Estimativa";
  }
  return precosCache;
}

// ─── Decodificador de Encoded Polyline (formato padrão do ORS) ────────────────
// O ORS retorna a geometria como encoded polyline — precisamos decodificar
// para obter os pares [lat, lon] que o Leaflet usa.
function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== "string") return [];
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : result >> 1;
    coords.push([lat / 1e5, lng / 1e5]); // [lat, lon] para o Leaflet
  }
  return coords;
}

// ─── Geocodificação ────────────────────────────────────────────────────────────
async function geocode(text) {
  const url  = `https://api.openrouteservice.org/geocode/search?api_key=${ORS_API_KEY}&text=${encodeURIComponent(text + " Brasil")}&boundary.country=BR&size=1`;
  const res  = await fetch(url);
  const data = await res.json();
  const feat = data.features?.[0];
  if (!feat) throw new Error(`Localidade não encontrada: "${text}"`);
  const [lon, lat] = feat.geometry.coordinates;
  return { lat, lon, label: feat.properties.label };
}

// ─── Clima ─────────────────────────────────────────────────────────────────────
async function fetchClima(lat, lon, label) {
  if (!OPENWEATHER_API_KEY || OPENWEATHER_API_KEY === "SUA_CHAVE_OPENWEATHER") return null;
  try {
    const url  = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OPENWEATHER_API_KEY}&units=metric&lang=pt_br`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (!res.ok) return null;
    const codigo = data.weather?.[0]?.id || 800;
    let alerta = false, icone = "sun", nivel = "ok";
    if      (codigo < 300) { alerta = true; icone = "storm";      nivel = "perigo";  }
    else if (codigo < 400) { alerta = true; icone = "cloud-rain"; nivel = "atencao"; }
    else if (codigo < 600) { alerta = true; icone = "cloud-rain"; nivel = "atencao"; }
    else if (codigo < 700) { alerta = true; icone = "snowflake";  nivel = "perigo";  }
    else if (codigo < 800) { alerta = true; icone = "mist";       nivel = "atencao"; }
    else if (codigo === 800) icone = "sun";
    else                     icone = "cloud";
    return {
      label,
      descricao:   data.weather?.[0]?.description || "",
      temperatura: Math.round(data.main?.temp || 25),
      umidade:     data.main?.humidity || 0,
      alerta, icone, nivel,
    };
  } catch { return null; }
}

// ─── Utilitários ───────────────────────────────────────────────────────────────
function extrairVias(segments) {
  const vias = new Set();
  for (const seg of segments)
    for (const step of (seg.steps || []))
      if (step.name && step.name !== "-" && step.name.length > 3) vias.add(step.name);
  return [...vias].slice(0, 4).join(", ") || "Via local";
}

function calcCombustivel(distanciaKm, veiculo, precos) {
  const kmL = KM_POR_LITRO[veiculo];
  if (veiculo === "eletrico") return +((distanciaKm * 0.18) * 0.75).toFixed(2);
  if (!kmL) return 0;
  const precoMap = {
    carro_flex: precos.etanol, carro_gasolina: precos.gasolina,
    carro_etanol: precos.etanol, diesel: precos.diesel, moto: precos.gasolina,
  };
  return +((distanciaKm / kmL) * (precoMap[veiculo] || precos.gasolina)).toFixed(2);
}

function calcularMelhorHorario(departureStr) {
  const [h, m] = (departureStr || "08:00").split(":").map(Number);
  const min    = h * 60 + m;
  const picos  = [
    { inicio: 6*60+30,  fim: 9*60+30,  antes: "06:00", depois: "09:30", label: "manhã (07h–09h)" },
    { inicio: 16*60+30, fim: 20*60+30, antes: "16:00", depois: "20:30", label: "tarde (17h–20h)" },
  ];
  for (const p of picos)
    if (min >= p.inicio && min <= p.fim)
      return { emPico: true, label: p.label, sugestoes: [p.antes, p.depois], mensagem: `Horário de pico do ${p.label}.` };
  return { emPico: false, sugestoes: [], mensagem: null };
}

function gerarLinksExport(origLabel, destLabel) {
  const enc = s => encodeURIComponent(s);
  return {
    googleMaps: `https://www.google.com/maps/dir/?api=1&origin=${enc(origLabel)}&destination=${enc(destLabel)}&travelmode=driving`,
    waze:       `https://waze.com/ul?q=${enc(destLabel)}&navigate=yes`,
  };
}

// ─── Endpoints ─────────────────────────────────────────────────────────────────
app.get("/api/precos", async (_req, res) => res.json(await fetchPrecosANP()));

app.post("/api/rotas", async (req, res) => {
  const { origin, destination, vehicle, departure, priority } = req.body;
  try {
    console.log(`🔍 ${origin} → ${destination}`);

    const [[orig, dest], precos] = await Promise.all([
      Promise.all([geocode(origin), geocode(destination)]),
      fetchPrecosANP(),
    ]);

    const [climaOrig, climaDest, orsRes] = await Promise.all([
      fetchClima(orig.lat, orig.lon, orig.label),
      fetchClima(dest.lat, dest.lon, dest.label),
      fetch("https://api.openrouteservice.org/v2/directions/driving-car/json", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": ORS_API_KEY },
        body: JSON.stringify({
          coordinates:        [[orig.lon, orig.lat], [dest.lon, dest.lat]],
          alternative_routes: { target_count: 3, weight_factor: 1.6, share_factor: 0.6 },
          instructions:       true,
          language:           "pt",
          // geometry vem como encoded polyline por padrão — sem geometry_format
        }),
      }),
    ]);

    const orsData = await orsRes.json();
    if (!orsRes.ok || !orsData.routes?.length)
      return res.status(500).json({ error: orsData.error?.message || "ORS não encontrou rotas." });

    const rotasBruto = orsData.routes.map((r, i) => {
      const distanciaKm = +(r.summary.distance / 1000).toFixed(1);
      return {
        indice:           i + 1,
        distanciaKm,
        tempoMin:         Math.round(r.summary.duration / 60),
        vias:             extrairVias(r.segments),
        custoCombustivel: calcCombustivel(distanciaKm, vehicle, precos),
        // Decodifica o encoded polyline → [lat, lon] para o Leaflet
        geometria:        decodePolyline(r.geometry),
      };
    });

    const pLabels = {
      equilibrado:       "equilibrado",
      menor_tempo:       "menor tempo",
      menor_combustivel: "menos combustível",
      menor_pedagio:     "menos pedágio",
      evitar_transito:   "evitar trânsito",
    };

    const groqPrompt = `Especialista em rodovias brasileiras. Rotas de "${orig.label}" para "${dest.label}":
${rotasBruto.map(r => `Rota ${r.indice}: ${r.distanciaKm}km | ${r.tempoMin}min | ${r.vias} | R$${r.custoCombustivel}`).join("\n")}
Horário: ${departure} | Prioridade: ${pLabels[priority] || priority}
IMPORTANTE: retorne SOMENTE o objeto JSON abaixo, sem nenhum texto antes ou depois, sem explicações, sem markdown:
{"resumo":"string","rotas":[{"nome":"string","pedagio_reais":number,"nivel_transito":"baixo|moderado|intenso","melhor":boolean,"destaque":"Mais rápida|Mais econômica|Menos pedágio|null","analise":"2 frases"}]}`;

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [
          {
            role: "user",
            content: groqPrompt
          }
        ],
        temperature: 0.2,
        max_tokens: 1500,
        response_format: {
          type: "json_object"
        }
      })
    });
    const groqData = await groqRes.json();

    console.log("RESPOSTA COMPLETA DA GROQ:");
    console.log(JSON.stringify(groqData, null, 2));

    const groqText = groqData.choices?.[0]?.message?.content || "";
    const jsonMatch = groqText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: "IA não retornou JSON válido. Tente novamente." });
    const groqJson = JSON.parse(jsonMatch[0]);

    const rotasFinais = rotasBruto.map((r, i) => ({
      nome:                    groqJson.rotas?.[i]?.nome           || `Rota ${r.indice}`,
      via:                     r.vias,
      distancia_km:            r.distanciaKm,
      tempo_min:               r.tempoMin,
      custo_combustivel_reais: r.custoCombustivel,
      pedagio_reais:           groqJson.rotas?.[i]?.pedagio_reais  || 0,
      nivel_transito:          groqJson.rotas?.[i]?.nivel_transito || "moderado",
      melhor:                  groqJson.rotas?.[i]?.melhor         || false,
      destaque:                groqJson.rotas?.[i]?.destaque       || null,
      analise:                 groqJson.rotas?.[i]?.analise        || "",
      geometria:               r.geometria,
    }));

    console.log(`✅ ${rotasFinais.length} rotas prontas.`);
    res.json({
      resumo:        groqJson.resumo,
      rotas:         rotasFinais,
      origem:        orig.label,
      destino:       dest.label,
      coordOrigem:   [orig.lat, orig.lon],
      coordDestino:  [dest.lat, dest.lon],
      precos,
      clima:         { origem: climaOrig, destino: climaDest },
      melhorHorario: calcularMelhorHorario(departure),
      exportar:      gerarLinksExport(orig.label, dest.label),
    });

  } catch (err) {
    console.error("Erro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ NextRoute em http://localhost:${PORT}\n`);
});