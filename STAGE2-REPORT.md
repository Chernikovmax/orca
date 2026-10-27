# Этап 2 — быстрый popup Git-контекстов и refs

## Результат и границы

В `orca/` продолжены сохранённые незакоммиченные изменения этапов 1–2 после runtime recovery; реализация не переписывалась с нуля. Выполнен только этап 2. Этап 3 и будущие Git mutations, Log и Initialize не запускались; фиктивных команд или no-op handlers для них нет. Commit/push, изменения production app bundle, пользовательского профиля и глобального CLI не выполнялись.

Вход: branch/detached indicator в Source Control либо **Ctrl+Alt+G**, в том числе из Submodules. Две части popup: слева Root и все известные сабмодули, справа refs и Open Changes выбранного контекста. Tree/Flat, collapse/expand, поиск имени/пути, полные относительные пути для одинаковых имён, стабильные цвета, branch/detached OID и clean/dirty/conflicts/uninitialized видны в настоящем renderer.

Recent — **просмотренные refs**, не история checkout. Enter на ref показывает его полный name/OID/upstream, а не переключает ветку. Избранные, recent, ref query и inspected ref сохраняются отдельно по host-issued context ID. Выбор контекста обновляет общую модель Submodules; Open Changes показывает прежний настоящий read-only список файлов этого checkout, не root substitution и не новый diff этапа 3.

## Реализация

- Renderer: `source-control/panel/workspace-popup.tsx`, `workspace-popup-refs.tsx`, `workspace-popup-state.ts`; существующие `branch-context-row.tsx`, `panel-ready.tsx` и right-sidebar keyboard router. Команда открытия — `lib/git-context-popup-command.ts`.
- Общий владелец snapshot/selection/watch/focus refresh — `use-workspace-catalog.ts`. Popup не создаёт второй каталог или backend; refs принадлежат `RepositoryState` того же snapshot. При выборе другого context ID монтируется отдельная refs surface, а ответы старого поколения запроса отменяются/игнорируются.
- `workspaceRefsContextId` расширяет прежние status options, provider options, Electron IPC, preload, renderer local/runtime client и shared runtime params. Он сопоставляется с context ID только после авторизованного discovery; это не произвольный путь и не permission token.
- `git-workspace-refs.ts`: один argv-based `for-each-ref` по heads/remotes/tags выбранного контекста, до 10000 refs; прежние 8 MiB stdout/15 s metadata timeout и offline environment. Никаких fetch/clone/lazy fetch, shell или Git subprocess на hover.
- Навигация: Up/Down по результатам; Enter/Right в refs; Left назад, включая refs search при caret в начале; Tab до остальных native controls; Escape через существующий IME-aware Radix dismiss. Focus переносится в новый keyed subtree после mount, возврат к вызывающему control — если он ещё существует.
- Uninitialized/blocked/error записи остаются в списке с причиной unavailable refs и unknown descendants. Недоступные будущие действия не представлены работающими кнопками.
- Context identity перепроверяется перед использованием прочитанной metadata. При изменении checkout identity недействительный repository state удаляется; при обычном metadata-limit остаётся доступный partial status. Rollup dirty/conflict вынесен без изменения поведения в `git-workspace-status-rollup.ts`, чтобы сохранить 300-line module gate.

## Проверки

Среда: Darwin arm64, Node 24.22.1 через `npm exec --package=node@24.22.1`, existing project-local dependencies, Electron 43.8.1. Все наблюдения относятся к этому checkout, не production Orca.

| Проверка | Фактический результат |
|---|---|
| Focused Vitest, 8 файлов после интеграции и extraction | 139 passed / 8 files |
| Native TypeScript: node и web configs, `--noEmit --composite false` | exit 0 |
| Targeted oxlint на stage-2 source/types/transport и Electron spec | exit 0 |
| `generate-rpc-params-catalog.mjs --check` | exit 0 |
| Electron-vite `--mode e2e`, exposed store, CLI setup skipped | exit 0; 176 renderer boot chunks / 6058.2 KB minified |
| Настоящий Electron: popup + прежний catalog + golden Monaco diff | Интегрированный прогон: 3 passed / 28.2 s; после окончательной правки timing probe — popup 3/3 passed / 42.3 s; catalog и golden diff также прошли каждый ×3 на финальной source-сборке |

Vitest owners: `src/main/git/source-control/git-workspace-status-real-git.test.ts`, `src/main/git/status-submodule.test.ts`, `status-submodule-path-cache.test.ts`, `src/main/runtime/rpc/methods/git.test.ts`, `src/main/ipc/worktree-base-directory-watcher.test.ts`, `worktree-git-status-ref-watch.test.ts`, `filesystem-git-status-staging.test.ts`, `src/cli/handlers/file.test.ts`.

