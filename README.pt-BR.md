# OpenMTP — Fork de desenvolvimento do explorador de arquivos

**[English → README.md](README.md) | [Português (Brasil) → README.pt-BR.md](README.pt-BR.md)**

Este fork de desenvolvimento do [OpenMTP, criado por Ganesh Rathinavel](https://github.com/ganeshrvel/openmtp), busca tornar a navegação entre macOS e Android mais ágil e melhorar a segurança das transferências USB existentes. A arquitetura com Electron 18, React 17 e Redux foi preservada. Este projeto não é uma versão oficial do OpenMTP original.

**Situação atual: desenvolvimento, sem lançamento deste trabalho.** A navegação local e os testes limitados de navegação e miniaturas em um dispositivo com o backend Legacy tiveram resultados positivos. As mudanças recentes de segurança das transferências passaram nos testes automatizados offline, mas ainda não foram validadas com transferências reais de arquivos. Nenhuma versão pública instalável com estas melhorias foi verificada ou é anunciada aqui. `3.3.0` é a versão herdada do projeto original, e não um novo lançamento deste fork.

## Melhorias

- **Controles de Lista/Grade independentes:** os painéis Computador e Telefone têm seus próprios seletores, sincronizados com as Configurações e com a persistência já existente. A troca preserva a pasta atual, a seleção, a ordenação e a área de transferência.
- **Desempenho da Grade:** a virtualização mantém montadas apenas as linhas visíveis e próximas da área de visualização. A atualização acompanha a rolagem e o redimensionamento, enquanto a seleção considera a lista completa. A visualização em Lista ainda não é virtualizada. Em um teste físico limitado com 916 itens, foram observados de 24 a 36 blocos montados na Grade; isso é uma observação do teste, não uma garantia geral de desempenho.
- **Miniaturas de imagens:** prévias de JPEG/PNG locais e miniaturas obtidas pelo comando `get-thumb` do Legacy no Android aparecem progressivamente, conforme a visibilidade real dos itens. Arquivos incompatíveis, miniaturas indisponíveis ou resultados desatualizados mantêm o ícone normal. O sistema não baixa a imagem Android em resolução completa como alternativa à miniatura.
- **Cache com limites:** prévias prontas podem ser reutilizadas ao alternar Grade → Lista → Grade no mesmo contexto. A substituição de um componente durante uma solicitação em andamento evita trabalho duplicado. As verificações consideram a identidade do arquivo e da listagem e, no Android, o backend, o armazenamento e o contexto da sessão do renderer. A saída temporária nativa é validada e removida; as prévias ficam em um cache limitado em memória, sem uma biblioteca persistente em disco.
- **Área de transferência durante a navegação:** os caminhos copiados permanecem disponíveis ao mudar de pasta. A validação da origem, do destino e do contexto rejeita identidades desatualizadas, destinos alterados e confirmações atrasadas.
- **Resultado das transferências:** atingir 100% de progresso não significa sucesso. O código verifica o resultado final, o retorno nativo ou encerramento do processo e a propagação de erros. A presença do destino é conferida após uma transferência informada como bem-sucedida; essa presença, por si só, não comprova a integridade dos bytes.
- **Validação prévia do destino:** os estados existente, ausente e desconhecido são diferentes. Um erro de consulta impede a continuação, em vez de autorizar silenciosamente uma sobrescrita ou tratar o destino como inexistente.
- **Serialização MTP:** os caminhos de execução compatíveis, sob responsabilidade do renderer, compartilham uma fila FIFO. Um timeout em JavaScript não libera uma operação nativa que pode continuar ativa. Essa fila não é uma trava global do sistema nem uma trava entre processos.

Os estados detalhados e as referências ao código estão no [inventário de funcionalidades](docs/FEATURE_STATUS.md).

## Operações e escopo

| Operação                                                                 | Situação atual                                                                                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Copiar/Colar do Mac para o Android                                       | Caminho existente preservado e reforçado; testes automatizados aprovados, aceitação com transferência física pendente |
| Copiar/Colar do Android para o Mac                                       | Caminho existente preservado e reforçado; testes automatizados aprovados, aceitação com transferência física pendente |
| Navegação por pastas, seleção múltipla, ordenação, Lista/Grade           | Implementados; testes automatizados e observações limitadas de interface/dispositivo                                  |
| Excluir, Renomear e Nova Pasta como ações independentes                  | Funcionalidades existentes preservadas; os testes offline não representam uma nova aceitação em dispositivo físico    |
| Colar do Mac para o Mac ou do Android para o Android                     | Restrito; fora do escopo atual deste projeto                                                                          |
| Recortar, Mover e excluir a origem ao Colar                              | Fora do escopo; não implementados por este trabalho                                                                   |
| Miniaturas de vídeo e modos de ícones pequenos/médios/grandes ajustáveis | Não implementados por este trabalho                                                                                   |

Copiar/Colar preserva os arquivos de origem. Excluir continua sendo uma ação destrutiva independente e explícita; não faz parte da cópia.

## Compatibilidade MTP nativa

Por padrão, o backend Legacy ainda usa o executável original incluído no repositório. A etapa T11.3 testou uma correção isolada da descoberta de interfaces USB; **a T11.4 integrou separadamente uma opção explícita, exclusiva de desenvolvimento**, e testou os componentes reais de acesso a dados, repositório, controller, fila e a lógica extraída de validação prévia do Colar.

Quatro consultas físicas de metadados da T11.4 foram bem-sucedidas em um AYN Thor com Android 13, incluindo a identificação de destinos existentes e ausentes. O executável corrigido não foi incluído no pacote nem lançado. Aplicativos empacotados ignoram essa opção. A compilação x86_64 declara macOS 10.14 como alvo mínimo, mas só foi executada em macOS 26.6.2 com Apple Silicon; isso **não** comprova compatibilidade com versões anteriores do macOS.

As miniaturas Legacy têm evidências positivas de testes físicos limitados, inclusive de reutilização do cache. Alguns objetos do dispositivo retornaram `GeneralError (0x2002)` e mantiveram seus ícones. A navegação com Kalam teve resultados positivos anteriores, mas também apresentou diagnósticos ainda não resolvidos de `LIBUSB_ERROR_NOT_FOUND` e de sessão; miniaturas Android com Kalam não foram implementadas. O redesenho da propriedade dos recursos nativos está pausado; o aplicativo ativo continua com as operações MTP sob responsabilidade do renderer.

Consulte [compatibilidade nativa e reprodução](docs/NATIVE_MTP.md) e [limitações conhecidas](docs/KNOWN_LIMITATIONS.md). Uma miniatura ou consulta de metadados bem-sucedida não comprova a saúde geral da conexão USB nem a correção das transferências.

## Instalação e desenvolvimento

Este código é destinado ao desenvolvimento. Para baixar o aplicativo original, use o [site oficial do projeto original](https://openmtp.ganeshrvel.com/) ou os [lançamentos do projeto original](https://github.com/ganeshrvel/openmtp/releases); esses aplicativos não contêm as melhorias ainda não publicadas deste fork. Nenhum instalador deste fork é oferecido aqui.

Use versões isoladas de **Node 16.19.0, npm 8.16.0 e Yarn Classic 1.22.17**, as Command Line Tools do macOS e o lockfile existente. Não atualize dependências para seguir estas instruções. Go e uma recompilação nativa não são necessários para a compilação JavaScript normal com as bibliotecas já incluídas.

```sh
git clone https://github.com/emnovais/openmtp.git
cd openmtp
# Primeiro selecione o ambiente isolado descrito em docs/DEVELOPMENT.md.
HUSKY_SKIP_INSTALL=1 yarn install --frozen-lockfile --non-interactive
yarn lint
yarn lint-styles
yarn build
```

A instalação compila a DLL de desenvolvimento e os módulos nativos do Electron. `yarn build-dll` permite recompilar a DLL explicitamente. O comando existente para uma sessão interativa é `yarn dev`; **leia antes as orientações de isolamento de perfil e desconecte os dispositivos Android para um teste geral de inicialização**. A identidade e o diretório de configurações herdados podem coincidir com os de uma instalação do OpenMTP, e a abertura do explorador pode iniciar o MTP automaticamente.

O [guia de desenvolvimento](docs/DEVELOPMENT.md) reúne os comandos reproduzíveis de teste, as orientações de isolamento e os limites da seleção do executável nativo. Empacotamento, assinatura e publicação não fazem parte da validação comum.

## Testes e situação do lançamento

Na validação de preparação do repositório, em 25 de outubro de 2026, passaram **846/846 testes Node em 17 suítes**, **156/156 verificações de Grade/interface no Electron com MTP simulado**, **5/5 verificações reais de IPC entre os processos principal e renderizador do Electron**, os lints de JavaScript e estilos e os dois compiladores de produção. Essas verificações são offline; esta tarefa de documentação não realizou operações Android.

As observações físicas anteriores têm limites definidos: navegação, miniaturas selecionadas, exibição progressiva, reutilização do cache e metadados/validação prévia da T11.4. A correção das transferências físicas, a integridade do conteúdo, a execução de sobrescritas e o cancelamento ainda precisam de testes de aceitação. Os resultados deste host não comprovam compatibilidade com versões anteriores do macOS, outros dispositivos ou execução em um Mac Intel.

Consulte o [histórico de alterações](CHANGELOG.md), as [limitações](docs/KNOWN_LIMITATIONS.md), as [notas de lançamento bilíngues em rascunho](docs/RELEASE_NOTES.md) e o [plano de publicação](docs/PUBLICATION_PLAN.md). Publicar o código-fonte e distribuir um aplicativo macOS finalizado têm critérios diferentes, incluindo as licenças dos binários de terceiros e uma identidade de lançamento própria para o fork.

A T14 gerou um aplicativo ARM64 local sem assinatura de distribuição (3.3.0) e verificou a inicialização do explorador compilado em uma cópia com perfil privado e acesso ao dispositivo bloqueado. O pacote contém o CLI Legacy original; o executável de desenvolvimento corrigido não foi incluído. Isso não constitui um instalador público. Consulte o [registro da compilação local e o procedimento futuro com arquivos descartáveis](docs/LOCAL_TEST_BUILD.md).

A T14 autoriza a publicação condicional do código-fonte. A publicação deste histórico Git completo continua bloqueada pela [revisão de procedência e licenças nativas](docs/NATIVE_PROVENANCE.md), pois já existem binários herdados no histórico. Não há alegação de aceitação física de Copiar/Colar, sobrescrita ou cancelamento.

## Créditos e contribuições

O OpenMTP foi criado por **Ganesh Rathinavel**. A [licença MIT](LICENSE) original e os avisos de direitos autorais foram preservados. O MTP Legacy deriva do Android File Transfer for Linux, de Vladimir Menshakov, sob seus próprios termos LGPL; a licença MIT do OpenMTP não altera a licença de componentes nativos ou de recursos gráficos de terceiros.

Os créditos originais completos, as atribuições do logotipo e dos ícones, os links de apoio ao autor original e as pendências de redistribuição estão em [atribuições](docs/ATTRIBUTION.md). O [guia de conexão do projeto original](https://openmtp.ganeshrvel.com/how-to-connect-devices.html) e suas [perguntas frequentes](https://openmtp.ganeshrvel.com/#faq) continuam sendo referências úteis para o aplicativo original.

Leia [CONTRIBUTING.md](CONTRIBUTING.md) antes de enviar uma alteração. Relate problemas deste fork neste repositório e informe o ambiente e o backend com dados sensíveis removidos; não publique listagens pessoais do dispositivo, fotos ou credenciais.

**Idiomas da documentação:** o inglês é o idioma principal. A versão em português brasileiro é mantida em `README.pt-BR.md`; mudanças de funcionalidades, limites de segurança e alegações de lançamento devem atualizar os dois READMEs. Os documentos técnicos detalhados são compartilhados entre os idiomas para evitar especificações duplicadas.
