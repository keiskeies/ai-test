# 2026-11-21：把真凭据清出仓库（发布前的一刀）

日期 2026-11-21。触发点是业主一句话：「将当前的代码都提交推送」。
提交那半边的常规流程里翻出两件事，都需要业主裁，裁完才有这篇。

取证脚本与日志都在 `.tmp/scrub/`（gitignore，**不在版本库里**）；
凡是要算证据的读数，一律抄进本文件 —— 按「只有 git 是证据」的口径，
一份没抄进版本库的变异表等于没跑过。

---

## 一、两件事实，都不是我推出来的，是量出来的

**① 远程仓库从来没被这个克隆配置过。** 业主以为它"没了"。四条证据：
`.git/config` 里没有任何 `[remote]` 段（mtime 停在 11-16）、`.git/refs/` 下只有 `heads/` 与 `tags/`
（**fetch 过一次就会长出 `refs/remotes/`**）、`logs/refs/` 下同样只有 `heads/`、
全量 reflog 里 `origin|fetch|push` 的 2 条命中全是**提交说明里的字面词**（"screenshots fetch with auth"、
"push-pull"）。同级目录的 `ai-db`/`ai-gateway`/`kbook`/`opc` 全都配了同名远程 ⇒ **ai-test 是唯一的例外**，
所以那个预期完全合理。

**② `keiskeies/ai-test` 的 `master` 是另一代产物，与本地 `main` 无共同祖先。**
`git merge-base main FETCH_HEAD` 为空；`rev-list --left-right --count` = `457 / 114`；
远端顶层是 `packages/ tooling/ package.json`（TS 单仓，描述「测试领域的 Claude Code」）。
⇒ 推 `main` 不会碰到 `master`，但「顶成 master」等于那 114 条对外消失（已先存成本地 bundle，见 §五）。

**③ 仓库是 public（`api.github.com` 回 `"private": false`），而 HEAD 里有真凭据。**
这是这一刀的全部理由。

## 二、凭据普查（**含一次我自己把仪器用坏了的记录**）

第一遍我用 `grep -acE 'sk-[A-Za-z0-9]\{16,\}'` 扫全历史，**七种形状全部报 0**，
读起来像"仓库很干净"。错的不是仓库，是命令：`\{` 是 BRE 的量词，在 `-E` 下是**字面花括号**，
于是七个模式没有一个在数任何东西。改成正确的 ERE 之后命中非零，我才去按路径分诊。
（本仓第 5 次「仪器坏了、读数却像好消息」。校准方法：同一个管道里放一条**已知存在**的串，
它必须报已知的次数 —— `calib` 那行报 64，管道才算活着。）

按 ref 分开数之后：

| 形状 | `main` 历史 | 说明 |
|---|---|---|
| `mysql+asyncmy://root:<真口令>@db.internal.test` | **64 处 / 13 条提交** | 唯一真正的泄漏面，首现 `0d817e3`（11-14） |
| `redis://:<口令>@db.internal.test:16379` | 33 处 | 同一台机器的第二个服务 |
| `sk-*` / `AKIA*` / JWT / `PRIVATE KEY` | **0** | 非零的那些全部在 `packages/`、`tooling/` 下 —— 那是**旧那代 TS 项目**的测试夹具，被 `--all` 扫进来了，不在 `main` 上 |

**远端从来没含过这两条串**（`git rev-list --objects refs/remotes/backup/old-master | cat-file --batch | grep -c` = 0）。
⇒ 改写历史是**防止外泄**，不是**事后回收**：只要未改写的那份历史没被推上去，就没有已经发生的外泄。

HEAD 里凭据的形状（清退前）：MySQL 串 **10 个文件**、Redis 串**另外 10 个**（有重叠），
其中 7 处是「拿不到环境变量就用这个默认值」的兜底 —— `conftest.py`、
`scripts/check_migration_down.py`、`scripts/verify_worker.py`、`playwright.config.ts`、
4 个 e2e spec、`scripts/gen-api.mjs`。**同一串被抄了 7 份。**
`.env` 本体一直是 gitignore 的、`.env.example` 一直写 `CHANGE_ME` ⇒
**这个仓早就定了「口令不进代码」的规矩，只有这 7 处默认值没执行它。**

顺带量到两件没在原始问题里的事：`conftest.py` 的 `TP_BOOTSTRAP_PASSWORD` 默认值与
**业主演示机的 admin 口令逐字相同**（逐字节比过，11 字符，135 处）；
`docs/` 里另有 6 个文件写着 Redis 口令明文。演示口令这一条**没有清退**，理由见 §六。

## 三、清退的设计：删掉默认值之前，先回答「那值从哪来」

