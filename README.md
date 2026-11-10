# 素材工场 · Material Studio

选择模板、上传图片并提交制作。Java 在后台顺序执行三个模拟步骤。浏览器可以继续使用网站，重新打开页面后仍能读取个人历史和结果。

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
3. 点「提交制作」。任务卡片出现后立即再点一次，可以看到两条独立任务。单 worker 顺序处理，后受理的任务通常先显示「等待处理」。
4. 处理中刷新网页或切到模板库再回来。历史从 Java 重新加载，未完成任务继续更新。制作成功后点击卡片封面预览结果。顶栏「我的制作」汇总所有模板的个人记录。
5. 用右上角菜单切换到「周野」，验证看不到林夏的记录。切回林夏后可以继续查看原记录。两个演示账号用户名是 `lin` 和 `zhou`，演示密码均为 `studio-demo`。

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

浏览器以林夏登录，在「沙丘日记」页或「我的制作」刷新记录即可看到三条任务。每条任务停在指定阶段并显示原因。省略 `failAt` 可走成功路径。单次请求的 `delayMs` 覆盖该任务三个阶段的耗时，允许 0 至 30000 毫秒。

调整全局耗时可修改 `.env` 中的 `SIM_CHECK_MS`、`SIM_GENERATE_MS`、`SIM_FINALIZE_MS`，然后执行 `docker compose up -d api`。新任务在受理时记录耗时配置。已受理任务继续使用自己的配置。

## 技术版本与目录

| 层 | 版本 |
| --- | --- |
| Web | Next.js 16.4.6 App Router、React 19.2.9、TypeScript 5.9.3、Node.js 22.13+、ESLint 9 |
| Java | Java 21、Spring Boot 3.5.16、MyBatis Spring Boot Starter 3.0.5、Maven 3.9.11 |
| 数据 | MySQL 8.4、Flyway（Spring Boot 依赖管理） |

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

配置中的账号和密码是公开演示值。MySQL 初始化账号密码只在全新数据卷上生效。已存在的库需在 MySQL 中更新账号后再调整服务配置。

## 接口

浏览器走同源 `/api`。写请求带 `X-Studio-Request: 1`。上传、任务、历史和结果接口还需要 Java 发出的 `STUDIO_SESSION` Cookie。

