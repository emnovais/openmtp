# Draft repository metadata and bilingual release notes

**Draft only. Do not publish a release or imply an installer exists.** These notes are for review alongside the [publication plan](PUBLICATION_PLAN.md). The inherited manifest version is 3.3.0; no fork release number is assigned.

## Suggested GitHub description — English

OpenMTP development fork for macOS and Android: virtualized Grid, image thumbnails, scoped caching and safer cross-device Copy/Paste. Experimental native work; physical transfer validation pending.

## Descrição alternativa — Português (Brasil)

Fork de desenvolvimento do OpenMTP para macOS e Android: Grade virtualizada, miniaturas, cache contextual e Copiar/Colar mais seguro entre dispositivos. Transferências físicas ainda não validadas.

Both alternatives are under 200 characters and within GitHub's 350-character description field. Use one description in the actual field; both languages are available through the README selector. No repository metadata has been changed. GitHub documents the [repository description field](https://docs.github.com/en/rest/repos/repos#update-a-repository); the 350-character validation is also recorded in a [GitHub API report](https://github.com/orgs/community/discussions/69436).

Suggested topics, for later review only: `openmtp`, `macos`, `android`, `mtp`, `electron`, `file-manager`, `thumbnails`, `virtualization`.

## English — Unreleased development snapshot

A development fork of Ganesh Rathinavel's OpenMTP, retaining its existing architecture and MIT notices.

- Independent List/Grid controls for Computer and Phone, synchronized with Settings.
- Windowed Grid rendering, lazy JPEG/PNG previews, bounded memory caching and replacement-consumer handling.
- Legacy Android native thumbnails with validated private output, fallback icons and no full-resolution fallback.
- Clipboard persistence across navigation, source/destination context checks and fail-closed destination lookup.
- Stronger terminal transfer/error evidence and FIFO MTP scheduling. Copy/Paste stays limited to Mac ↔ Android and preserves sources; Cut, Move and same-endpoint Paste remain excluded.
- Experimental Legacy USB-discovery patch documented separately. T11.3 validated the isolated native candidate; T11.4 integrated a development-only selector and passed four physical metadata/preflight queries. The corrected executable is not bundled.
- Fresh publication validation: 846 Node cases, 156 mocked Electron Grid/UI checks, JavaScript/style lint and both production compilers passed.

**Limits:** no verified installable fork release; physical file-transfer integrity, overwrite execution and cancellation remain unvalidated. A 10.14 build target is not proof of older-macOS runtime support. Kalam diagnostics remain unresolved. Publishing source still requires the native-asset licensing/provenance review. See [limitations](KNOWN_LIMITATIONS.md) and [credits](ATTRIBUTION.md).

## Português (Brasil) — Versão de desenvolvimento ainda não lançada

Fork de desenvolvimento do OpenMTP, criado por Ganesh Rathinavel, com a arquitetura existente e os avisos da licença MIT preservados.

- Controles independentes de Lista/Grade nos painéis Computador e Telefone, sincronizados com as Configurações.
- Grade virtualizada, prévias JPEG/PNG sob demanda, cache limitado em memória e tratamento da substituição de componentes durante solicitações em andamento.
- Miniaturas nativas do Android via Legacy, com validação da saída temporária privada, ícones alternativos e sem baixar a imagem completa como alternativa.
- Área de transferência preservada durante a navegação, validação do contexto da origem e do destino e bloqueio quando a existência do destino é desconhecida.
- Verificação mais rigorosa dos resultados finais das transferências e erros, com fila FIFO para MTP. Copiar/Colar continua limitado a Mac ↔ Android e preserva as origens; Recortar, Mover e Colar no mesmo dispositivo permanecem fora do escopo.
- Correção experimental da descoberta USB do Legacy documentada separadamente. A T11.3 validou o executável nativo isolado; a T11.4 integrou um seletor exclusivo de desenvolvimento e aprovou quatro consultas físicas de metadados/validação prévia. O executável corrigido não está incluído no pacote.
- Nova validação de publicação: 846 testes Node, 156 verificações de Grade/interface no Electron com MTP simulado, lints de JavaScript/estilos e os dois compiladores de produção aprovados.

**Limites:** não há lançamento instalável deste fork verificado; a integridade das transferências físicas, a execução de sobrescritas e o cancelamento ainda precisam de validação. Definir 10.14 como alvo de compilação não comprova execução em versões anteriores do macOS. Os diagnósticos do Kalam continuam sem solução confirmada. Publicar o código ainda exige revisar as licenças e a procedência dos binários nativos. Consulte as [limitações](KNOWN_LIMITATIONS.md) e os [créditos](ATTRIBUTION.md).