现场三个读数决定了做法：

1. **没有任何东西替 pytest 加载 `.env`** —— pydantic 的 `env_file` 只在构造 `Settings` 时读，
   而 `conftest.py` 在 import 期就把字面量写进 `os.environ`，**赢过** `.env`。
   ⇒ 直接删默认值 = 全套件红，而且红相是「没配」，和它要区分的真问题长得一样。
2. **本机 3306/6379 确实在听，但 root 口令不是任何人猜得到的**（试过 `root` / 空 / 那个弱口令，全 Access denied）。
   ⇒ 留一个 `127.0.0.1` 的假默认值会把「你没配」变成一屏 `Access denied`，**比响亮报错难查**。
3. `db.internal.test` **不是这台机器**（本机 `192.168.1.10`）⇒ 那是一台真实内网机的 root 口令，
   这正是不能公开的硬理由（业主 2026-11-19 已定过「测试都跑本机，不再用远端 db.internal.test」，但 `.env` 仍指向它）。

**落地的口径**（两侧同构，都是「进程环境 → `backend/.env` → 响亮报错」）：

- `backend/app/shared/localenv.py`（新）：`require_env("TP_DB_URL")`。
  自己写 20 行解析而不是用 python-dotenv —— 那包是 pydantic-settings 的**传递依赖**，
  本仓没在 pyproject 里声明它（§13 纪律 2 同口径）。
- `web/e2e/dbEnv.mjs`（新）：`process.loadEnvFile`（Node 内置，20.12+；CI 用 22）+ 同一优先级。
  web 侧「前端零新依赖」是既有纪律，不为读一个 `.env` 引 `dotenv`。
  **e2e 串从 `TP_DB_URL` 换库名派生**，因为这正是那 7 处字面量当年的行为；显式 `TP_E2E_REDIS_URL`/`TP_E2E_DB_URL` 仍优先。
- **占位符等于没配**：值还是 `CHANGE_ME` 时按「没配」报错，否则照抄 `.env.example` 没改的人会拿 `CHANGE_ME` 去连库。
- **CI 不受影响**（现查）：pytest job 在 job 级给了 `TP_DB_URL`/`TP_REDIS_URL`（`ci.yml:26-27`），
  e2e job 给了 `TP_E2E_*`（`ci.yml:113-116`）⇒ 删掉的兜底 CI 从来没用过。

### 写的时候自己踩的三个坑（都是当场实测发现的，不是事后补的）

1. **`withSchema` 第一版会把含 `/` 的口令切坏**：`indexOf("/", indexOf("//")+2)` 还是从左找斜杠，
   `root:p@ss/w:ord@h:3306/testpilot` 变成 `root:p@ss/testpilot_e2e` —— host 整个没了，
   而且结果仍以 `mysql+asyncmy://` 开头，**类型检查都不报**。改成先定 authority 的右端
   （query 前最后一个 `@`）再找路径斜杠。七种形状手测过（vitest 的 include 只收 `src/**/*.test.*`，
   e2e 目录立测试收不到 ⇒ 那会是第二条装饰性测试，所以只在 `.tmp` 里手测并记在这里）。
2. **`test_localenv.py` 里那条「拿真 `.env` 比对 python-dotenv」的测试永远 skip**：
   第一版读 `os.environ` 判断"有没有注入"，而 `conftest.py` 在 import 期恒写这个键。
   一条永不执行的比对和没有这条比对等价，**却更糟**：它让「真 .env 被钉住了」这句话听起来成立。
   改成显式 `delenv` + 传 `path=ENV_PATH`，`-rs` 复跑确认 0 skip。
3. **字节级改写的行尾假设是错的**：我先用 `grep -c $'\r$'` 量出"这些文件全是纯 CRLF"，
   按 CRLF 写字节 ⇒ 脚本在第一条就 ABORT（命中 0 次）。真值是**磁盘上混的**：
   `conftest.py`/`helpers.mjs` 是 LF，`playwright.config.ts` 是 CRLF —— 因为 `grep -c $'\r$'`
   量的是**工作树**，而那次我把 autocrlf 的 smudge 结果当成了文件本相。
   改成按每份文件自己检测 + 两种形式都试 + **撤销替换必须逐字节回到原文**才算通过。
   （脚本第一版的"还原核对"写成了 `cur.replace(b"PLACEHOLDER", b"")` —— 永真式，一个永不命中的断言。）

## 四、守卫：`backend/tests/test_no_hardcoded_credentials.py`

