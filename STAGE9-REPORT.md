# Этап 9 — сквозная приёмка и готовность исходников к публикации

## Результат и область проверки

Этапы 8–9 завершены. Финальные измерения соответствуют неизменённым бюджетам этапа 0; функциональные сценарии, выбранная регрессия и статические проверки завершились успешно. Это локальная приёмка исходников на macOS arm64, не утверждение о проверке всех платформ или release package.

Исходная опубликованная точка этапов 1–7 — подтверждённый пользователем `60503340e85a532d56791769f6854d32a921c695`, fork `https://github.com/Chernikovmax/orca`, ветка `improvements/git-workspace-stages-1-7`. До завершения приёмки сессия не коммитила и не публиковала изменения исходного репозитория; Git commit/push в проверках выполнялись только во временных fixture/local bare remotes. Затем пользователь отдельно разрешил публикацию готовых этапов 8–9 указанием «коммить, пушь».

Проверки выполнялись последовательно: один Orca worker либо одна тяжёлая проверка, `nice -n 15`, Vitest/Playwright worker 1, `UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 GOMAXPROCS=1`. Прямые Node-команды использовали Node 24.22.1 и heap limit 3072 MiB; build wrapper самостоятельно выбирает heap дочерних процессов вплоть до 4096 MiB. Индексация не запускалась, LSP-запросов не было; автоматически поднятый language service остановлен. Окна тестового Electron оставались скрытыми.

## Исправленные отказы

1. **Hardlink за пределы checkout.** Real-Git regression до исправления доказал, что Save result перезаписывал внешний файл через общий inode. `git-workspace-conflict-write.ts` теперь отказывает при `nlink > 1` до truncate. Внешние bytes сохраняются; symlink-side replacement по-прежнему не следует за target.
2. **Повторный конфликт того же пути.** Первый merge завершался, но повторное открытие показывало старый stage OID. Сценарий воспроизведён в настоящем Electron. При повторном открытии resolved draft читаются новые stages; inactive clean draft без recovery-версий освобождается. Unsaved/recovery-данные не выбрасываются.
3. **Ложный clean у здорового корня.** Обычный porcelain падал на повреждённом соседнем `.git`, а прежний catch превращал результат в пустой status. В ошибочном пути используется тот же безопасный workspace reader: реальные root changes сохраняются, ошибки discovery остаются явными. Второй status backend не добавлен.
4. **Чужая incomplete-ошибка блокировала commit.** Preview/write и HEAD fence теперь требуют полноты выбранного repository, а не отсутствия всех ошибок соседей. Проверены реальный child preview/commit, неизменность parent HEAD/refs/index и работа root/child draft UI рядом с blocked sibling. Собственная incomplete-снимка, lifecycle и dependency-batch ограничения не ослаблены.
5. **Неявная рекурсия checkout.** При `submodule.recurse=true` root checkout реально менял child HEAD/index и переводил его в detached HEAD. Общий Checkout/New Branch executor переопределяет `submodule.recurse=false`; regression проверяет сохранность всех невыбранных child checkouts.
6. **Длинный popup выходил за modal.** Unfiltered 129-row probe не мог дойти до строки 17; постоянный 36-row regression до исправления получил viewport ratio 0. Исправлены grid track `minmax(0,1fr)`, shrink constraints и собственный scroll списка, без маскировки `overflow:hidden`. Последний контекст доступен pointer/keyboard.
7. **Лишняя работа uncached diff.** Удалён неиспользуемый status/upstream probe для unstaged; обычный blob читается одним bounded capture без отдельного `cat-file -s`; отсутствующий `.gitmodules` не запускает config subprocess. Малые fingerprints не выделяют по 256 KiB на каждый файл. Pre-patch content fence отдаёт те же index records для displayed base, исключая повторный `ls-files`. Git patch всё ещё сопровождается полной fresh HEAD/index/content проверкой после чтения. Two-second racy cache exclusion не менялся.

Добавлены проверки ровно 8 MiB и 8 MiB + 1 byte, а также детерминированный real-Git race: внешний writer меняет index во время настоящего blob read; документ становится stale, writable token не выдаётся, внешние staged/worktree bytes сохраняются.

