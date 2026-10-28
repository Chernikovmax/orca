# Этап 8 — contextual conflict resolver

## Статус

Этап 8 завершён на опубликованной базе этапов 1–7, без отката или повторного выполнения этапа 7. Пользователь подтвердил публикацию `60503340e85a532d56791769f6854d32a921c695` в `Chernikovmax/orca`, ветка `improvements/git-workspace-stages-1-7`, и снял прежнюю паузу. Source commit/push, изменение remote или установленного application bundle эта сессия не выполняла. Следующий этап — отдельная сквозная приёмка 9.

## Выполненные требования

- Один resolver в существующем editor для root и host-авторизованных дочерних контекстов; открывается из Changes и выбранного файла existing conflict review. Используются существующие Monaco/editor и `GitContextRef`, не второй status/diff/backend.
- Read-only Base/Ours/Theirs и editable Result; выбор ours/theirs/both для отдельного marker block, Previous/Next conflict. Выбор сохраняет соседний текст, diff3 boundaries и CRLF.
- **Save result** пишет только worktree и возвращает новый host token. **Mark Resolved** отдельно записывает действительный stage-0 index entry или явное удаление. Удаление маркеров само по себе ничего не разрешает. Generic filesystem Save/autosave не обходит resolver.
- Host проверяет checkout authority/identity, HEAD и operation markers, index stages/OID/mode и точные worktree bytes/mode/absence перед записью. Внешняя правка отклоняет stale save; draft не затирается. Explicit Reload показывает актуальное состояние и сохраняет предыдущую несохранённую версию для восстановления.
- Merge/rebase/cherry-pick определяются реальными markers; Continue/Abort выполняют именно обнаруженную операцию и сохраняют unfinished outcome. Rebase labels объясняют stage 2 как upstream плюс уже replayed commits, stage 3 — текущий replayed пользовательский commit.
- Add/add, modify/delete, rename-associated paths, binary/symlink имеют явные side/delete действия. Whole-side choice сохраняет blob bytes и mode; edited result учитывает `.gitattributes` clean/EOL normalization. Rename-associated paths информационные: каждый unmerged index path разрешается отдельно.
- Gitlink показывает оба полных child OID. Можно явно записать reviewed side либо локально проверенный resulting child commit. Реальный UI проверяет создание branch и selected commit в child во время parent conflict, затем запись OID в parent index; невыбранный dirty child file остаётся нетронутым.

## Реализация и контракты

Пути исходников относительно checkout Orca (`orca/` во внешней папке проекта).

- `src/shared/git-workspace-conflict.ts`: конкретные document/content/stage/resolution types. Existing `GitWorkspaceMutationRequest` расширен `content`/`resolution`; receipt содержит `conflict`.
- Existing `git.mutate` / `git:mutate` / preload / runtime forwarding: `readConflict {contextId,filePath}`, `saveConflict {contextId,documentId,content}`, `resolveConflict {contextId,documentId,resolution,childOid?}`. RPC schema обновлена, catalog check прошёл; второй transport не добавлен.
- `git-workspace-conflict-{content,state,read,renames,write}.ts`: bounded offline reads и private documents; общий mutation dispatcher и common-git-dir queue. Existing blob reader расширен byte-exact read вместо второго декодирующего pipeline.
- Host documents: максимум 32, общий retained content budget 64 MiB, TTL 15 минут; displayed content ограничен 8 MiB на сторону. Token не переживает restart/eviction, нужен новый review. Oversized worktree files не перезаписываются по слабому metadata-only fingerprint.
- `GitConflictResolver`, `GitConflictSide`, `GitConflictResolutionActions`, `use-git-conflict-document`, `git-conflict-drafts`: единая поверхность, контекстные drafts, явное сохранение/recovery. Existing `openConflictFile`/`openConflictReviewFile`, Changes и editor surfaces подключены к ней. Existing read-only overview record semantics сохранены.
- `apply-git-conflict-choice.ts` переиспользует существующий marker parser и offset traversal; duplicate parser не создан.
- `editor-autosave`, `editor-save-writer-view`, `editor-save-queue`: resolver-backed/unresolved tabs не могут писать через generic filesystem-save путь. Eligibility переиспользуется, не копируется.

## Проверки и реальные результаты

Финальная смежная регрессия: **27 файлов / 233 теста passed**, Vitest duration **175.05 s**, один worker, без file parallelism. Включены 13 real-Git conflict сценариев, block-choice tests, autosave/save queue/writer/shared-record/race suites, live conflict-review overview, contextual Changes, branch/integration/mutation queue и RPC/runtime sync. Ранний focused прогон — 31 passed в трёх файлах; он входит в последующий набор, результаты не складываются.

13 real-Git сценариев покрывают merge/rebase/cherry-pick save-not-stage → resolve → continue и matching abort; CRLF attributes normalization; stale worktree/index refusal с сохранением unrelated staged/working bytes; binary exact bytes/OID; add/add и modify/delete; rename/delete с original path; traversal/symlink authority; новый resulting child commit в parent gitlink с сохранением dirty child HEAD/index/worktree.

Настоящий hidden Electron: **4 passed одним последовательным прогоном**, 1.6 min:

1. Gitlink: child branch создаётся через popup; только `result.txt` stage/commit через child Changes; родитель остаётся unmerged до explicit OID confirmation; dirty `file.txt`, child index для него и sibling HEAD сохранены; parent merge завершён через UI.
2. Root merge запускается через popup, разрешает два блока, Save не меняет unmerged index, Mark Resolved обновляет index, Continue завершает merge.
3. Nested rebase полностью проходит тот же UI, с правильными side labels и сохранением parent index.
4. Одинаковые root/nested paths сохраняют разные drafts; внешняя root edit отклоняет stale save, explicit Reload/recovery не теряет draft и не меняет nested файл/index.

