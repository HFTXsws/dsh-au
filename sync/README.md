# 服务与插件接入

一句话：**云端只放定义，本机事实进备份，本机只记「用哪一份」；面板显示什么，全看 JSON。**

## 同步目录在哪

默认使用**本插件自带的 `sync/`**（开源仓里的示例账本，不含私人机器绑定）。

若要跨电脑同步自己的服务、云插件快照和机器备份，在工作台设置里填写 **私人同步仓库路径 (`syncRepoRoot`)**，或设置环境变量 `DSH_AU_SYNC_REPO`。插件会改用该仓库里的同步目录：

- 优先 `<syncRepoRoot>/dsh-sync/`
- 否则旧布局 `<syncRepoRoot>/dsh-au/sync/`

未配置私人仓库时，本机绑定、插件快照和开关文件**不会写入**插件自带的 `sync/`，避免把私人路径提交进开源仓。下文路径都相对于「当前正在使用的那份 `sync/`」。

## 四层真相

```text
sync/
├─ cloud/manifest.cloud.json      云服务定义：services + devices + plugins
├─ machines/<machineId>.json      云备份：一台电脑一份本机绑定
├─ plugins/<包名 slug>/           插件配置快照：plugin.json + config.yml + README.md
└─ local/                         已被 .gitignore 忽略
   ├─ active.json                 本机指针：当前用哪一份云备份（只写 machineId）
   └─ state.json                  开关镜像：四个开关，勾一次变一次，不脏 Git
```

开源仓本身不提交 `machines/` 与 `plugins/` 里的私人文件（只保留目录占位）。把 `syncRepoRoot` 指到自己的私人仓库后，那份 `dsh-sync/` 才是你真正提交的账本。

| 放哪 | 进 Git | 放什么 |
| --- | --- | --- |
| `cloud/manifest.cloud.json` | 是（共享定义） | 服务定义、设备连接定义、插件定义（跨电脑共享） |
| `machines/<machineId>.json` | 私人仓：是；开源仓：否 | 该机路径（仓库内直接写相对路径，家目录写 `~/` 缩写，或任意绝对路径）、健康地址、启动器、`doc`、`menuFavorites`、`plugins` 名单 |
| `local/active.json` | 否 | 当前使用哪一份备份，只有 `machineId`，不含路径 |
| `local/state.json` | 否 | 本机服务四个开关的唯一来源（`enabled`、`autoStartOnBoot`、`autoStartOnDsh`、`cloud`） |
| `~/.dsh/dsh-au.config.json` | 否 | 远端密码、`syncRepoRoot` 与运行态；旧 `machineServiceProfiles` 只原样保留作回滚依据，不再参与服务判断 |

「本机服务」列表只认 `machines/<machineId>.json` 的 `services` 键：没登记的服务即使正在运行也不展示。旧名单只在首次加载时迁移一次，且只迁「绑定 JSON 里已登记、但 `state.json` 还没记录」的服务。

三层各管一件事，别混：

- **云服务**（`cloud/`）：别人也能用的定义，不含任何本机路径。
- **云备份**（`machines/`）：每台电脑的本机事实，进私人仓只做备份与换机搬运，谁也不读别人的那份。
- **本机指针**（`local/active.json`）：只回答一个问题——**这台电脑现在用哪一份**。切换只改这一个文件。

同名主机（都叫 `hostname.local`）会撞文件名，所以在面板「云备份」页确认 `machineId` 后再提交。

### 云备份里记了什么、不记什么

记：

- `services`：服务 id → 本机路径、健康地址、启动器、`doc`（不含四个开关）。
- `menuFavorites`：常用收藏的菜单序号。
- `plugins`：这台电脑接过哪些云插件，存云清单里的插件 id（如 `example-dsh-plugin`）。
- `shortcutOverrides`：设备/页面切换快捷键的本机覆盖，一机一份；同步弹窗里可单独勾选。
- `modelShortcuts`：模型快捷槽位，一机一份；同一份配置里还有触发键和启用开关。

不记：

- 四个服务开关（在 `local/state.json`）与插件启用状态（在本机 Profile / `cordis.patch.yml`）。
- 任何密码、token、cookie——写盘前统一拦截。