## Фактическая регрессия и статические проверки

- Основной окончательный последовательный Vitest: **524 passed / 46 файлов**, duration **543.55 s**, после последнего production-изменения.
- Дополнительные cache/stamp/bounds проверки: **49 passed / 7 файлов**, duration **11.40 s**. Вместе это **573 passed / 53 различных файла двумя прогонами**, не один полный repository suite.
- Исправленный type-safe commit-preview test отдельно повторён: **1 passed / 14 skipped**, duration **6.23 s**; это повтор одного из 524, не дополнительный уникальный тест.
- Первоначальная цепочка после 524 passed остановилась на TypeScript union narrowing в новом test (`preview.staged`). Добавлен проверяемый `in` guard без cast; окончательные Node/Web TypeScript, RPC catalog `--check` и targeted `oxlint --threads=1` завершились **exit 0**. Окончательная дополнительная цепочка заняла **186.49 s**.
- Старые submodule-cache mock echoes и assertions о forwarding/call counts заменены шестью проверками реальных filesystem metadata/Git parsing: TTL, eviction/LRU, in-flight invalidation, missing-file recovery, runtime-key isolation и реальное переключение branch. Для управляемых clock/barrier cache-тест использует native-Git adapter вместо process-host transport; транспорт отдельно покрыт основным набором.
- Последний E2E build: **176 chunks / 6062.4 KB minified**, exit 0. После него production source не менялся; последующие изменения касались только tests/docs.

Основной набор включает lifecycle/batch/status/diff/mutation/history/branch/conflict/queue real-Git tests, RPC/runtime/execution-host ownership, provider/IPC/watchers, renderer client/panel/editor save/autosave/conflict flow и прежние CLI file handlers. Полный набор репозитория не запускался. Ранее известная baseline corrupt-index проблема `blob-absence-real-git.test.ts` повторно не проверялась и не объявлена исправленной.

## Настоящий скрытый Electron

| Последовательная группа | Passed | Область |
|---|---:|---|
| Выбранные этапы 1–7 | 14 | Branches/remotes/integration, catalog/diff/log/mutation/popup, maintenance/batch и golden Monaco |
| Этап 8 | 4 | Root merge, nested rebase, stale drafts, child result commit → parent gitlink |
| Новый recovery | 1 | Отказ watch subscription и dropped notifications, root/child drafts, healthy preview рядом с blocked sibling, focus reconciliation и возврат keyboard focus |
| Popup после исправления | 2 | Прежняя navigation плюс новый длинный список; первый сценарий повторяет один из 14 |
| Полный unfiltered scale | 1 | 129 строк, hover, paginated/windowed history, реальные Git fingerprints |
| Финальный performance | 2 | 100 / 10000 дополнительных tracked файлов, IPC/Monaco/working sets |
| Финальный CLI smoke | 1 | Реальные source handlers → RuntimeClient socket → Monaco |
| Mutation на последнем producer | 1 | Root/child partial stage и остальной реальный mutation flow; повтор одного из 14 |

Это несколько последовательных групп, не утверждение, что все сценарии заново прошли одной командой на последнем build. Первые functional группы предшествовали последним host micro-optimizations; финальные IPC/fresh-host/CLI и mutation повторены после exact-index fence reuse. Conflict/cache/transport поведение затем покрыто окончательными 573 тестами.

Recovery сначала действительно падал: root commit textbox отсутствовал, хотя contextual Root показывал Staged (1). После owner repair неизменённый сценарий прошёл за 10.9 s. Focus здесь — синтетическое DOM-событие/hidden-renderer keyboard, не native OS activation; desktop focus не захватывался.

CLI smoke вызывает текущие `FILE_HANDLERS['file diff']` для unstaged/staged и `file open-changed --mode=diff` с настоящим `RuntimeClient` из изолированного профиля. Проверены три настоящие Monaco пары, в том числе различие index и отдельного worktree содержимого, неизменность HEAD/refs/status, semantic и SHA-256 raw index, файловых bytes. Это не запуск packaged/parsed CLI executable и не smoke установленного production bundle.

## Финальная производительность