清退只解决"现在没有"，解决不了"下次又贴一份"（这次它已经进了 13 条提交）。
两道规则：**已知串全仓禁**（`git ls-files` 全量，含 docs）+ **代码目录禁带口令的 URI 形状**。

- 形状规则的依据是**一条全新的凭据**：只认已知串的守卫拦不住业主换过口令之后的下一条。
- 白名单是量出来的，只有两条，逐条写理由（`config.py` 的 `root:root@127.0.0.1` 是"没配"的形状，
  实测本机连不上；`palette.spec.mjs` 那行注释里 `user:pw@host` 本身就是占位符）。
  `app/core/` 是护栏目录，所以我**没有**改它，而是登记待裁（§六）。
- **白名单自检**：登记的条目若对应的串已不在文件里就红 —— 否则白名单只会越长越像"规则其实不生效"。
- **本文件自己把禁的串拆开写**（相邻字面量拼接）。它在 `backend/tests/` 下，直写就是自己抓自己；
  用"豁免本文件"解决会留一个真洞。拆开写之后源码里不存在那段连续字节，而运行时值仍是真串。
  ⚠ 拆开写只在**已跟踪文件**上必要吗？不 —— `git ls-files` 不含未跟踪文件，
  本文件在提交前扫不到自己，提交后就扫得到。拆开写让两种状态都干净。

### 上面那条告诫写完，我还是踩了它（`test_localenv.py` 夹具，`git add` 之后才红）

`git add` 之后跑守卫，它把我**自己新写的** `test_localenv.py:48` 判成"带口令的 URI"：
夹具里的假串写成 `mysql+asyncmy://u:p@h:3306/db`，口令位是单字母 `p`，
而形状规则的占位词表收 `<...>` / `CHANGE_ME` / `pw` / `xxx`，**不收 `p`**。
改成 `u:<pw>@h` —— 改夹具，**不改守卫**、不加豁免（豁免就是我上面拒开的那个洞）。

值得记的不是这个 bug，是**它的可见性时机**：`test_no_hardcoded_credentials.py` 里我早写过
"`git ls-files` 不含未跟踪文件，提交前扫不到自己"，而 §五 那行"守卫绿"就是在**未 `git add`** 的状态下量的
⇒ 那句话我抄对了，却仍然拿了一个「仪器当时看不见两个输入」的读数当证据。
**口径要落到"量它的那次运行是什么状态"上，否则写在文档里也只是装饰。**
复跑：`pytest tests/test_no_hardcoded_credentials.py tests/test_localenv.py` ⇒ **19 passed / 0 skipped**。

⚠ 顺带一件**没结掉**的事，不当成已修：`post.log`（22:36）那次 34 passed **1 skipped**，
刚才同一文件集复跑是 **35 passed / 0 skipped** —— 那条 skip 现在复现不出来，
而**我没能定位它是哪一条**（`-rs` 现在什么都不报）。
可能是我随后改夹具时顺带消掉的，也可能是环境差异；两种都还只是猜测，故留此存目。


### 变异证明（原件 `.tmp/scrub/mut-guard.log`，2026-11-21 22:53Z）

**为什么在临时仓库跑**：变异体就是"往被跟踪的文件里贴凭据"，在共享工作树里贴，
同伴会话一次 `git add -A` 就能带进提交 —— 为了验一把锁把门打开十分钟，不划算。
**为什么变异体用合成串**（`SYNTH-MYSQL-PW-9f3a`）：真口令写进变异脚本会顺着 `tee` 进日志，
而这张表要抄进版本库 ⇒ **为验证"仓库里不该有口令"而把口令抄进仓库**。规则代码一字未动。

预期**跑之前写死**，比对「红的是哪几条 it」而不是「红没红」。

| 变异 | 预期红的 it | 实测 | 判定 |
|---|---|---|---|
| M0 基线 | GREEN（无红） | 无红 | OK |
| M1 已知串贴回脚本 | `test_tracked_code…` + `test_known_leaked…` | 同 | OK |
| M2 一条**全新**凭据（只有形状规则认得） | 仅 `test_tracked_code…` | 同 | OK |
| M3 形状正则坏成恒不匹配 | 仅 `test_positive_control…` | 同 | OK |
| M4 全部还原 | GREEN | 无红 | OK |

**5/5 符合预期**，还原后三个文件 `git status --porcelain` 全 clean。
M2 是这条守卫存在的理由（只认已知串就会漏它）；M3 证明正对照抓的是**仪器坏掉**，
不是"什么都算红"。M3 第一版写成 `re.compile(r"(?!")` —— 未闭合的组，import 期就 `re.error`，
pytest 以 collection error 退出，长得跟"守卫抓住了一切"一模一样；`(?!)`（恒假前瞻）才是对的，
先单独验证它能编译再上脚本。

