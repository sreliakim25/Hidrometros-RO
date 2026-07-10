# Controle de Hidrômetros — Recanto das Oliveiras

Aplicativo web para gerenciar a **substituição de hidrômetros** dos 505 lotes do
condomínio Recanto das Oliveiras (Gleba 06) — **Viana e Moura Construções**.

Permite acompanhar, por lote, o andamento da troca (pendente, agendado, concluído,
dispensado), visualizar tudo em lista ou no **mapa do condomínio**, acompanhar
indicadores no **dashboard**, planejar no **calendário** e gerar **relatório em PDF**.
Conta ainda com um **módulo de auditoria (Logs)** de acesso exclusivo do administrador.

---

## Funcionalidades

- **Lista** de lotes com busca e filtros por status, quadra, via e prioridade.
- **Mapa** interativo (SVG do loteamento) com cores por status e pins para
  equipamentos condominiais / áreas comuns.
- **Dashboard** com evolução das conclusões (dia/semana/mês), ritmo e estimativa
  de término.
- **Calendário** de agendamentos e conclusões.
- **Relatório em PDF** pronto para impressão.
- **Modo edição protegido por login** — só usuárias autorizadas alteram os dados.
- **Módulo de Logs (auditoria)** — exclusivo do admin: registra **quem** editou
  **o quê**, **quando** e em **que horário**, com painel-resumo e tabela filtrável.
- **Sincronização em tempo real** entre aparelhos (Supabase Realtime).
- **PWA** — instalável na tela inicial do celular (iOS e Android).

---

## Tecnologias

- **React 18** + **Vite** (build e dev server)
- **Supabase** (banco de dados PostgreSQL, políticas de segurança RLS e Realtime)
- **lucide-react** (ícones)
- Deploy na **Vercel**

Sem Supabase configurado, o app funciona em modo local usando o `localStorage`
do navegador (útil para testes).

---

## Acessos (modo edição)

O login fica embutido no app (não usa o Supabase Auth). Há três contas:

| Login    | Papel   | O que acessa                                   |
|----------|---------|------------------------------------------------|
| `nayara` | editor  | Edita os hidrômetros                           |
| `erika`  | editor  | Edita os hidrômetros                           |
| `admin`  | admin   | Edita **+** acessa o módulo de **Logs**        |

As senhas vêm de variáveis de ambiente (nunca ficam no código):

- `VITE_PASS_NAYARA`
- `VITE_PASS_ERIKA`
- `VITE_PASS_ADMIN`

Defina-as em `.env.local` (desenvolvimento) e nas *Environment Variables* da
Vercel (produção). Veja `.env.example` como modelo.

---

## Como rodar localmente

```bash
# 1. Instalar dependências
npm install

# 2. Configurar ambiente
cp .env.example .env.local
#   e preencher as chaves do Supabase + as senhas

# 3. Rodar em modo desenvolvimento
npm run dev          # abre em http://localhost:5173

# Build de produção
npm run build        # gera a pasta dist/
npm run preview      # pré-visualiza o build
```

---

## Banco de dados (Supabase)

O arquivo [`supabase-setup.sql`](./supabase-setup.sql) cria as tabelas, as
políticas de segurança (RLS), o Realtime e o *seed* dos 505 lotes.

Tabelas:

- **`unidades`** — os lotes e o status de cada troca.
- **`pins`** — marcadores do mapa (equipamentos condominiais / áreas comuns).
- **`logs`** — registro imutável de auditoria (só inserção e leitura).

> ⚠️ Ao criar o banco pela primeira vez, rode o arquivo inteiro.
> Depois disso, **não rode o arquivo todo de novo** (o *seed* usa `insert` e
> daria erro de duplicata) — rode apenas o bloco da tabela que precisar.

---

## Estrutura do projeto

```
├── index.html                  # HTML base + configuração PWA
├── controle-hidrometros-1.jsx  # componente principal (toda a interface)
├── src/
│   ├── main.jsx                # ponto de entrada React
│   ├── App.jsx                 # reexporta o componente principal
│   ├── lib/supabase.js         # camada de dados (Supabase + logs)
│   ├── hooks/useUnits.js       # hook de persistência
│   └── data/lotsData.js        # dados dos 505 lotes (gerado do Excel + SVG)
├── public/                     # ícones e manifest do PWA
├── supabase-setup.sql          # esquema + segurança + seed
└── .env.example                # modelo das variáveis de ambiente
```

---

## Segurança e privacidade

- As senhas ficam em variáveis de ambiente, fora do código-fonte.
- O `.env.local` está no `.gitignore` (não é enviado ao repositório).
- Os logs de auditoria são **imutáveis**: o banco só permite inserir e ler,
  nunca alterar ou apagar registros.