Та же методика stage-0 Electron fixture: шестифайловый seed плюс 100 либо 10000 однострочных tracked файлов; после fixture commit меняется только `src/index.ts`. Пять status/diff IPC после automatic refresh, затем первое отображение Monaco и `app.getAppMetrics()`. Нет дополнительного ожидания cache aging, сброса OS cache или подмены budget. Warm означает работающий app/IPC, а не гарантированный settled blob-cache hit.

| Метрика | +100 файлов | +10000 файлов | Неизменённый предел |
|---|---:|---:|---|
| Warm status median, n=5, ms | 34.60 | 46.20 | 100 / 500 |
| Diff IPC median, n=5, ms | 68.60 | 54.50 | 75 |
| Первое проверенное Monaco, ms | 1392.50 | 1404.60 | 1500 |
| Renderer working set, MiB | 466.09 | 467.67 | 600 |
| Сумма app working sets, MiB | 1017.86 | 1021.77 | 1200 |
| Fresh-process host status, n=1, ms | 81.07 | 106.41 | 150 / 250 |
| Fresh-process host diff, n=1, ms | 55.20 | 66.18 | 75 |

Raw final samples, ms:

```json
{
  "additional100": {
    "status": [30.2, 30.7, 35.6, 34.6, 39.3],
    "diff": [65.9, 72.7, 59.1, 69.3, 68.6]
  },
  "additional10000": {
    "status": [48.1, 46.1, 46.1, 46.2, 46.3],
    "diff": [54.5, 53.8, 61.1, 52.7, 55.1]
  }
}
```

Fresh-host — два отдельных Node процесса после module imports и закрытия Electron, на **тех же** двух datasets последнего IPC-прогона. Это не cold disk, не cold IPC и не статистический p95. Stage-0 отдельная host fixture описана в ARCHITECTURE.md; её отличие от шестифайлового Electron seed не скрывается.

Working sets — моментный OS показатель, не peak/JS heap и не уникальная физическая память; сумма может повторно учитывать shared pages. `document.visibilityState: visible` в raw JSON обусловлено hidden paint policy Electron; `BrowserWindow.isVisible()` оставался false.

### Сохранённые неуспешные измерения

| Producer до следующего исправления | IPC median +100, ms | IPC median +10000, ms | Fresh host diff +100, ms | Fresh host diff +10000, ms |
|---|---:|---:|---:|---:|
| Исходный stage-9 замер | 88.10 | 99.20 | 99.03 | 110.85 |
| Без неиспользуемого status | 78.10 | 76.70 | 86.31 | 82.02 |
| После bounded blob capture | 75.70 | 67.20 | 70.70 | 64.62 |
| После size-aware buffers | 79.00 | 69.10 | 83.03 | 68.25 |

75.70 не округлялось в успешные 75. Между попытками менялся producer; повторов неизменённого кода ради зелёного результата не было. Межпрогонная вариация не объявлена причинной регрессией отдельного изменения.

Диагностический aged-document probe дал 14 Git starts / 147.30 ms для первого uncached чтения и 0 starts / 0.339 ms для immediate repeat; это **не** замена baseline. Сопоставление исходного Trace2 с неизменённым worktree mtime показало, что исходные n=5 попали в 2-second racy exclusion: ordinary 857–1313 ms, large 943–1526 ms. Первоначальный расчёт по post-run index mtime давал отрицательные ages и был отвергнут как доказательство. Кэш не ослаблялся ради измерения.

## Масштаб, on-demand чтение и границы кэшей

Полный scale fixture: 126 дополнительных metadata gitlinks плюс два исходных; это не 128 клонированных репозиториев. Каталог вернул 3 repository contexts, 128 submodule entries: 2 initialized, 126 uninitialized, один limited descendant и явную incomplete/limit ошибку. Popup содержит 129 строк вместе с Root.

В измеренном ~1 s idle — 0 Git starts; для 25 реальных hover в полном списке — 0 Git starts. App-only Trace2 не содержит fetch/clone/push/checkout/reset/stash/commit/update-index при browsing; fixture setup и внешние fingerprints в trace не включены. HEAD/refs/semantic+raw index/status root и здоровых children до/после совпали.