`plugins` 只做记录：换机时照着它知道「上一台接过哪些插件」，但仍然要手动点「同步到当前电脑」，不会自动 `npm install`。它是保存那一刻的快照，手动改 Profile 不会自动回写。

### 模型目录如何跨电脑同步

- 每台电脑的模型快捷槽位写在 `machines/<machineId>.json` 的 `modelShortcuts`，不进共享云清单。
- 若配置了私人同步仓库，工作台「官方设置」里与模型目录相关的勾选项会按**该仓库自己的清单**刷新 DSH / Codex；自动同步只更新目录，不切换当前模型、Provider 或思考强度，也不读取或写入 API Key。
- 未配置私人仓库时，只用插件自带 `sync/`，不会去猜插件的上级目录。

## 接一个新服务（3 步）

### 1. 写本机绑定

打开工作台「本机服务 → 云备份」，当前使用的那份就是 `machines/<machineId>.json`；直接改它，或按下例新增一条：

```json
{
  "schemaVersion": 2,
  "machineId": "your-machine-id",
  "displayName": "这台电脑的显示名",
  "services": {
    "my_service": {
      "name": "显示名",
      "description": "这个服务干什么，一句话中文",
      "scriptPath": "scripts/example-service.py",
      "health": "http://127.0.0.1:9001/health",
      "log": "~/Library/Logs/example-service.log",
      "doc": "docs/example-service.md"
    }
  }
}
```

- **路径写法（不限路径、不限系统）**：
  - **当前同步仓库内路径**：直接写**仓库相对路径**（如 `scripts/example-service.py`），运行时按当前仓库根目录展开（私人仓为 `syncRepoRoot`，否则为插件根目录）；
  - **项目外路径**：在家目录下写 `~/` 开头，在任意其它磁盘或目录直接写绝对路径（统一用 `/` 分隔符，如 `D:/Tools/example/app.exe` 或 `/opt/custom/run.sh`）；
  - **只要在本地绑定 JSON 里记录了合法 `scriptPath`**（支持 `.py` / `.pyw` / `.js` / `.mjs` / `.cjs` / `.ps1` / `.sh` / `.bash` / `.zsh` / `.bat` / `.cmd` / `.vbs` / `.exe` 及无后缀可执行文件），不限制脚本所在目录、不限制操作系统（Windows / macOS / Linux），插件即可直接管理其**本机启用、开机自启、随 DSH 自启、启动、重启、停止**，无需把服务 ID 硬编码进白名单。
- `doc` 写仓库相对路径（和云清单同口径）。
- 四个开关（`enabled` / `autoStartOnBoot` / `autoStartOnDsh` / `cloud`）**不写这里**，写在 `local/state.json`，面板上勾选即可。

保存后重启插件，面板就能看到，不用改代码。此时服务是「已注册 · 未启用」：能看状态，但还不能设自启。

端口每次启动都会变的服务不要依赖 JSON 里写的端口：由宿主在运行期登记真实端口（`setRuntimeServicePort`），探活以它为准；JSON 里的 `port` 只在宿主未登记时作回落值。

### 2. 在面板上开启「本机启用」或直接勾自启

1. 选中服务，可单独打开「本机启用」。
2. 已登记到本机的服务直接勾「开机自启」或「随 DSH 自启」时，会自动联动开启「本机启用」；关闭「本机启用」则会同时清除该服务的两项自启。
3. 看提示条：成功会显示「已开启…」；保存失败或启动项写入失败会显示红色原因，并记入该服务日志。

### 3.（可选）要给别人用才点「同步到云」

只想本机用就跳过这步。写进 `cloud/manifest.cloud.json`，仓库内的路径自动转成相对路径，仓库外的一律留空——别的电脑用不到你机器上的绝对路径。同一个 id 再点一次是覆盖。