Новый real-Git regression проверяет, что одинаковые names root/nested не объединяются, heads/remotes/tags читаются только для requested authorized context, произвольная path-like identity не выдаёт refs, и соседние repository states не получают чужой ref catalog. Не добавлялись mocked echo/source-text tests.

### Настоящий Electron journey

`tests/e2e/git-workspace-popup.spec.ts` использует реальный fixture `createGitWorkspaceFixture`, local Git и существующий `helpers/orca-app.ts` с disposable HOME/userData и process-scoped shutdown. Fixture содержит root, `one`, nested `one/same`, clean `two`, а также отдельный linked worktree; `one` и `one/same` имеют одинаковое имя `same`. В четырёх контекстах создаются одинаковая `shared-name`, tag `release-popup` и offline remote-tracking ref; только root имеет `root-only`, только nested — `nested-only`. Root получает `only-root.txt`, nested — `only-nested.txt`.

Проверены потребительские сценарии:

1. Настоящее открытие из branch indicator, clean context виден, root/nested и одинаковые имена различимы по пути.
2. Поиск `one/same` → ArrowDown → Enter → focus нового refs search; root-only refs не появляются в выбранном nested context, включая начало загрузки.
3. Contextual search local/remote/tag, Enter-инспекция ref, Recent и favorites; root не получает nested recent/favorite/query, nested восстанавливает свои значения при возврате и повторном открытии popup.
4. Left возвращает repository search; Escape закрывает и возвращает DOM focus к branch indicator, Enter снова открывает popup. Tree/Flat и collapse/expand реально скрывают/возвращают вложенную строку; hover не выбирает другой контекст.
5. Open Changes показывает **`Changes · one/same`** и **`only-nested.txt`**, но не `only-root.txt`.
6. До/после просмотра совпадают реальные HEAD, все refs, index (`ls-files --stage`) и status всех четырёх checkout. Это проверка отсутствия Git mutations, не проверка числа mocked вызовов.
7. Ctrl+Alt+G повторно открывает popup; внешний checkout `one` обновляет строку, внешний detached checkout `two` показывает detached, настоящий merge conflict показывает conflicts.
8. Внешний deinit nested сохраняет uninitialized строку; refs search disabled, unknown descendants объяснены, ложных Open Changes/Initialize нет.
9. `BrowserWindow.isVisible()` остаётся false; screenshots сняты через hidden renderer и просмотрены.

Соседние постоянные `git-workspace-catalog.spec.ts` и `golden-source-control-open-diff.spec.ts` проходят: recursive catalog/worktree isolation и существующий реальный Monaco original/modified путь сохранены.

Снимки: `orca/.cache/stage2-popup-refs.png` (refs, Recent/favorite, identical names/paths и conflict sibling) и `orca/.cache/stage2-popup.png` (uninitialized nested). На втором снимке допустим дополнительный watcher refresh; DOM assertions проверяют требуемые состояния независимо от снимка.

## Первый baseline новой поверхности

До этапа 2 popup отсутствовал: сравнение с выдуманным pre-feature latency не выполнялось. Измеряется **первое открытие нового popup в новом Electron profile** после `waitForSessionReady` → repo add → `openGoldenSourceControl` → click branch indicator, без предварительного чтения refs через popup. Automatic catalog refresh уже инициирован, но его завершение перед click отдельно не ожидается. Это не cold OS-cache, не production benchmark и не p95.

Воспроизведение — та же fixture и `git-workspace-popup.spec.ts`. В renderer перед click branch indicator устанавливается observer; click отмечается `performance.mark`. Отдельные `performance.measure` фиксируют DOM readiness popup shell и реального `root-only` в Local refs непосредственно в MutationObserver. Это разные измерения без driver/locator polling time, **не paint/animation latency**; факт видимого renderer проверяется отдельно DOM assertions/screenshots. Значения печатаются как `STAGE2_POPUP_BASELINE` и прикладываются JSON к Playwright result.

| Метрика | Samples в трёх новых profiles, ms | Median, ms | Max, ms | Бюджет той же fixture, ms |
|---|---|---:|---:|---:|
| Click → popup shell DOM ready | 18.8 / 19.5 / 19.4 | 19.4 | 19.5 | 250 |
| Click → root refs DOM ready | 1167.1 / 1210.3 / 2074.2 | 1210.3 | 2074.2 | 3000 |

Бюджеты относятся к той же локальной fixture с четырьмя контекстами; не обещают такую latency при 128 контекстах/10000 refs или на remote host. Shell не ждёт чтения refs; выбранный context может перечитать общий bounded snapshot.

Это финальный repeat-each=3 с delegated document capture listener на click: listener не теряется при remount branch indicator между установкой probe и Playwright click. Все три полных popup journey прошли; это три first-opens в трёх новых Electron profiles, не warm reopen одного popup. Бюджеты предложены по измеренному новому baseline с запасом; они не названы ранее действовавшими SLA.