| 方法和路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/templates` | 可选 `category` | `{categories, templates}` |
| `GET /api/templates/{id}` | 模板 ID | `{id,title,category,description,coverUrl,requiredImageCount,acceptedMimeTypes,maxFileSizeBytes}` |
| `GET /api/session` | Cookie 可省略 | `{user: {username,displayName} \| null}` |
| `POST /api/session` | `{username,password}` | `{user}`，同时设置会话 Cookie |
| `POST /api/session/logout` | Cookie | `204` |
| `POST /api/assets` | Multipart `templateId`、`file` | `201 {assetId,previewUrl,contentType,byteSize}` |
| `GET /api/assets/{id}/content` | 素材 ID | 图片 |
| `POST /api/tasks` | `{templateId,assetIds,requestId,failAt?,delayMs?}` | `202` 和任务对象，`id` 即任务 ID |
| `GET /api/tasks` | 可选 `templateId` | 当前用户的任务对象数组，新任务优先 |
| `GET /api/tasks/{id}` | 任务 ID | 任务对象 |
| `GET /api/tasks/{id}/result` | 已成功任务的 ID | JPEG 图片 |

任务对象字段为 `id`、`templateId`、`templateTitle`、`status`、`stage`、`createdAt`、`completedAt`、`resultUrl`、`errorMessage`。时间以 UTC ISO 8601 返回。提交的 `requestId` 为 UUID，同一用户重复提交同一个 `requestId` 时返回原任务。成功受理一条任务后，下一次制作应使用新的 `requestId`。

Java 使用 BCrypt 校验演示账号，身份保存在短期 Servlet 会话。Cookie 设置 `HttpOnly` 和 `SameSite=Lax`。Java 使用会话用户过滤任务、素材和结果。跨账号读取资源返回 `404`，登录失效时私有接口返回 `401`。上传按模板校验格式、大小及图片内容。模拟器读取已保存的文件，上传预览同样来自服务端。

## 任务执行与前端状态

- 提交事务写入 `QUEUED` 任务及素材关联。事务完成后返回任务信息，worker 独立扫描队列并按顺序执行。
- Java 先将任务领取为 `RUNNING / CHECK_INPUTS`，检查素材可读性，然后推进到 `GENERATE`、`FINALIZE`。每次状态推进单独提交。模拟延迟、图片文件写入在事务之外。
- 结果整理将该模板预置的 JPEG 写到数据卷，再置为 `SUCCEEDED`。任何步骤失败都停止后续步骤，保留失败阶段和原因，状态为 `FAILED`。
- Web 按任务 ID 合并历史和查询结果。各任务独立轮询，进入终态后停止。请求失败保留已有任务数据并允许手动恢复查询。换账号或离开页面时取消请求和计时器。
- Java 重启后继续领取已持久化的排队任务。启动时把上次中断的处理中任务标记为失败，保留中断阶段。账号会话在 Java 重启后需要重新登录，历史数据依然保留。

## 交付状态、边界和回滚

- 已实现模板筛选、上传校验、模拟任务、失败注入、并行跟踪、刷新恢复、结果预览、身份隔离和容器配置。
- 本轮从创建空仓库到实现与本地验收约 20 分钟，含依赖下载和容器构建。
- 单 Java 实例、单 worker 串行制作。数据库写入长时间中断时，未能落库的执行状态可在 Java 重启时收敛为失败。当前版本使用预置图片演示结果，未实现实际图像合成、处理中任务断点续作或多实例协调。图片和历史保存在本地卷，未实现素材回收或历史清理。
- 部署使用验收 commit 构建镜像，保留数据库卷和图片卷，先检查数据库和 Java 健康状态，再走一次上传、提交和预览。更新前备份两类卷。回滚应用可签出上一验收 commit 后重新构建。若新版本涉及数据库迁移且旧版本不兼容，停服务后恢复同一时间点的备份再启动旧版本。
- 仓库交付时用 `git rev-parse HEAD` 取得验收 commit，并随仓库链接一同提交。压缩交付保留 CI 和锁文件，排除 `node_modules/`、`.next/`、`target/` 和本地数据。

### 本地验收记录

- 容器内完成前端 ESLint、TypeScript 类型检查、任务跟踪测试和生产构建，以及 Java 单元测试和打包。
- Compose 从新数据卷启动后，验证了分类接口、上传校验、异步受理、幂等提交、三个阶段的先后顺序、各阶段失败、结果文件读取和跨账号隔离。强制终止 Java 进程后，验证了进行中任务的中断状态及排队任务的继续执行。
- 浏览器实际操作验证了模板筛选、上传、提交、刷新恢复、结果预览和账号切换。没有做公网部署。

## AI 工作流与来源

使用 Codex 辅助实现。先按题目拆分为 Java 业务与持久化、页面状态、容器和验收，再把明确的职责边界和截图布局提供给 Codex。按模块生成并检查实现，最后通过容器构建、单元测试和接口烟测对照题目修正。一个例子是把查询异常单独存为 `queryError`，用两个并发请求的测试让一个任务返回失败、另一个查询断网，确认后者保留已知的运行阶段，并在查询恢复后只更新自己的卡片。

视觉布局参考题目截图。JPEG 封面和结果由 Python 与 Pillow 程序化绘制，随项目离线交付，未使用截图内的品牌和素材。工程采用 Next.js、Spring Boot、MyBatis 等开源依赖，未复制第三方业务代码。Maven Wrapper 脚本取自 Apache Maven Wrapper 3.3.4 的 only-script 模板。
