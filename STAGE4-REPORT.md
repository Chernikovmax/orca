# Этап 4 — Stage/unstage, commit и безопасный discard

## Результат

В `orca/` реализован только этап 4 поверх сохранённых изменений этапов 1–3. Source Control корня и инициализированного дочернего checkout выполняет реальные stage/unstage файлов, hunks и выбранных строк, commit настоящего index и discard с preview/подтверждением/восстановимой копией. Все записи идут через один host-сервис `mutateGitWorkspace`, один транспорт `git.mutate`/`git:mutate` и одну очередь по common git-dir; произвольный patch из renderer не принимается. Production bundle, глобальный CLI и пользовательский профиль не менялись, этапы 5–9 не начинались.

## Контракт

- **Selection IDs.** Host при чтении diff выдаёт `documentId`, `hunkIds` и `lineIds` и хранит строки исходного diff в bounded registry (128 документов). Renderer возвращает только эти идентификаторы; host сам строит patch и применяет его к index через приватный файл (byte-exact, без stdin-кодирования).
- **Гранулярность.** Чистые addition/delete-блоки поддержаны по строкам. Замена (строка + её новая строка) и любой блок с отсутствующим final newline перемещаются вместе: иначе получилась бы дублированная строка или невозможная граница newline. Rename, binary, >8 MiB, non-UTF-8, symlink, mode-only и unmerged изменения получают `partialUnavailable` и сохраняют файловые операции. Для rename файловые stage/unstage действуют на оба пути.
- **Freshness.** Перед записью host заново авторизует контекст, проверяет `expectedState` (HEAD/index/status, включая index records) и content fence: HEAD, index-записи пути и байты worktree (файлы >16 MiB — filesystem identity вместо полного хэша). Несовпадение — категоризированный отказ без записи; UI перечитывает фактическое состояние и не переносит старый выбор на похожий фрагмент.
- **Очередь.** Все Orca-записи (`stageFile`, `unstageFile`, bulk stage/unstage, `discardChanges`, `bulkDiscardChanges`, `commitChanges`) выполняются в `withGitMutationQueue`, ключ — execution host process + common git-dir. Linked worktrees одного репозитория сериализуются. Внешние агенты не блокируются; Git locks и fences обнаруживают конфликт. Транзакция над checkout не обещается.
- **Commit.** Preview перечисляет реальный staged-набор, unborn/detached/branch и отказывает при усечённом listing. Commit запускает `git commit -m` без `--no-verify` и без отключения signing. Hook/signing ошибка возвращает текст Git и свежий `expectedState`; hook, изменивший index, виден в коммите. Отмена/обрыв после старта процесса — `outcome: 'unknown'`, автоматического повтора нет.
- **Discard.** Только unstaged изменения tracked regular files. Preview возвращает host token; discard требует его, пишет копию и manifest в `<gitDir>/orca-recovery` (fsync) до перезаписи и отказывается, если копию сохранить нельзя. Untracked новым путём не удаляются. `restoreDiscard` возвращает копию только пока файл совпадает с post-discard fence; `listRecoveries` показывает доступные копии по контексту.
- **Gitlink.** `stageGitlink` проверяет полный child OID, child HEAD, авторизованный child context и parent index, затем `update-index --add --cacheinfo 160000,<oid>,<path>` и перечитывает запись. Child checkout/index/HEAD не изменяются; parent commit не коммитит child.
- **Черновики.** Дочерние контексты имеют отдельный commit-surface и черновик сообщения, сохраняемый по host-issued context ID (localStorage с in-memory fallback). Root сохраняет существующую commit-surface и per-worktree draft.
- **Совместимость.** `git.stage`, `git.unstage`, `git.commit`, bulk-маршруты IPC/RPC/preload/CLI сохранены и разделяют очередь и низкоуровневые примитивы. UI Source Control использует `git.mutate`; `discardRuntimeGitPath` без preview сохраняет прежний контракт для старых вызовов. Второй backend/транспорт не добавлялся.

## Затронутые файлы (основное)

