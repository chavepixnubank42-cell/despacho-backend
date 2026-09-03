# Despacho — Backend

API que substitui o `window.storage` do protótipo, pra funcionar fora do Claude,
em qualquer celular, a qualquer hora.

## O que tem aqui

- `server.js` — a API (rotas de comércio, motoboy e corridas)
- `db.js` — banco de dados simples em arquivo JSON (`data.json`, criado sozinho na primeira execução)
- `package.json` — lista de dependências

Não precisa de Postgres, MySQL nem nada externo pra começar — os dados ficam
guardados num arquivo `data.json` do lado do servidor. Se o negócio crescer
bastante, dá pra trocar por um banco de verdade depois sem mudar a lógica das
rotas.

## Rodando no seu computador (pra testar)

Pré-requisito: ter o [Node.js](https://nodejs.org) instalado (versão 18 ou mais nova).

```
cd despacho-backend
npm install
npm start
```

Isso sobe a API em `http://localhost:3000`. Abrindo esse endereço no navegador
deve aparecer "Despacho API rodando ✅".

## Rotas disponíveis

| Rota | O que faz |
|---|---|
| `POST /api/businesses` | Cadastra um comércio `{name, phone, address}` |
| `GET /api/businesses` | Lista todos os comércios |
| `POST /api/motoboys` | Cadastra um motoboy `{name, phone, vehicle}` |
| `GET /api/motoboys` | Lista todos os motoboys |
| `PATCH /api/motoboys/:id` | Liga/desliga o status on-line `{online: true/false}` |
| `POST /api/orders` | Cria uma corrida `{businessId, pickupAddress, deliveryAddress, value, note}` |
| `GET /api/orders` | Lista corridas (aceita `?businessId=` ou `?motoboyId=`) |
| `GET /api/orders/available/:motoboyId` | Corridas disponíveis pra um motoboy específico agora |
| `POST /api/orders/:id/accept` | Motoboy aceita `{motoboyId}` |
| `POST /api/orders/:id/decline` | Motoboy recusa `{motoboyId}` |
| `POST /api/orders/:id/arrive-pickup` | Marca chegada na retirada |
| `POST /api/orders/:id/depart` | Marca saída para entrega |
| `POST /api/orders/:id/arrive-delivery` | Marca chegada na entrega |
| `POST /api/orders/:id/deliver` | Confirma entrega concluída |
| `POST /api/orders/:id/cancel` | Cancela a corrida |

A fila de oferta (só um motoboy vê a corrida por vez, com 30 segundos pra
responder antes de passar pro próximo) já está implementada dentro do
`server.js`, incluindo um relógio de fundo que passa a corrida adiante mesmo
que ninguém esteja com o app aberto naquele momento.

**Fila por proximidade:** enquanto estiver on-line, o app do motoboy manda
sua localização pro servidor a cada ~25 segundos (`PATCH /api/motoboys/:id`
com `{lat, lng}`). Quando uma corrida nova é criada, o endereço de retirada
já é convertido em coordenadas (geocodificação) — com isso, a fila passa a
oferecer a corrida primeiro pro motoboy mais PERTO da retirada, e só usa
"quem fez menos corridas" como critério de desempate ou para motoboys sem
localização recente (ex: GPS recusado, ou ficou mais de 10 minutos sem
atualizar).

## Colocando no ar de verdade (deploy)

Qualquer um destes serviços tem plano gratuito e funciona bem pra começar:

- **Railway** (railway.app) — o mais simples: conecta o GitHub, ele detecta
  o Node.js sozinho e sobe.
- **Render** (render.com) — parecido com o Railway, também bem direto.
- **Fly.io** (fly.io) — um pouco mais técnico, mas também gratuito pra começar.

Passo geral (vale pros três):
1. Sobe essa pasta pra um repositório no GitHub.
2. Cria uma conta no serviço escolhido e conecta esse repositório.
3. Ele vai rodar `npm install` e `npm start` sozinho.
4. Você recebe uma URL pública, tipo `https://despacho-api.up.railway.app`.

⚠️ **Atenção ao `data.json`:** em alguns serviços gratuitos, o sistema de
arquivos é apagado a cada novo deploy/reinício. Pra não perder os dados,
depois de validar que tudo funciona, vale migrar pra um banco de verdade
(o Railway e o Render oferecem Postgres gratuito, por exemplo).

## Configurando os pagamentos (Mercado Pago / Pix)

Pra ativar a recarga de créditos do comércio via Pix, você precisa:

1. Criar (ou já ter) uma conta no [Mercado Pago](https://www.mercadopago.com.br).
2. Ir em [mercadopago.com.br/developers/panel](https://www.mercadopago.com.br/developers/panel/app) → criar uma aplicação → pegar o **Access Token** (comece pelo de **teste/sandbox**, pra não usar dinheiro de verdade enquanto valida o fluxo).
3. No Railway, no seu projeto, ir em **Variables** e adicionar:
   ```
   MERCADOPAGO_ACCESS_TOKEN=seu_access_token_aqui
   ```
4. (Opcional, mas recomendado) No painel do Mercado Pago, em **Webhooks**, cadastrar a URL:
   ```
   https://SUA-API.up.railway.app/api/webhooks/mercadopago
   ```
   Isso faz o crédito ser adicionado assim que o Pix é pago, sem precisar esperar o app perguntar. Mesmo sem isso, o app já verifica sozinho a cada poucos segundos enquanto o QR code está na tela.

Sem essa variável configurada, o app continua funcionando normalmente — só a recarga de créditos fica temporariamente desabilitada, com um aviso claro pro usuário.

### Testando sem gastar dinheiro de verdade

O Mercado Pago tem um modo de teste completo: com o Access Token de teste,
os Pix gerados não movimentam dinheiro real, e você pode simular a
aprovação do pagamento pelo próprio painel deles. Veja a documentação de
["Realizar testes"](https://www.mercadopago.com.br/developers/pt/docs/checkout-api/additional-content/your-integrations/test/cards)
no site do Mercado Pago antes de trocar pro Access Token de produção.

## Próximo passo

Depois que a API estiver publicada e com uma URL, o app (o arquivo
`entregas.html`) precisa ser atualizado pra chamar essa URL em vez do
`window.storage` — é a próxima etapa que a gente combinou de fazer.