## 服务字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 面板显示名 |
| `description` | 否 | 一句话中文说明，显示在详情里 |
| `scriptPath` | 看情况 | 脚本或可执行文件路径（仓库内直接写相对路径，仓库外写 `~/` 或任意绝对路径）；只要记录了可执行 `scriptPath`，即可跨平台启停与自启 |
| `control` | 否 | 可选安全限制：`full`、`start-only`（只允许启动）、`view`（仅监控）；本机与云端策略只能收紧，不能放宽内建共享依赖保护，未知值按只读处理 |
| `configPath` | 否 | 配置文件路径，仅用于诊断与展示，不读取内容，也不自动改写服务实际的配置参数 |
| `cacheDir` | 否 | 独立的缓存目录路径；调试详情与 Doctor 按目录展示、检查，不能填到 `configPath` 或 `scriptPath` |
| `stopScriptPath` | 否 | 通用脚本控制通路的独立停止入口，路径规则同 `scriptPath`；配置后停止失败绝不回退杀端口进程，重启须先成功停止。已有平台启动器仍按原通路管理 |
| `args` / `stopArgs` | 否 | 启动／停止脚本的非空字符串参数数组，分别传递，不含凭据；同步云端时整组忽略含本机绝对路径或敏感参数的数组 |
| `controlTimeoutMs` | 否 | 每个控制阶段的超时（正安全整数，毫秒），默认 6000；运行时最多按 2147483647 毫秒执行，避免 Node 超大定时器变成 1ms |
| `health` | 看情况 | 探活地址，如 `http://127.0.0.1:9001/health`；可写成数组，按顺序试 |
| `port` | 否 | 直接写端口按 TCP 连通性判断；没写就从 `health` 里取 |
| `processPattern` | 否 | 仅 macOS / Linux：无端口常驻进程的命令行特征（字面子串），用 `pgrep -f` 判断是否运行，如 `"TCP6-LISTEN:8443"`；只写本机绑定，不上云 |
| `log` | 否 | 日志路径，通常留空（日志一般在 `~/Library/Logs`） |
| `doc` | 否 | 接入文档路径，换电脑时照着它初始化；仓库内才填 |
| `launcher.label` | 否 | 可选启动器名（macOS launchd label）；未配 `launcher.label` 但有 `scriptPath` 时同样支持「启动 / 重启 / 停止」 |
| `enabled` `autoStartOnBoot` `autoStartOnDsh` `cloud` | 否 | 四个开关写在 `local/state.json`，不写这里；省略即「已注册但未启用 / 不开机自启 / 不随 DSH 启动 / 未上云」 |

## 探活怎么判

判定口径只有一条：**HTTP 有响应就算运行中**（2xx / 3xx / 4xx 都算），连不上或超时才判已停止。

- 没写 `health` 但有 `port`：按 TCP 连通性判断，不区分是谁占着端口。
- 写了 `processPattern`（macOS / Linux）：命令行含该特征的进程存在即算运行中，优先于 `health` / `port`。
- 写了 `health`：先试写的地址；连不上或超时，再在**同一 origin** 上依次试 `/__health`、`/health`、`/healthz`、`/readyz`、`/ping`。所以路径写错不会直接变成「已停止」，但会白白多花几轮探测。
- 想更稳就写数组：`"health": ["http://127.0.0.1:15722/__health", "http://127.0.0.1:15722/health"]`，按顺序试，任一有响应即算活着。

写探活地址的两个注意点：

1. **别拿业务路径当健康地址**。转发类服务的 `/health` 可能被原样转发到上游，探活变成每轮都真打一次上游请求；`/__health` 这类本地端点才是给自己用的。
2. **4xx 也算活着**。需要鉴权的服务返回 401 时仍算运行中，不会误报停止。

## 自启与跨平台控制怎么才能真生效

「开机自启」和「随 DSH 自启」是两条独立通路，注册服务时要分开确认：

| 开关 / 能力 | 生效条件 | 缺了会怎样 |
| --- | --- | --- |
| 启动 / 重启 / 停止 | 在 `machines/<machineId>.json` 记录了可执行 `scriptPath`（任意路径、任意系统），或配置了平台原生控制入口（launchd / 平台控制器 / 独立启动脚本） | 仅可查看状态，不提供启停按钮 |
| 随 DSH 自启 | 服务登记在本机绑定 JSON ＋ `state.json` 里 `autoStartOnDsh` 与 `enabled` 都为 true ＋ 服务可控 | 不启动；结果记在服务日志 |
| 开机自启（Windows / macOS / Linux 通用脚本） | 服务记录了可执行 `scriptPath`（或受平台控制器托管）＋ `enabled` 与 `autoStartOnBoot` 都为 true；Windows 写入「启动」目录 `.vbs`，macOS 切换 `launchd` 或写入用户 `LaunchAgent` `.plist`，Linux 写入 `~/.config/autostart/*.desktop` | 开关能保存，但提示「该服务没有可用的自启入口，启动项未生效」 |
| 开机自启（Windows 系统服务） | 由 Windows 服务自己的启动模式（`StartMode`）决定 | 面板只读显示 `Auto` / `Manual` / 未知，不可勾选，也不修改系统服务 |

