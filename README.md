# Trajeto IA 🗺️
**Inteligência em cada quilômetro — versão gratuita com Google Gemini**

---

## Como obter a chave gratuita (sem cartão de crédito)

1. Acesse **https://aistudio.google.com**
2. Faça login com sua conta Google
3. Clique em **"Get API key"** → **"Create API key"**
4. Copie a chave gerada (começa com `AIza...`)

Limite gratuito: **1.500 requisições/dia** — mais do que suficiente para uso pessoal.

---

## Configuração e execução

### 1. Instale as dependências
```bash
npm install
```

### 2. Cole sua chave no server.js
Abra `server.js` e substitua `SUA_CHAVE_AQUI`:
```js
const GEMINI_API_KEY = "AIzaSy...sua chave aqui...";
```

### 3. Inicie o servidor
```bash
node server.js
```

### 4. Abra no navegador
```
http://localhost:3000
```

---

## Estrutura do projeto

```
trajeto-ia/
├── server.js        ← Servidor Node.js (proxy seguro da API)
├── package.json     ← Dependências
└── public/
    └── index.html   ← Interface do usuário
```

---

## Por que usar um servidor local?

A chave da API não pode ficar no HTML (qualquer um poderia ver e usar). O `server.js` funciona como um intermediário seguro: recebe o pedido do navegador, chama a API do Gemini com a chave, e devolve o resultado — sem expor nada.
