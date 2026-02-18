# OrderExtract

Aplicação para extrair dados de notas de encomenda (PDF/imagem) para importação no PHC.

## Requisitos

- [Node.js](https://nodejs.org) versão 18 ou superior
- Uma API key da Anthropic ([console.anthropic.com](https://console.anthropic.com))

## Instalação e arranque

1. Descomprime a pasta `order-extract`
2. Abre o terminal dentro dessa pasta
3. Executa os seguintes comandos:

```bash
npm install
npm run dev
```

4. Abre o browser em **http://localhost:5173**
5. Na primeira vez, introduce a tua API key da Anthropic (começa com `sk-ant-`)

## Utilização

1. Arrasta ou seleciona os PDFs/imagens das notas de encomenda
2. Clica em **Extrair Dados**
3. Verifica os dados na pré-visualização
4. Clica em **Exportar CSV** para descarregar o ficheiro para importar no PHC

## Campos extraídos

- Cabeçalho: Cliente, Nº Encomenda, Data, Compromisso, Cabimento, Nº Contrato
- Linhas: Cód. Artigo, Referência, Designação, Quantidade, Unidade, Preço, IVA, Totais
- Entregas programadas: colunas automáticas (Entrega 1 Data, Entrega 1 Qtd, etc.)

## Notas

- A API key é guardada localmente no browser (localStorage), nunca é enviada para outro servidor
- Uma linha no CSV = um artigo da encomenda (o cabeçalho repete por linha para importação no PHC)
- O CSV usa separador `;` e encoding UTF-8 com BOM para abrir corretamente no Excel