三条硬规则：

1. **只要记录 `scriptPath` 就能跨平台纳管**。无论脚本在仓库内（直接写相对路径，如 `scripts/example-service.py`）还是仓库外任意目录（`~/...` 或绝对路径），无论在 Windows、macOS 还是 Linux，只要 `machines/<machineId>.json` 记录了可执行 `scriptPath`，插件就能直接管理其本机启用、开机自启、随 DSH 自启与启停，不需要改代码加白名单。
2. **自启项必须是 `enabled` 的子集**。所以顺序是「先开本机启用，再勾自启」；未启用时请求自启会被拒绝并提示，不会静默丢弃。
3. **两条通路都不会重复启动**。启动前先探活，已在运行就跳过（`triggerDshAutoStart` 记「均已在运行中」，`controlService('start')` 返回 `skipped`）。

### 平台控制优先级

插件对本地服务的控制按以下优先级自动选择：

- **本机绑定 `scriptPath` 通用直控**：只要在 `machines/<machineId>.json` 里登记了可执行脚本或二进制路径（`.py` / `.pyw` / `.js` / `.mjs` / `.cjs` / `.ps1` / `.sh` / `.bash` / `.zsh` / `.bat` / `.cmd` / `.vbs` / `.exe` 等），跨平台均可直接启停与自启；
- **平台原生启动器 / 控制器**：macOS 上已配置 `launcher.label` 的 LaunchAgent、Windows 上由平台控制器或独立启动脚本托管的服务。

两者都没有（例如只写了 `health` 探活地址、未写 `scriptPath`）的服务，作为纯监控条目展示，卡片上会标明「仅可查看」。

## 云清单存什么

`services`（服务定义，按 id 分条）、`devices`（设备连接定义，含各条路由）、`plugins`（插件定义，含包名、版本、来源与快照目录 `snapshot`）三类定义装在一个文件里。

| 处理方式 | 字段 |
| --- | --- |
| 原样写入 | `name` `description` `health` `port` `launcher.label` `category` `control` |
| 仓库内写相对路径，仓库外留空 | `scriptPath` `workdir` `log` `doc` |

- **不存**：密码 / token、绝对路径、运行状态、主机名。
- 设备条目只记「怎么连到那台机器」：

```json
{ "id": "example-mac", "name": "mac", "routes": [
  { "id": "r_example_tunnel", "type": "tunnel", "url": "https://dsh.example.com/", "username": "example-user" },
  { "id": "lan_example_mac", "type": "lan", "url": "http://192.0.2.38:31990/" }
] }
```

### 接一台远程设备（3 步）

1. **在远端电脑安装并开启 DSH Web 访问**：确保远端机器已运行 DSH Web 服务并安装 `dsh-au`，记录可用的局域网地址（`lan`）或公网隧道地址（`tunnel`）。
2. **登记设备路由**：在当前同步目录的 `cloud/manifest.cloud.json` 的 `devices` 数组中添加上例条目（只写连接地址和用户名，**不要写密码或 Token**）；也可在工作台「远程设备」面板中添加。
3. **本机填写远端密码并测试连通**：登录密码保存在本机 `~/.dsh/dsh-au.config.json`（不进 Git），在顶栏或工作台设备卡片中输入一次密码并切换测试即可。
   - **子路径反代提示**：如果远端 DSH 挂在 `/dsh/` 等子路径反向代理（如 Caddy / Nginx）后面，代理白名单除了放行 `/dsh-au/*`，还必须放行 `/dsh-au-todo/api`，否则远程工作区与跨设备待办会显示空白或 404。

## 插件