## 五、闸门（每条都有日志文件 + 我从中读到的汇总行）

| 闸门 | 结果 | 日志 |
|---|---|---|
| 全量 pytest | **跑完才写，见文末补记** | `backend/.tmp/scrub/full2.log` |
| `vitest run` | `1 failed / 1850 passed`（108 文件 1851 条）· 106.99s | `web/.tmp/scrub/vitest.log` |
| `tsc -b` | exit 0 | `web/.tmp/scrub-tsc.log` |
| `eslint .` | exit 0（6 条 `exhaustive-deps` 是既有告警，都在我没碰的 `src/` 文件里） | `web/.tmp/scrub-eslint.log` |
| `ruff check app tests scripts` / `mypy app` | All checks passed / Success: 145 files | 当场读 |
| `lint-imports` | **4 kept, 0 broken** | 当场读 |
| `check_migration_down.py 0027` | OK：up/down/up 真能跑（临时库 `testpilot_downchk`，demo 库未碰） | 当场读 |
| **改写规则预演**（改写**前**） | 对 `main` 可达的 **2103 个 blob** 在内存里过一遍 `--replace-text` 规则：严格残留 **0 行**、独立成词的裸口令 **0 处**（余下 18 个文件里的 `123456` 全部量过是 `0123456789`/微秒/小数秒/假密钥的子串）；仪器校准 OK（已知串报 1）+ 正对照 **4/4** | `.tmp/scrub/precheck.log` |
| **推送通道预演**（改写**前** = 负对照） | 同一份 refs `push` 到本地裸仓（`.tmp/scrub/push-preview.sh`）后扫它的对象库：**457 条提交、凭据命中 97**，校准 1 ⇒ 这台仪器在改写**前**是响的。改写后同一脚本必须报 **0** 才允许推真远端 | 当场读 |
| 行尾 | 16 个改动文件磁盘约定 == HEAD blob 约定（`playwright.config.ts` 的 CRLF 差异是 autocrlf 的正常现象，已核 blob 真身无 CR） | 当场读 |
| `diff --numstat` | 16 个既有文件合计 `+56 −49`。**"没有整文件重写"的直接证据**：单文件最大改动是 `conftest.py` 的 `+13 −5`（全文 153 行），最大删除是 8 行（全文 267 行）—— 没有任何一个文件的删除数接近它自己的行数 | 当场读 |

vitest 那 1 条红是**既有基线**，不是这次改出来的：`emoji.redline.test.ts` 报
`pages/reportDetail.tsx U+26A0`，该字符在 `//` 注释里，而守卫的 `stripComments` 用
`/(^|\s)\/\/.*$/`（`.` 不能跨过 `\r`）⇒ 注释从没被剥掉。归因三条独立证据在
`2026-11-21-d187-defect.md` 同轮的台账里，此处不重复。

**⑦ Playwright 业主独占，本轮未跑**（`webServer` 会 `alembic upgrade head` + 占 :8321 打共享库）。
替代证据：`node --experimental-strip-types` 只 import `playwright.config.ts` 并打印 `webServer[0].env`
⇒ 确认配置**解析得出真实串**（从 `.env`），且源码里已无字面量。**不跑测试、不起服务。**

## 六、留给业主的三条——2026-11-22 已裁

三条里两条已裁并执行（2026-11-22，业主：清演示口令 + 匿名化内网主机名 + 只把本机配置留出仓库）。

1. **演示口令已清退（2026-11-22）。** 原判「清它要同时改六份手册 + 业主机 admin 口令」成立，
   这一刀就是那一刀。落点：
   - `conftest.py` 的默认值改成测试专用常量 `ADMIN_PASSWORD`（一次性临时 schema 用，
     与业主机口令**刻意不同**），11 处登录断言 `from tests.conftest import ADMIN_PASSWORD`
     引用同一处 —— 原来 11 份字面量抄本收敛成 1 个常量。
   - 六份手册不再公布口令本体，改为「= 你 §0 设的 `TP_BOOTSTRAP_PASSWORD`」；
     `README-s0-demo.md` 那句「写死了密码所以不会打印」同步翻成「留空所以会打印一次」。
   - 守卫加第三条禁串（拆开写），**负对照验过**：往手册里贴回该口令 ⇒
     `test_known_leaked_strings_are_gone_repo_wide` 红；撤掉 ⇒ 绿。
   - 读数：全仓该串命中 **0**；`pytest tests/test_auth*.py tests/test_audit*.py
     tests/test_golden_*.py tests/test_user_*.py` = **59 passed**；
     反面对照「错口令必须 401」= 1 passed（否则「登录测试过了」只说明代码接受了任意口令）。
   - ⚠ **业主机的 admin 口令本体没动**（它只在业主的 `.env` 里，本来就不在仓库）。
     仓库侧清的是「公开可猜的共享口令」这件事。