Добавлено: `src/shared/git-workspace-mutation.ts` (переписан), `src/main/git/source-control/git-{diff-path,content-fence,mutation-queue,workspace-mutation-error,workspace-mutation,workspace-mutation-shared,workspace-mutation-discard,workspace-mutation-recovery,workspace-mutation-commit,workspace-mutation-gitlink,selection-patch,selection-patch-text,selection-patch-types,selection-patch-build}.ts`, renderer `panel/{use-workspace-mutations.ts,workspace-changes-list.tsx,workspace-commit-drafts.ts,workspace-changes.test.tsx}`, тесты `git-workspace-mutation-real-git.test.ts`, `git-mutation-queue.test.ts`, E2E `tests/e2e/git-workspace-mutation.spec.ts`.

Изменено: `git-diff-document.ts`, `git-diff-document-read.ts`, `staging.ts`, `discard-changes.ts`, `commit-changes.ts`, `git-workspace-{status,types}.ts`, RPC params/catalog, `runtime-git-staging-commands.ts`, `orca-runtime-git.ts`, `runtime-git-command-surface.ts`, `filesystem-git-index-handlers.ts`, preload API/bridge и web-preload, renderer runtime-клиенты, `GitDiffDocumentSurface.tsx`, `workspace-changes.tsx`, `use-workspace-catalog.ts`, `panel-ready.tsx`, `workspace-catalog.tsx`, `CHANGELOG.md`, `docs/reference/git-workflow.md`.

Удалены устаревшие тесты старого списка Source Control, которые перестали соответствовать поверхности ещё после этапов 2–3 и падали на отсутствующих DOM-строках: `SourceControl.preview-open.test.tsx`, `SourceControl.open-file-highlight.test.tsx`, `SourceControl.virtual-file-list.test.tsx`. Их пользовательские сценарии открытия/мутаций заменены новыми тестами `workspace-changes.test.tsx` и Electron-сценарием.

## Выполненные проверки

Среда: Darwin arm64, checkout `/Users/chernikovmax/orca/projects/light/orca`, Node 24.22.1 через process-local `npm exec --package=node@24.22.1`, Electron 43.8.1. Глобальный CLI не устанавливался.

| Проверка | Результат |
|---|---|
| Backend real Git: mutation 19 + queue 4 | **23 passed / 2 files** |
| Broad regression batch (backend stage 3 + IPC + RPC + renderer) | **252 passed / 22 files**, 51.25 s |
| Stage-3 regression suite (11 files) | **141 passed** |
| Renderer mutation client (`runtime-git-client.test.ts`) | **28 passed** (включая 3 новых mutation-теста) |
| Новые UI-тесты `workspace-changes.test.tsx` | **5 passed** |
| Web TypeScript (`config/tsconfig.web.json --noEmit --composite false`) | exit 0 |
| Node TypeScript (`config/tsconfig.node.json --noEmit --composite false`), фильтр по stage-4 файлам | ошибок нет; полный проект содержит прежние ошибки вне stage-4 файлов |
| RPC catalog `generate-rpc-params-catalog.mjs --check` | exit 0 |
| Targeted oxlint по новым/изменённым файлам | exit 0 |
| Electron-vite build `--mode e2e`, `VITE_EXPOSE_STORE=true` | exit 0; **176 chunks, 6061.4 KB** |
| Настоящий Electron: stage-4 + diff/popup/catalog/golden | **5 passed**, прогон дважды (1.4 m каждый), hidden window |

Команды:

```sh
npm exec --yes --package=node@24.22.1 -- node node_modules/vitest/vitest.mjs run \
  --config config/vitest.config.ts src/main/git/source-control/git-workspace-mutation-real-git.test.ts \
  src/main/git/source-control/git-mutation-queue.test.ts
npm exec --yes --package=node@24.22.1 -- node node_modules/typescript/bin/tsc \
  --project config/tsconfig.web.json --noEmit --composite false
env VITE_EXPOSE_STORE=true ORCA_SKIP_DEV_CLI_PREPARE=1 ORCA_SKIP_DEV_ELECTRON_APP_PREPARE=1 \
  npm exec --yes --package=node@24.22.1 -- node config/scripts/run-electron-vite-build.mjs --mode e2e
env ORCA_BACKGROUND_LAUNCH=1 ORCA_E2E_HEADLESS=1 ORCA_DISABLE_MACOS_LOGIN_SHELL=1 \
  ORCA_SKIP_DEV_CLI_PREPARE=1 ORCA_SKIP_DEV_ELECTRON_APP_PREPARE=1 \
  npm exec --yes --package=node@24.22.1 -- node node_modules/@playwright/test/cli.js test \
  --config .cache/stage4-playwright.config.ts --project electron-headless
```