插件不手写 JSON：在 DSH-au「插件管理」点「同步到云」，它会写 `cloud/manifest.cloud.json` 的 `plugins` 段，并在 `plugins/<包名 slug>/` 生成三份文件。

| 文件 | 内容 |
| --- | --- |
| `plugin.json` | 包名、实际包版本（`version` / `source.ref`）、声明意图（`requestedSpec`）、`versionVerified`、启用态、`patchId`、来源、`hasConfig` 与可选 SHA256 `configHash` |
| `config.yml` | 该插件在 profile `cordis.patch.yml` 里那一个 `- id` 块；无配置时安全清理同包生成的旧快照，不恢复残留文件 |
| `README.md` | 从哪下载、同步了什么、什么没同步、换机三步 |

- **同步到当前电脑**：按来源安装、写启用态、把 `config.yml` 合并进本机同 id 块，其它条目不动。
- **配置唯一来源**：每个插件只认自己快照目录的 `plugin.json + config.yml`；预览、面板与换机恢复不再叠加第二份公共模板。声明了快照但缺失或损坏时直接拒绝，不用默认规则掩盖问题。
- **从云清单删除**：云清单条目与 `plugins/<slug>/` 目录一起清掉，本机已装插件不卸载。
- 哪台电脑启用哪些插件，只写在那台电脑的 DSH Profile（`bundles`）里。
- 版本优先读取目标 Profile 已安装包的元信息；声明范围不会冒充实际版本。旧快照没有 hash 可兼容但会提醒，缺文件、坏 JSON、hash 不符不能无声当“没配置”。
- 工作台「插件管理」与只读 Doctor 共用安装和快照核心：安装、预览和恢复都读同一份快照。
- Profile 锁保护跨进程变更，HTTP 安装在工作线程执行；配置文本恢复不表示 `node_modules` / pnpm store 完全回滚。遗留锁由只读 Doctor 报告，不自动清除。

安装、快照损坏、版本/store 不符或遗留锁：在工作台「插件管理」用只读 Doctor 检查。Windows 成功不等于 macOS/Linux 已实机验证；配置完成仍需单独验证重启加载。

## 接入本机 ≠ 上云

- **注册到本机**：写进 `machines/<machineId>.json`，服务出现在面板，但默认未启用。
- **本机启用**：只改这台电脑 `state.json` 的开关，不碰云清单；自启必须在它之后。
- **同步到云**：只往云清单写定义，不改别的电脑的开关。
- **从云清单删除**：只摘云清单条目，不停任何进程，也不把本机踢出去。

三者互相独立；凭据类字段（`password` / `token` / `secret` / `api_key` / `cookie`）任何一份文件都拒绝写入。

## 换一台电脑接入

1. 安装插件。若要跨电脑同步，再把 `syncRepoRoot` 指到含 `dsh-sync/` 的私人仓库。
2. 打开工作台，「云服务」列表来自 `cloud/manifest.cloud.json`。
3. 对需要的服务点「接入本机」，按 `doc` 装好程序。
4. 打开「本机服务 → 云备份」：
   - 老机器已经提交过 `machines/<machineId>.json`，这里能直接看到，点「切换使用」就把指针指过去；
   - 卡片上「插件 N 个」是那台电脑当时接过的云插件，右侧详情会列出包名，照着重新同步即可；
   - 新机器还没有备份，第一次保存时就地生成 `machines/<新 machineId>.json`；
   - 切到别的电脑的备份时，那些路径在本机不存在，服务显示「未安装」属正常，改成本机路径即可。
5. 切到「插件管理」，云插件列表同样来自云清单的 `plugins` 段；对要用的插件点「同步到当前电脑」：
   - 按来源安装：仓库内插件建软链，npm 插件按固定版本安装；
   - 把 `plugins/<slug>/config.yml` 合并进本机 `cordis.patch.yml` 的同 id 块，其它块不动；
   - 写进本机 Profile 的 `dependencies` 和 `bundles`，让它真的被加载。
6. 重启 DSH 生效。以后不要的插件取消勾选就行：只在本机 patch 里标成 `disabled`，不卸载，也不影响别的电脑。

## 工作台私人扩展（`extensions/`）