2. **`app/core/config.py:44` 的 `root:root@127.0.0.1` 留着**（守卫白名单里，带实测理由）。
   `app/core/` 是护栏目录（`git status --short -- backend/app/core/` 必须为空）。
3. **内网主机名已匿名化（2026-11-22）：业主 2026-11-19 的「计划文档照原文读、不改写」
   口径同日作废**，因为仓库要转公开，公开它 = 公开网络拓扑。落点：精确匹配
   （**不含**假 ADB 设备串号那个同网段 `.50`，它只是子串误伤）共 **35 处 / 17 个文件**
   统一换成 `db.internal.test`，含 `.env.example` 两行与守卫自己的正对照夹具。
   主机名**没有**进守卫禁串表：它是拓扑不是凭据，且子串规则会在 36 处假设备串号上误报。
   ⚠ 假 ADB 串号仍写作同网段地址（36 处），那是测试夹具不是业主资产；
   要一并换形状属下一刀。

## 七、发布（进行中，两半都不可逆，故先备份）

业主裁了两条：① 清 HEAD + 改写历史；② 把 `main` 顶成 `master`。

- 备份：`D:/item/_history_rewrite_backup_20261121/ai-test-all-refs.bundle`
  （`git bundle verify` 报 complete history）+ `remote-old-master-114.bundle`
  （**顶掉远端那 114 条之前先存**，`c0ab8fd`）。
- ⚠ **改写必须在真正要推的那个仓库里做**。我最初打算在一份临时克隆里改写、保持本仓不动 ——
  那是错的：本仓 `main` 仍带着那 13 条，下次从这里一推就把清掉的东西原样推回去。
  回滚安全性来自上面的 bundle，不需要把泄漏留在原地。
- 两个 linked worktree（`ai-test-wt/wt1`、`wt2`，同一个对象库）改写时会一起动；
  两者都 clean，且 `wt/slot1|2` 是 `main` 的祖先（落后 423 条）⇒ 改写不丢它们的工作。

### 改写前的两次预演（都在一次性仓库里，合成串 `SYNTH-PW-9f3a`，脚本 `.tmp/scrub/sandbox-filter-repo.sh`）

**为什么要预演**：`filter-repo` 是对整个对象库动刀，而本仓带着**同伴会话正在用的两个 linked worktree**。
"它大概只会改历史吧"是推理，不是证据。

量到的三件事：

1. **`refs/remotes/backup/old-master` 原样存活**（改写前后同哈希）⇒ 我在仓库内的 114 条备份不会被带走。
   4 个 tag 也存活（哈希变）。
2. ⚠ **已签出的 linked worktree 会变成"全是已暂存改动"**：`filter-repo` 只重写提交对象，
   **不动 worktree 的索引与工作树** ⇒ 索引仍记旧 blob、磁盘仍是旧文本，相对新 HEAD 全显示为 `M `（暂存态）。
   本仓 `wt/slot1`/`wt/slot2` 会在 **5 个文件**上出现这个状态（逐条量过：
   `backend/tests/conftest.py`、`web/playwright.config.ts`、`web/scripts/gen-api.mjs`、
   `docs/superpowers/plans/2026-11-15-1a-api-assets.md`、`docs/superpowers/plans/README-s0-demo.md`），
   **磁盘上仍是旧口令**。
   我**没有**替同伴会话清它：那是别人的工作树，且业主禁 `git reset` / `git checkout --`。
   要清就一条（`restore` 不在禁列，且 `--source=HEAD` 明确写从哪取）：
   `git -C D:/item/ai-test-wt/wt1 restore --source=HEAD --staged --worktree -- backend/tests/conftest.py web/playwright.config.ts web/scripts/gen-api.mjs docs/superpowers/plans/2026-11-15-1a-api-assets.md docs/superpowers/plans/README-s0-demo.md`
   兜底在守卫：若有人把旧文本再提交一次，`test_no_hardcoded_credentials.py` 会当场红。
3. 预演脚本自己有两处仪器 bug，当场抓到：`git filter-repo` 在本机**不是子命令**
   （真身 `python -m git_filter_repo`）⇒ 第一版什么都没改写而"一切完好无损"，整场预演测的是空气；
   而 `echo $?` 取的是管道尾 `sed` 的 0 ⇒ 退出码假绿。**本仓第 6 次「仪器坏了、读数却像好消息」。**