История из 323 настоящих commit прошла 7 страниц, в DOM оставались 43–44 строки; keyboard End дошёл до `initial`. Popup ready занял 619.58 ms, первая история 1423.43 ms; следующие страницы `[1340.20, 832.31, 826.65, 832.77, 833.75, 827.99]` ms. Эти n=1 page timings не названы p95 или cold-first.

Первый scale pass оставил фильтр Root и фактически hover-ил одну строку: он не использован как large-hover proof. После очистки фильтра следующий запуск выявил настоящее clipping; после исправления подтверждён полный сценарий.

Проверены существующие cache bounds: settled diff — 32 entries, 1,000,000 characters per result и 8,000,000 retained characters total, с fresh stamp/generation proof, не TTL stale window. Submodule path cache — 512 entries/5 s; concurrency, eviction и invalidation проверены. Host conflict documents ограничены 32/64 MiB/15 min; private selection registry — 128. Unsaved renderer drafts/recovery versions являются рабочими пользовательскими данными, а не автоматически выкидываемым clean cache.

## Матрица приёмки плана

| Сценарий | Фактическое подтверждение |
|---|---|
| Ежедневный root/child цикл | Настоящий mutation UI и финальный повтор partial-stage; real-Git index/commit содержат выбранные изменения, остальные сохранены |
| Leaf → parent → root → publication/clone | Batch real-Git сценарии публикации и чистого clone; UI leaf-to-root commit с отдельными exact-OID подтверждениями |
| Конкурентный writer | Stale partial selection, external refresh и новый index-during-blob race без выдачи writable token |
| Uninitialized дерево | Maintenance UI initialize/recurse и bounded scale с явными unknown/limited потомками |
| Dirty/unpublished ограничения | Lifecycle/branch real-Git отказы, data-preserving remove, отсутствие force/stash |
| Частичная/неизвестная сеть | Настоящий loopback HTTP interrupted push и batch inspect/reconcile без слепого retry; не SSH/live remote proof |
| Текстовые/gitlink конфликты | Root merge, nested rebase, stale drafts, app-created child branch/commit → parent gitlink, dirty child files сохранены |
| Изоляция worktree/контекстов | Branch occupied elsewhere, catalog isolation, root/child drafts и проверки выбранного checkout/индекса |

Нет второго status/diff backend: переиспользуются прежние runner, `getStatus`/workspace reader, `getDiff`/document reader, IPC/RPC/preload и editor. Schema/catalog и Node/Web типы проверены; прежние CLI source handlers проверены настоящим socket/UI циклом.

## Воспроизведение и локальные evidence artifacts

Рабочая директория команд — checkout `orca/`. Общий префикс Node:

```sh
nice -n 15 env UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 GOMAXPROCS=1 \
  npm exec --offline --package=node@24.22.1 -- node --max-old-space-size=3072
```

Основной Vitest использовал `env -u SSH_ASKPASS`, `node_modules/vitest/vitest.mjs run --config config/vitest.config.ts --maxWorkers=1 --no-file-parallelism` и:

```text
src/main/git/source-control/git-workspace-{submodule,batch,status,mutation,history,branch,conflict}-real-git.test.ts
src/main/git/source-control/git-diff-document-real-git.test.ts
src/main/git/source-control/git-workspace-branch-units.test.ts
src/main/git/source-control/git-mutation-queue.test.ts
src/main/git/source-control/drive-checkout-suspect-status.test.ts
src/main/runtime/rpc/methods/git.test.ts
src/main/runtime/{runtime-git-sync-commands,orca-runtime-git,runtime-git-target-execution-host,runtime-git-execution-host-ownership,runtime-git-conflict-operation-routing}.test.ts
src/main/providers/local-git-provider.test.ts
src/main/ipc/{filesystem-git-status-staging,worktree-git-status-ref-watch}.test.ts
src/renderer/src/runtime/runtime-git-client.test.ts
src/renderer/src/components/right-sidebar/source-control/panel/*.test.*
src/renderer/src/components/editor/apply-git-conflict-choice.test.ts
src/renderer/src/components/editor/editor-save*.test.ts
src/renderer/src/components/editor/editor-autosave*.test.ts
src/renderer/src/components/editor/EditorConflictReviewSurface.live-record.test.tsx
src/cli/handlers/file{,-absolute-paths}.test.ts
```