Временный Playwright config выбирал пять постоянных spec и отключал stock global setup/teardown (он мог бы готовить глобальный CLI). `helpers/orca-app.ts` создавал disposable HOME/userData; завершались только собственные Electron-процессы. Временный config удалён после прогона; `test-results/` — обычный артефакт Playwright, не коммитится.

## Покрытые сценарии приёмки

Backend real Git (временные репозитории, настоящий Git):

- selective line stage в двух блоках одного файла; hunk stage; adjacent changes; отсутствие final newline; untracked file partial stage; partial stage удаления; partial unstage staged-строки;
- stale selection: тот же status-shape, изменённые байты — отказ `stale`, index не изменён;
- commit ровно реального index при staged+unstaged одном файле и соседнем грязном файле; unborn HEAD; detached HEAD;
- занятый `.git/index.lock` → `busy`, index не изменён;
- failing pre-commit hook → `hook` с текстом, HEAD не сдвинут, свежий expectedState; hook, stage-ящий файл, не скрыт;
- signing failure (`commit.gpgsign=true`, `gpg.program=/bin/false`) → `signing`;
- discard: external write после preview → `stale`; успешный discard + recovery + list + restore; отказ для untracked; отказ при недоступной recovery-директории (`orca-recovery` — обычный файл);
- gitlink: неверный OID отклонён; верный OID записан в parent index, parent HEAD и child index/HEAD/status не изменены; файловый stage submodule отклонён; parent commit фиксирует gitlink; child commit не меняет parent index;
- abort во время pre-commit hook → `unknown`, HEAD не сдвинут, `rev-list --count` = 1 (повтора нет).

Electron (root + child, настоящий Git):

- root: partial stage строки из выданного diff → `git show :file` содержит только выбранное; whole-file stage; unstage; commit только staged-набора (второй unstaged файл сохранён);
- root: Stage gitlink выбранного child OID → parent index обновлён, child index/status/HEAD неизменны; parent commit записывает gitlink;
- child: partial stage + whole-file stage + commit через context panel; parent index/HEAD не изменяются; staged preview показывает branch и staged-файлы;
- child: discard с preview/confirm, recovery notice, Restore copy возвращает прежнее содержимое;
- соседние golden/popup/catalog/diff spec прошли в тех же двух прогонах; окно hidden.

## Найденные регрессии и пределы

- Первая попытка Electron показала, что notice частичного stage исчезает при remount diff-панели; проверка переведена на фактический staged-region и Git-состояние.
- Каталог не обновлялся вовремя при быстрых последовательных мутациях: общий generation-guard с одним retry после abort заменил прежнюю отмену каждой итерации. После изменения два полных Electron-прогона стабильны.
- `Branch main` в preview приходил как `refs/heads/main`; preview нормализует отображаемое имя (read model не менялся).
- Проверка queue выявила инверсию порядка при конкурентном разрешении ключа; acquisition теперь сериализован, тест повторён 3×.
- Partial staging намеренно не предлагает одиночную сторону замены/newline-блока; это ограничение семантики patch, а не скрытый отказ.
- Freshness для файлов >16 MiB опирается на filesystem identity (size/ino/mtime/ctime), а не на полный хэш.
- Root Source Control commit использует существующий per-worktree commit-контракт (через тот же сервис и очередь, без `expectedState`); дочерний commit идёт по полностью проверенному пути с previewed state. Это зафиксировано как предел, а не выдан за одинаковую семантику.
- Восстановимые копии не собираются GC автоматически и живут в per-checkout git-dir.
- Прежний `bulkDiscardChanges` (явное «discard all» в старом UI) по-прежнему может удалять untracked в своём сценарии; новый stage-4 discard этого не делает. Поведение не скрыто и не переиспользуется новым UI.
- Не проверялись SSH/WSL/Windows execution hosts, release package и настоящая сетевая потеря; локальный Electron smoke не объявляет их поддержанными.
- Полный `tsc` node/CLI содержит прежние ошибки вне stage-4 файлов (`locale-text-collators.test.ts`, `orcad-artifacts.test.ts`, `hello-orca-panel-messages.test.ts`); они не подавлялись и не ослаблялись. Полный `tsconfig.e2e.json` остаётся существующим ratcheted-не-clean проектом.

## Следующий этап

Этап 5 (история/граф) не начинался. Изменения этапов 1–4 сохранены без commit/publish.