若需要给工作台侧边栏新增只属于你自己的私人页面（例如自定义网关与额度管理），**不要改动开源 `dsh-au` 源码**，直接在当前 `sync/extensions/<extId>/` 下新建目录即可：

- `extension.json`：声明 `id`、`title`、`order`、`iconSvg` 与前后端文件名
- `client.js`：返回 `useExtension({ id, title, active, callExt })`，输出 `{ renderCenter, renderInspector }`
- `styles.css`（可选）：自动注入工作台样式
- `server.js`（可选）：导出 `export async function handleAction({ action, body, ctx })`，通过 `/dsh-au/api` 的 `extAction` 转发调用

写完后运行 `npm run doctor -- --extensions` 自检；详细扩展契约可维护在你的私人同步仓库 `<syncRepoRoot>/docs/wiki/domain/private-extensions-contract.md`。


## 常见错误

- 服务没出现在面板 → 没写进当前电脑的 `machines/<machineId>.json`，面板只认 JSON。未配置私人仓库时，也不会往插件自带 `sync/` 写本机绑定。
- 按钮置灰点不动 → 既没在 `machines/<machineId>.json` 里写可执行的 `scriptPath`，也没有平台专用启动器。卡片上的「仅可查看：原因」或运行 `node scripts/doctor.mjs` 会给出具体原因。
- 勾了「开机自启」提示「启动项未生效」 → 服务未记录可执行 `scriptPath` 且无可用平台启动器。
- 点「开机自启」提示「请先开启本机启用」 → 服务只注册了还没启用，先开「本机启用」。
- 服务明明在跑却显示「已停止」 → 登记的端口和实际端口对不上；动态端口服务改由宿主运行期登记端口。
- 别的电脑看不到这个服务 → 忘了点「同步到云」。
- 「云备份」页看不到本机的备份 → 还没保存过本机绑定；保存一次收藏或开关就会生成。
- 切了备份后服务全变「未安装」→ 那份备份是别的电脑的，路径在本机不存在；改成本机路径（仓库内服务直接改成仓库相对路径）即可。
- 提交后同事的开关被改了 → 开关不该进 Git：确认 `local/state.json` 被忽略，`machines/*.json` 里没有 `enabled` 这类字段。
- `machines/` 里出现两份同名机器 → 两台电脑主机名相同；给 `machineId` 换成唯一值，再更新 `local/active.json`。
- 提示「未配置私人同步仓库 (syncRepoRoot)」→ 工作台设置里填写指向含 `dsh-sync/` 的私人仓库路径，或设置 `DSH_AU_SYNC_REPO`。

## 改完自检与服务管理 Doctor

> - macOS / Linux / Windows (PowerShell)
> - 在插件根目录只读检查本机已登记服务，不安装、不清锁、不启停

```bash
node scripts/doctor.mjs
```

- `node scripts/doctor.mjs`（或 `npm run doctor`）默认只读检查当前机器已登记的服务，不迁移绑定、不改配置或开关、不执行服务启停。运行位置为插件根目录，前提是已安装 Node.js。
- 路径检查包括仓库相对路径规范、脚本是否为可读的普通文件、实际运行入口能否从绝对路径或 PATH/PATHEXT 找到。原生 POSIX 程序还需执行权限；由解释器读取的脚本不要求脚本自身有执行位。不会运行解释器来检测版本或依赖包。
- `configPath` 只检查路径元数据，不读取可能含凭据的配置内容；目录误填到配置文件位置会报错，未解析占位符或缺失资源会明确提示未验证，历史分号多路径逐项检查。不要把缓存目录或配置文件填成 `scriptPath`。
- 健康状态与静态管理能力分开报告：静态检查通过不等于服务已运行，也不证明开机自启或启动/重启/停止已经实测。纯监控条目可以不填 `scriptPath`，合法的平台控制器也不要求重复填写脚本入口。
- 只有明确传入 `--service <id> --probe-lifecycle` 才会对这一个服务执行真实启停闭环；请先确认该服务允许被重启。无目标、空目标或重复目标会在读取本机状态前拒绝（退出码 2），静态配置错误也会阻止启停。自启部分只在临时目录验证启动项生成与清理，不验证真实开机自启；原生 launchd 同步会隔离跳过并标明部分验证。普通诊断发现配置错误时退出码为 1。