## Воспроизведение безопасных проверок

Build:

```sh
env VITE_EXPOSE_STORE=true ORCA_SKIP_DEV_CLI_PREPARE=1 ORCA_SKIP_DEV_ELECTRON_APP_PREPARE=1 \
  npm exec --yes --package=node@24.22.1 -- node config/scripts/run-electron-vite-build.mjs --mode e2e
```

Для smoke использован временный `.cache/stage2-playwright.config.ts`: `testDir: '../tests/e2e'`, только popup/catalog/golden-diff specs, один worker, project `electron-headless` с `metadata: { orcaHeadful: false }`, timeout 120000; **без stock globalSetup/globalTeardown**, способных устанавливать global CLI. Команда:

```sh
env ORCA_BACKGROUND_LAUNCH=1 ORCA_E2E_HEADLESS=1 ORCA_DISABLE_MACOS_LOGIN_SHELL=1 \
  ORCA_SKIP_DEV_CLI_PREPARE=1 ORCA_SKIP_DEV_ELECTRON_APP_PREPARE=1 \
  npm exec --yes --package=node@24.22.1 -- node node_modules/@playwright/test/cli.js test \
  --config .cache/stage2-playwright.config.ts --project electron-headless
```

Переносы в примерах — продолжение одной команды; значения environment только process-local. Постоянный spec совместим с repository harness; disposable Git dirs удаляются после shutdown собственного Electron. Никаких `killall`, `pkill`, остановки чужих Electron, `orca open`, production profile writes или установки global CLI не выполнялось. Временные smoke config и диагностический probe удаляются после проверки; screenshots/result artifacts сохраняются как доказательство.

## Найденные и исправленные регрессии

- Сохранённый popup воспроизводимо терял focus при Enter в другой context: refs input фокусировался до замены keyed subtree. Исправлен перенос после mount; этот реальный keyboard journey сначала упал, затем прошёл.
- ArrowDown из refs search выбирал Open Changes вместо первого ref; навигация учитывает позицию search относительно команды и результатов.
- Во время внешнего deinit Git мог начать читать уже авторизованный child, затем обнаружить ancestor после удаления `.git`; в UI наблюдались branch родителя и лишняя `one/same/./` metadata строка. Добавлены marker/identity revalidation и удаление недействительного repository state. Повторный настоящий deinit journey прошёл без ослабления ожидания 12 s.
- При перестановке publication после metadata потерялся partial root status на oversized metadata. Existing real-Git regression поймал ошибку; публикация partial status сохранена, а удаляются только invalid/unavailable identities. Финальный regression suite — 139 passed.
- Lint выявил preserved compact one-line blocks и module-size gate; применены repository braces/format и разделение refs UI/rollup без переписывания backend. LSP references сначала timeout, затем server exited; typechecks/runtime tests использованы как исполнимое доказательство, LSP results не выдаются за выполненный reference audit.
- Вариант timing probe с listener на конкретном branch DOM node был нестабилен при remount индикатора: сначала 8 passed / 1 missing-timing failure в девяти проверках, затем 1 passed / 2 missing-entry failures в отдельных popup-повторах. Probe переведён на delegated document capture listener; после этого 3/3 полных journey прошли. RAF заменён MutationObserver DOM readiness, поэтому paint/animation latency не заявляется; ранние RAF samples не смешиваются с итоговой таблицей.

## Ограничения проверки

Проверен локальный Darwin/Electron и реальный Git. Настоящие SSH/WSL/Windows execution hosts, mobile/native back gesture, release package, visible-window/native OS focus и большой ref/submodule стресс не запускались. Существующие authorization/host routing/argv conventions сохранены, но локальный smoke не доказывает remote/platform acceptance. Нет сравнения с несуществующим pre-feature popup; этап 3 не реализован.

## Modern Web Guidance

- **`accessibility`**: Я сохранил native buttons/inputs, явные accessible names, regions и focus indicators вместо псевдоинтерактивных div: “Always prioritize native `<button>` or `<input>` elements for standard interactions”. Существующий Radix dialog обеспечивает focus containment и IME-aware Escape; возврат focus адаптирован для программного вызова без Dialog.Trigger.
- **`spatial-navigation`**: Я ограничил directional handlers двумя pane-виджетами и скроллю найденный focus target через `scrollIntoView({ block: 'nearest' })`; при отсутствии следующего результата default не подавляется: “If there is no focusable element in the pressed direction, **do not prevent default browser behavior**”. Native Left/Right editing сохраняется в text inputs, кроме явного возврата на левой границе refs search.

`platform-controls-dismiss-dialog` проверен; native `closedby` не применялся, поскольку здесь используется существующий Radix primitive, а mobile platform back не объявляется проверенным. Актуальные Radix focus APIs сверены через Context7, без изменения используемой библиотечной версии.