Дополнительные 7 файлов: `src/main/git/{status-submodule-path-cache,status-diff-settled-cache,settled-diff-cache-bounds,worktree-diff-stamp-host-paths,worktree-diff-stamp-guest-gitdir,status-upstream-negative-cache}.test.ts` и `src/shared/bounded-map.test.ts`.

Статика: `node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.node.json --composite false`, затем аналогично `config/tsconfig.web.json`, `config/scripts/generate-rpc-params-catalog.mjs --check`, targeted `node_modules/.bin/oxlint --threads=1` для изменённых conflict/mutation/branch/status/diff/fence/cache/UI/E2E файлов.

Build: `VITE_EXPOSE_STORE=true ORCA_BACKGROUND_LAUNCH=1 ORCA_SKIP_DEV_CLI_PREPARE=1 ORCA_SKIP_DEV_ELECTRON_APP_PREPARE=1 node config/scripts/run-electron-vite-build.mjs --mode e2e --logLevel error`. Vite native-loader и CSS `::highlight` warnings остались предупреждениями, не подавлялись изменением правил.

E2E использовал `@stablyai/playwright-test` config с `testDir: '../tests/e2e'`, timeout 180000, expect timeout 15000, workers 1, retries 0, project `electron-headless` с `metadata: {orcaHeadful:false}`, без stock global setup/teardown и установки глобального CLI. Запуск — `node node_modules/@playwright/test/cli.js test <перечисленные spec> --config .cache/stage9-playwright.config.ts --project electron-headless --workers=1`, с `ORCA_BACKGROUND_LAUNCH=1 ORCA_E2E_HEADLESS=1`.

Измерительная recipe приведена выше, permanent specs сохранены. Временные spec/config/diagnostic scripts после проверки удалены: исторические `.cache/stage9-*.ts` команды не предлагаются как существующие runnable файлы. Raw JSON/logs/Trace2/screenshots и неизменяемые snapshots попыток оставлены в ignored `.cache/`, не являются публикуемыми исходниками. Основной evidence — `.cache/stage9-measurements.json`; фактические JSON reporter paths — `.cache/.cache/stage9-*-report.json` (relative config resolution), не `.cache/stage9-*-report.json`.

Evidence aggregation сначала отказалась исполнять top-level await в disposable `.ts`/CommonJS; переименование в `.mts` исправило только diagnostic script, без нового Electron run. Первый formatter вызов worker с одними env limits сообщил 14 threads за 7 ms; исправленный явный `--threads=1` и последующие formatter/linter запуски использовали один thread. Это исключение не скрывается за утверждением, что все команды изначально были single-thread.

## Ограничения, очистка и завершение worker

- `orca host list` показывал только local, `orca environment list` — пустой список. Доступного зарегистрированного supported remote execution host нет. Live SSH/WSL/Windows/Linux/mobile runtime, внешний credential-bearing remote и release packaging не проверялись; unit routing и loopback HTTP не выдаются за них.
- Native visible-window/focus тесты не запускались на desktop пользователя. Проверен скрытый Electron/CDP surface и его собственная OS-window visibility.
- Fences/Git locks обнаруживают изменения, но не являются cross-process filesystem transaction. Multi-repository publish — последовательный dependency workflow, не атомарная транзакция.
- Удалены все 23 записанные retained fixture directories, включая secondary worktrees; проверка после удаления вернула `remaining: []`. Удалены 11 временных probe/config/helper scripts. Чужие caches/profiles/`.omp` и исходный репозиторий очистка не затрагивала.
- Worker `ctx_2410eff4b11f` прислал успешный `worker_done`, прямо подтвердив отсутствие оставшихся правок/проверок. Release безопасно вернул `retained / external_terminal / processAction:none`; user-owned terminal не закрывался. Ledger: reclaimable workers отсутствуют, 3 исторических Dispatch retained; активной изменяющей задачи у worker нет.
- PLAN.md, ARCHITECTURE.md, STAGE8-REPORT.md и этот отчёт имеют публикуемые копии в `orca/`. После завершения проверок пользователь отдельно разрешил source commit/push готовых stages 8–9 в текущую ветку форка; кэши, профили и `.omp` не публикуются.
