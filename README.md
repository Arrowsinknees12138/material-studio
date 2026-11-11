# 素材工场 · Material Studio

选择模板、上传图片并提交制作。Java 在后台为每条任务按顺序执行三个模拟步骤。浏览器可以继续使用网站，重新打开页面后仍能读取个人历史和结果。

## 一键启动

需要 Docker Desktop 或 Docker Engine 与 Compose v2。在项目根目录执行：

```bash
docker compose up --build -d --wait
docker compose ps
```

打开 [http://localhost:3000](http://localhost:3000)。默认配置可直接运行，也可以把 `.env.example` 复制为 `.env` 后调整端口或模拟耗时。Compose 只把 Web 端口映射到本机回环地址。

| 服务 | 连接方式 |
| --- | --- |
| Web | 浏览器访问 `http://localhost:3000`。Next.js 把同源 API 和图片请求转发给 Java。 |
| Java | Compose 网络内使用 `http://api:8080`。Java 提供模板、会话、素材、任务、结果接口。 |
| MySQL | Java 使用 `jdbc:mysql://db:3306/material_studio`。启动时 Flyway 自动建表并插入种子。 |

停止服务使用 `docker compose down`。数据库和图片文件保留在 `database` 和 `files` 命名卷中。

## 快速验收

1. 打开模板库，切换「旅行风景」和「创意合成」。进入「海岸明信片」可以看到两个上传位，「沙丘日记」只有一个。
2. 在制作页选择「使用林夏」。从 `backend/src/main/resources/static/demo/` 选择任意两张封面 JPEG，上传到「海岸明信片」。也可用自己的 JPEG 或 PNG。
3. 点「提交制作」。任务卡片出现后立即再点一次，可以看到两条独立任务。两条任务分别从「等待处理」进入各自的制作阶段。
4. 处理中刷新网页或切到模板库再回来。历史从 Java 重新加载，未完成任务继续更新。制作成功后点击卡片封面预览结果。模板库的「制作记录」和账户设置的「我的制作」都可打开个人历史。
5. 打开右上角「账户设置」，选择「切换账号」并切换到「周野」，验证看不到林夏的记录。切回林夏后可以继续查看原记录。两个演示账号用户名是 `lin` 和 `zhou`，演示密码均为 `studio-demo`。
6. 退出演示账号，点右上角「登录 / 注册」，选择「注册账号」。填写自选用户名、显示名称和密码，注册成功即登录。提交一条任务并打开「我的制作」，然后退出并重新用该用户名和密码登录，确认历史仍可访问。切换到其他账号时，个人历史里不会出现该任务。

### 模拟指定阶段失败

Compose 默认开启 `SIMULATION_ENABLED`。在 Bash 中从项目根目录运行下面的命令。示例使用 `curl` 和 `jq`，如无 `jq`，可从上传返回的 JSON 手动复制 `assetId`。若修改了 `WEB_PORT`，同时调整 `BASE`。

```bash
BASE=http://localhost:3000
COOKIE=$(mktemp)
trap 'rm -f "$COOKIE"' EXIT
curl -fsS -c "$COOKIE" -H 'X-Studio-Request: 1' -H 'Content-Type: application/json' \
  --data '{"username":"lin","password":"studio-demo"}' "$BASE/api/session"

ASSET_ID=$(curl -fsS -b "$COOKIE" -H 'X-Studio-Request: 1' \
  -F 'templateId=desert' -F 'file=@backend/src/main/resources/static/demo/desert.jpg' \
  "$BASE/api/assets" | jq -r .assetId)

for STAGE in CHECK_INPUTS GENERATE FINALIZE; do
  REQUEST_ID=$(docker compose exec -T web node -p 'crypto.randomUUID()')
  curl -fsS -b "$COOKIE" -H 'X-Studio-Request: 1' -H 'Content-Type: application/json' \
    --data "{\"templateId\":\"desert\",\"assetIds\":[\"$ASSET_ID\"],\"requestId\":\"$REQUEST_ID\",\"failAt\":\"$STAGE\",\"delayMs\":2000}" \
    "$BASE/api/tasks"
  printf '\n'
done
curl -fsS -b "$COOKIE" "$BASE/api/tasks?templateId=desert"
```

浏览器以林夏登录，在「沙丘日记」页或「我的制作」刷新记录即可看到三条任务。每条任务停在指定阶段并显示原因。省略 `failAt` 可走成功路径。传入时使用字符串阶段名 `CHECK_INPUTS`、`GENERATE` 或 `FINALIZE`。单次请求的 `delayMs` 覆盖该任务三个阶段的耗时，接受 0 至 30000 的 JSON 整数。参数类型或取值错误时返回 `400`。

调整全局耗时可修改 `.env` 中的 `SIM_CHECK_MS`、`SIM_GENERATE_MS`、`SIM_FINALIZE_MS`，然后执行 `docker compose up -d api`。新任务在受理时记录耗时配置。已受理任务继续使用自己的配置。

## 技术版本与目录

| 层 | 版本 |
| --- | --- |
| Web | Next.js 16.4.6 App Router、React 19.2.9、Material UI 9.5.0、TypeScript 5.9.3、Node.js 22.13+、ESLint 9 |
| Java | Java 21、Spring Boot 3.5.16、MyBatis Spring Boot Starter 3.0.5、Maven 3.9.11 |
| 数据 | MySQL 8.4、Flyway 和 Spring Session JDBC（Spring Boot 依赖管理） |

- `frontend/app/` 包含模板库、制作页、个人历史和同源代理。组件负责上传交互、身份和任务展示，`lib/task-feed.ts` 管理任务查询。
- `backend/src/main/java/studio/material/` 包含账号、模板、文件、任务和 Java worker。MyBatis 注解 SQL 与对应业务放在一起。
- `backend/src/main/resources/db/migration/` 包含 MySQL 结构和种子数据。示例封面、结果图位于 `backend/src/main/resources/static/demo/`。
- `.github/workflows/ci.yml` 在 push 或 pull request 时运行检查。前端依赖由 `frontend/package-lock.json` 锁定，后端依赖版本及 BOM 在 `backend/pom.xml`，Maven Wrapper 固定 Maven 版本。

### 构建、测试与独立启动

```bash
cd frontend
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run dev
```

```bash
cd backend
./mvnw verify
./mvnw spring-boot:run
# Windows 对应命令：.\mvnw.cmd verify 和 .\mvnw.cmd spring-boot:run
```

独立启动时先准备 MySQL 8.4，创建 `material_studio` 数据库并向连接账号授权。Flyway 启动时执行迁移。Java 默认监听 8080，Next.js 默认监听 3000，`JAVA_API_BASE_URL` 默认指向 `http://127.0.0.1:8080`。独立运行 Java 时，`SIMULATION_ENABLED=true` 启用模拟控制字段。

### 测试覆盖

- `backend/src/test/java/studio/material/` 通过 `./mvnw verify` 运行 JUnit 和 MockMvc。覆盖阶段顺序、指定阶段失败中断、任务提交与幂等分支、历史游标与批量查询、会话隔离、真实图片校验和文件写入失败后的回滚。单测使用模拟 Mapper 和临时目录。
- `frontend/lib/*.test.ts` 通过 `npm test` 运行 Vitest。覆盖多任务更新、查询异常与制作失败的区分、终态防回退、请求取消、代理接口和上传文件识别。异步竞争用例用虚拟时钟和手动完成的 Promise 控制响应顺序。
- `tests/smoke/` 通过 Compose 验证真实 MySQL 和 Chromium 下的业务流程，运行方法见下方的「Compose 回归」。

### 配置

| 变量 | 示例或默认值 |
| --- | --- |
| `WEB_PORT` | `3000`，Compose 映射端口 |
| `JAVA_API_BASE_URL` | Compose 内 `http://api:8080`，开发环境 `http://127.0.0.1:8080` |
| `DATABASE_URL` | `jdbc:mysql://localhost:3306/material_studio?connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true` |
| `DATABASE_USER` / `DATABASE_PASSWORD` | `studio` / `studio-local` |
| `MYSQL_ROOT_PASSWORD` | `root-local`，仅用于 Compose 初始化 |
| `STORAGE_PATH` | 本地 `./data`，容器 `/app/data` |
| `SIMULATION_ENABLED` | Compose 默认 `true`，独立 Java 默认 `false` |
| `SIM_CHECK_MS` / `SIM_GENERATE_MS` / `SIM_FINALIZE_MS` | `2000` / `5000` / `2000` |
| `WORKER_DELAY_MS` | `400`，Java worker 两次扫描之间的等待 |
| `SESSION_COOKIE_SECURE` | 本地 HTTP 默认 `false`，通过 HTTPS 访问时设为 `true` |
| `ASSET_RETENTION_SECONDS` | `86400`，未关联任务的素材保留时长，必须为正整数 |
| `ASSET_CLEANUP_INTERVAL_MS` | `60000`，未引用素材扫描间隔 |

配置中的账号和密码是公开演示值。MySQL 初始化账号密码只在全新数据卷上生效。已存在的库需在 MySQL 中更新账号后再调整服务配置。

## 接口

浏览器走同源 `/api`。写请求带 `X-Studio-Request: 1`。上传、任务、历史和结果接口还需要 Java 发出的 `STUDIO_SESSION` Cookie。

| 方法和路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/templates` | 可选 `category` | `{categories, templates}` |
| `GET /api/templates/{id}` | 模板 ID | `{id,title,category,description,coverUrl,requiredImageCount,acceptedMimeTypes,maxFileSizeBytes,maxImagePixels}` |
| `GET /api/session` | Cookie 可省略 | `{user: {username,displayName} \| null}` |
| `POST /api/session` | `{username,password}` | `{user}`，同时设置会话 Cookie |
| `POST /api/session/register` | `{username,displayName,password}` | `201 {user}`，同时设置会话 Cookie。格式无效返回 `400`，用户名已存在返回 `409` |
| `POST /api/session/logout` | Cookie | `204` |
| `POST /api/assets` | Multipart `templateId`、`file` | `201 {assetId,previewUrl,contentType,byteSize}` |
| `GET /api/assets/{id}/content` | 素材 ID | 图片 |
| `POST /api/tasks` | `{templateId,assetIds,requestId,failAt?,delayMs?}` | `202` 和任务对象，`id` 即任务 ID |
| `GET /api/tasks` | 可选 `templateId` | 兼容接口，返回当前用户的任务数组 |
| `GET /api/tasks/history` | 可选 `templateId`、`active`、`cursor` 和 `limit`（默认 20，最多 50） | `{items,nextCursor}`，新任务优先 |
| `GET /api/tasks/updates` | `ids` 为逗号分隔的任务 ID，最多 50 个 | 当前用户可访问的任务数组 |
| `GET /api/tasks/{id}` | 任务 ID | 任务对象 |
| `GET /api/tasks/{id}/result` | 已成功任务的 ID | JPEG 图片 |

任务对象字段为 `id`、`templateId`、`templateTitle`、`status`、`stage`、`createdAt`、`completedAt`、`resultUrl`、`errorMessage`。时间以 UTC ISO 8601 返回。提交的 `requestId` 为 UUID，同一用户重复提交同一个 `requestId` 时返回原任务。成功受理一条任务后，下一次制作应使用新的 `requestId`。

### 账号与个人记录

用户自行注册用户名、显示名称和密码。用户名使用 3 至 40 位英文字母、数字、下划线或连字符，以英文字母或数字开头。Java 去除首尾空白并统一转为小写，再由 MySQL 唯一索引约束。显示名称为 1 至 80 个 Unicode 码点。密码至少 8 个 Unicode 码点，UTF-8 编码最多 72 字节，MySQL 的 `users` 表仅保存 BCrypt 哈希。

注册、登录或切换账号成功时，Java 轮换会话 ID。Spring Session JDBC 在 MySQL 保存会话，浏览器使用 `HttpOnly` 和 `SameSite=Lax` 的 Cookie。上传和任务使用会话中的用户 ID 标记归属。个人历史、单条任务及图片读取均由 Java 按归属查询。退出登录会注销会话，任务和结果仍保存在该用户下。退出响应丢失或发生服务端异常时，页面暂时隐藏个人记录并重新确认会话。跨标签页切换账号时，页面清理旧记录并重新读取会话。私有请求附上当前页面的用户名，Java 据此拒绝切换前发出的过时请求。跨账号读取资源返回 `404`，登录失效时私有接口返回 `401`。

演示账号是公开种子账号，适合验收流程。请用自建账号保存自己的制作记录。

### 图片和预览

素材失效时，提交接口通过 `unavailableAssetIds` 标明需要重传的槽位。浏览器按文件头识别 JPEG 或 PNG，即使系统没有提供 MIME 也可上传。Java 按模板校验大小并解码校验内容。模拟器读取已保存的文件，上传预览同样来自服务端。

登录前即可在模板详情查看所需图片张数、支持格式、单张大小和像素上限。详情页、文件选择器和前后端格式错误提示都使用当前模板的配置。模板接口的单张大小取模板配置与 Java multipart 单文件上限的较小值。默认单文件上限为 5 MB，multipart 请求总上限为 6 MB，给表单字段留出空间。封面加载失败时可在列表卡片或详情页单独重试。通过制作页登录入口成功登录后，键盘焦点移到第一个上传按钮。

所有素材预览加载成功后可以提交制作。素材和结果预览均使用带 8 秒超时的请求，失败后可以重试。更换素材或关闭结果弹窗会取消对应请求并释放浏览器临时地址。预览接口返回 `401` 时，页面重新检查会话，确认失效后回到登录入口。会话查询临时失败时可点击「重新检查账号」。结果图片读取失败时，任务仍显示「制作成功」。缩略图在 8 秒内未加载完成时，卡片会显示「打开预览」。刷新历史或成功打开大图会重试尚未加载成功的缩略图。

## 任务执行与前端状态

- 提交事务写入 `QUEUED` 任务及素材关联。事务完成后返回任务信息，worker 独立扫描到期任务。若浏览器没有收到受理响应，在同一页面用相同素材重试会沿用原 `requestId`。刷新页面后可以在历史记录确认任务是否已受理。
- Java 将任务切换为 `RUNNING / CHECK_INPUTS`，保存该阶段的到期时间。到期后检查素材可读性，再推进到 `GENERATE`、`FINALIZE`。阶段、到期时间和生成的样图名随检查点提交。模拟延迟期间不占用线程或事务。到期后的短事务通过 `FOR UPDATE SKIP LOCKED` 锁定一条任务，在提交前完成该阶段的少量本地文件操作。
- 结果整理将该模板预置的 JPEG 写到数据卷，再置为 `SUCCEEDED`。任何步骤失败都停止后续步骤，保留失败阶段和原因，状态为 `FAILED`。
- Web 按任务 ID 合并历史和查询结果。历史每页加载 20 条，分页请求使用服务端返回的游标，格式无效或越界时返回 `400`。刷新后如果首屏已完全换成新记录，「加载更多」会从新首屏继续补齐中间的记录。自动刷新首屏时会保留较早页的失败提示和重试入口。其他标签页成功提交任务或窗口重新聚焦时，会按当前会话重新读取历史和活跃任务。活跃任务独立发现，即使尚未翻到对应记录也会跟踪。每次最多合并 50 个任务 ID，进入终态后停止跟踪。读取请求超过 8 秒会取消本次请求，并显示可重试的查询错误。轮询期间点击「重新查询」，会在当前查询结束后补查该任务。已有任务状态保留，其他任务继续更新。换账号或离开页面时取消请求和计时器。
- Java 重启后从已提交的阶段继续。若进程在一个步骤提交前中断，其他实例或重启后的实例会重新执行该步骤。结果路径由任务 ID 确定，重复整理同一份样图时使用原子文件替换。已提交的步骤会保留，MySQL 会话在有效期内也可以继续使用。

### 多实例与断点续作

在同一台 Docker 主机上启动两个 Java 实例：

```bash
docker compose up --build -d --wait --scale api=2
docker compose ps api
```

两个实例使用同一个 MySQL 数据库和 `files` 卷。分别领取到期任务，浏览器请求可以由任一实例接收。跨主机运行需要提供所有实例可访问且支持原子文件替换的共享存储。

在本地演示环境把 `SIM_GENERATE_MS` 设为 `15000` 并启动服务，提交任务并等到「模拟生成」。执行 `docker compose kill -s SIGKILL api`，再执行 `docker compose up -d --wait --scale api=2`。恢复查询后，原任务从保存的阶段继续，并使用原任务 ID 返回结果。

### 未引用素材清理

默认每分钟扫描一次，保留未关联任务的上传 24 小时。清理先在数据库中标记为待删，提交后删除图片和上传临时文件，最后删除素材记录。文件删除失败时保留待删记录，下次扫描重试。提交任务时锁定所用素材，和清理相互协调。已有任务引用的素材、制作记录及结果均保留。

在临时验收环境中可把 `ASSET_RETENTION_SECONDS` 设为 `15`，`ASSET_CLEANUP_INTERVAL_MS` 设为 `1000`。上传后保持未提交，等待超过 15 秒再访问预览或提交，应得到素材已不可用的反馈。同一模板再上传一张并立即提交，任务引用的素材在超出时限后仍可读取。

## 交付状态、边界和回滚

- 已实现 MUI 模板库及制作工作台、模板筛选、上传校验、模拟任务、失败注入、并行跟踪、刷新恢复、结果预览、个人账号注册和历史隔离、容器配置。
- 首版从创建空仓库到实现与本地验收约 20 分钟，含依赖下载和容器构建。
- 补齐素材预览反馈和浏览器回归约 4 分钟。修复素材预览超时与模拟参数校验约 4 分钟。修复结果预览超时与会话失效约 5 分钟。补齐访客素材要求与格式提示约 4 分钟。均按复核、修改、容器验证及源码整理的经过时间估算，包含容器等待。
- 集中完善素材预览会话、封面重试、分类计数、参数错误、有效上传上限和登录焦点，约 6 分半钟，包含容器回归及源码整理。
- 核对 Git 交付并修复手动查询重试与历史分页边界，约 6 分钟，包含旧版复现、容器回归和提交整理。
- MUI 布局重构与个人账号注册约 16 分钟，包含对照截图、依赖安装、Java 会话接入、桌面及小屏复核和容器回归。保留已有模板素材及任务模型，使用用户名密码和现有 MySQL 表完成身份与历史归属。
- 预览重试复用原素材 ID。加载期间或失败时暂缓提交，用户仍可替换或移除图片。跨账号和提交回执丢失的回归放在现有 Chromium 烟测中，直接验证浏览器、Java 和 MySQL 之间的行为。
- 当前版本使用预置图片演示结果。阶段内发生中断时，以整阶段为单位重做。任务历史及其关联素材按原记录保留，自动清理范围是数据库中已登记且过期的未引用上传。旧版本发生进程中断时可能留下未登记文件，这些文件不在自动清理范围内。
- 已知限制涉及账号请求的响应中断。若 Java 已处理登录、切换账号或注册，而页面未收到成功响应，页面可能继续显示旧会话或提示网络错误。此时可刷新页面确认当前账号。注册后若回到登录表单，可用刚注册的账号登录。
- 部署使用验收 commit 构建镜像，保留数据库卷和图片卷，先检查数据库和 Java 健康状态，再走一次上传、提交和预览。从旧版升级时，先停止所有旧版 Java 实例，再备份两类卷并构建新版本。Flyway 自动执行尚未应用的迁移，当前到 V5，其中 V3 保存任务检查点并支持素材清理，V4 新增共享会话表，V5 新增历史查询索引。旧版内存会话需要重新登录，原任务和素材记录继续使用。若旧版与升级后的库不兼容，停服务后恢复升级前同一时间点的数据库卷和图片卷，再以旧 commit 构建并启动服务，检查原历史与结果。
- 仓库交付时用 `git rev-parse HEAD` 取得验收 commit，并随仓库链接一同提交。若评估者无法读取私有仓库，可运行 `git archive --format=zip -o ../material-studio-mui-source.zip HEAD` 交付同一提交的源码。源码包包含 CI、锁文件、迁移和示例图片。

### 本地验收记录

- 容器内完成前端 ESLint、TypeScript 类型检查、任务跟踪测试和生产构建，以及 Java 单元测试和打包。
- Compose 从新数据卷启动后，验证了分类接口、上传校验、异步受理、幂等提交、三个阶段的先后顺序、各阶段失败、结果文件读取和跨账号隔离。
- 双 Java 实例容器验证了跨实例会话和文件读取。在任务处于「模拟生成」阶段时强制终止两个实例，重启后任务从该阶段继续完成。旧版 V2 数据升到 V4 后，原历史与结果仍可读取，旧版处理中任务继续执行。另验证了素材过期清理与任务提交竞争时的数据一致性。
- 浏览器实际操作验证了模板筛选、上传、提交、刷新恢复、结果预览、个人注册和账号切换。另用桌面 1280px 和小屏 320px 复核 MUI 布局。没有做公网部署。

### Compose 回归

在 Linux、macOS Bash 4+ 或 Windows Git Bash 中运行：

```bash
bash tests/smoke/run.sh
```

GitHub Actions 的 `compose-smoke` 任务也运行这套检查。脚本使用独立 Compose 项目和临时数据卷，测试结束后清理这些资源。Chromium 在 320px 视口验证访客素材要求、有效上传上限、PNG 格式校验、登录后的键盘焦点、上传竞争、两种私有预览的超时和会话失效、账号切换和失效素材槽位。在桌面视口验证六列目录、双栏工作台、个人注册、账户设置、分类失败反馈、封面重试、幂等提交、查询恢复、刷新续跟、关页续作和历史分页。服务端烟测验证上传限制、缺失文件和错误参数、并发幂等、三阶段定点失败、注册冲突、退出后重新登录、个人历史和结果隔离、Java 和 MySQL 恢复及素材清理。

## AI 工作流与来源

使用 Codex 辅助实现。先按题目拆分为 Java 业务与持久化、页面状态、容器和验收，再把明确的职责边界和截图布局提供给 Codex。按模块生成并检查实现，最后通过容器构建、单元测试和接口烟测对照题目修正。一个例子是把查询异常单独存为 `queryError`。分批轮询测试模拟一批查询断网、另一批返回制作失败，验证断网批次的任务保留已有状态，查询恢复后仅更新受影响的任务。 [对应测试](frontend/lib/task-feed.test.ts#L81)

视觉布局参考题目截图，使用 MUI 主题、组件和图标构建模板库、制作页、历史页及账户设置。App Router 的样式注入使用官方集成。 [Material UI 的 Next.js 集成](https://mui.com/material-ui/integrations/nextjs/)

JPEG 封面和结果由 Python 与 Pillow 程序化绘制，随项目离线交付。工程采用 Next.js、Spring Boot、MyBatis 等开源依赖。Compose 回归使用 Playwright 安装并运行 Chromium。Maven Wrapper 脚本取自 Apache Maven Wrapper 3.3.4 的 only-script 模板。共享会话迁移遵循官方表结构。 [Spring Session JDBC 的 MySQL 表结构](https://docs.spring.io/spring-session/reference/configuration/jdbc.html)