Сценарии проверяют реальные файлы/index/commit, DOM и отсутствие visible BrowserWindow. Использован существующий isolated HOME/userData harness; focus/show/OS activation не выполнялись.

После последних production changes прошли с exit 0: Node TypeScript, web TypeScript, RPC params catalog `--check`, targeted `oxlint --threads=1` по всем изменённым stage-8 host/shared/renderer/E2E файлам. Formatter — один thread. E2E build прошёл; renderer boot graph **176 chunks / 6062.4 KB minified**. Прежние Vite native-config/chunk/dynamic-import предупреждения и предупреждения CSS optimizer о `::highlight` не выдаются за исправленные product bugs.

## Воспроизведение

Рабочая папка — checkout Orca. Node 24.22.1 взят через cached `npm exec --offline --package=node@24.22.1 -- node`. Тяжёлые процессы выполнялись последовательно с `nice -n 15`, `UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 GOMAXPROCS=1`. Direct Node checks используют `--max-old-space-size=3072`; существующий build wrapper задаёт собственный host-sized child heap limit с максимумом 4096 MiB. Ни индексация, ни явный LSP не запускались; автоматически поднятый language service остановлен.

Основная регрессия:

```sh
node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts \
  --maxWorkers=1 --no-file-parallelism \
  src/main/git/source-control/git-workspace-conflict-real-git.test.ts \
  src/main/git/source-control/git-workspace-branch-real-git.test.ts \
  src/main/git/source-control/git-workspace-branch-units.test.ts \
  src/main/git/source-control/git-mutation-queue.test.ts \
  src/main/runtime/rpc/methods/git.test.ts \
  src/main/runtime/runtime-git-sync-commands.test.ts \
  src/renderer/src/components/editor/apply-git-conflict-choice.test.ts \
  src/renderer/src/components/editor/editor-save*.test.ts \
  src/renderer/src/components/editor/editor-autosave*.test.ts \
  src/renderer/src/components/editor/EditorConflictReviewSurface.live-record.test.tsx \
  src/renderer/src/components/right-sidebar/source-control/panel/workspace-changes.test.tsx
```

E2E build: `VITE_EXPOSE_STORE=true ORCA_BACKGROUND_LAUNCH=1 ORCA_SKIP_DEV_CLI_PREPARE=1 ORCA_SKIP_DEV_ELECTRON_APP_PREPARE=1 node config/scripts/run-electron-vite-build.mjs --mode e2e`. Повторный build использовал `--logLevel error` для краткого вывода, boot graph gate сохранён.

E2E: `node node_modules/@playwright/test/cli.js test --config .cache/stage8-playwright.config.ts --project electron-headless --max-failures=1` с `ORCA_BACKGROUND_LAUNCH=1 ORCA_E2E_HEADLESS=1 ORCA_DISABLE_MACOS_LOGIN_SHELL=1 ORCA_SKIP_DEV_CLI_PREPARE=1 ORCA_SKIP_DEV_ELECTRON_APP_PREPARE=1 PW_TEST_SCREENSHOT_NO_FONTS_READY=1` и `env -u SSH_ASKPASS`. Временный config использует existing `@stablyai/playwright-test` defineConfig: testDir `../tests/e2e`, match `git-workspace-conflicts.spec.ts` и `git-workspace-conflict-gitlink.spec.ts`, timeout 180000, expect timeout 15000, workers 1, retries 0, project electron-headless с metadata `orcaHeadful:false`; без stock global setup/teardown, меняющих global CLI.

## Исправленные отказы при интеграции

- До исправления permanent CRLF regression падал: index содержал `resolved\r\nsecond` вместо `resolved\nsecond`. `hash-object --no-filters` заменён на path-aware hashing; regression прошёл, worktree CRLF сохранён. Семантика опции подтверждена [Git manual](https://git-scm.com/docs/git-hash-object).
- Первый Electron gitlink scenario не открывал editor: старый `toOpenConflictMetadata` guard требовал legacy renderer provenance/kind, отсутствующие у raw contextual catalog entry. Context-authorized unresolved selection теперь открывает host-backed resolver без выдумывания legacy conflict kind; реальные stages проверяет host. После исправления все четыре сценария прошли.
- Typecheck выявил unreachable legacy unresolved decoration после нового resolver branch; obsolete prop удалён. Lint исправлен без suppressions или ослабления правил; reused writer eligibility удерживает save queue в принятом module bound.

## Пределы и координация

Проверены local macOS arm64 и временные реальные Git fixture. Полный repository suite, remote/Windows/WSL runtime и release packaging не запускались; отдельные SSH/WSL/Windows unit paths не объявляются live-host proof. `orca host list` вернул только local, `orca environment list` — пустой список; доступного зарегистрированного remote execution host для последующей live-проверки не найдено.

Side/delete — явное действие пользователя; parent gitlink delete сохраняет child directory. Fences и Git locks не являются атомарной cross-process filesystem transaction. Source credentials/remotes не менялись, hidden fetch/stash/checkout/recursive deletion не добавлены. Partial/unknown outcome не даёт права автоматического повтора.

Host и renderer slices выполнены последовательно одним и тем же Orca worker, затем оба Dispatch завершились `worker_done`. Release renderer Dispatch безопасно оставил user-owned/external terminal (`state: retained`, `reason: external_terminal`, `processAction: none`); активной задачи/правок у worker нет. Координатор владеет проверками и отчётами. PLAN.md, ARCHITECTURE.md и этот отчёт синхронизируются с публикуемыми копиями в checkout. Далее выполняется этап 9, не source commit/push.
